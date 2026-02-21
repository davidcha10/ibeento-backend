#!/usr/bin/env node
/* eslint-disable no-console */
require('dotenv').config();
const mongoose = require('mongoose');
const Zone = require('../src/models/Zone');

const WIKIDATA_TYPE_CODE = {
  country: {
    Q6256: 'country',
    Q3624078: 'sovereign_state',
    Q3336843: 'constituent_country'
  },
  region: {
    Q35657: 'state',
    Q11828041: 'province',
    Q6465: 'department',
    Q215655: 'department',
    Q177831: 'prefecture',
    Q50337: 'prefecture',
    Q3032114: 'district',
    Q28575: 'county',
    Q320475: 'governorate',
    Q179979: 'oblast',
    Q168715: 'voivodeship',
    Q629340: 'canton',
    Q1136601: 'autonomous_community',
    Q7275: 'republic',
    Q82794: 'region',
    Q56061: 'administrative_territorial_entity'
  },
  city: {
    Q515: 'city',
    Q15284: 'municipality',
    Q2555896: 'municipality',
    Q129319205: 'special_wards',
    Q3957: 'town',
    Q532: 'village',
    Q5084: 'hamlet'
  },
  neighborhood: {
    Q123705: 'neighborhood',
    Q3257686: 'suburb',
    Q3032114: 'district',
    Q102100: 'borough',
    Q131596: 'ward',
    Q253019: 'parish',
    Q484170: 'commune',
    Q3258405: 'locality'
  }
};

const GENERIC_TYPE_CODES = new Set([
  'country',
  'region',
  'city',
  'neighborhood',
  'administrative_territorial_entity'
]);

const entityCache = new Map();
const subclassCache = new Map();

function getArg(name) {
  const entry = process.argv.find((v) => v.startsWith(`${name}=`));
  if (!entry) return null;
  return entry.slice(name.length + 1);
}

const APPLY = process.argv.includes('--apply');
const LIMIT = Number(getArg('--limit') || 0) || 0;
const ONLY_GENERIC = !process.argv.includes('--all');
const MAX_DEPTH = Number(getArg('--max-depth') || 5) || 5;

function getWikidataClaimsIds(entity, prop) {
  const claims = entity?.claims?.[prop] || [];
  return claims
    .map((c) => {
      const raw = c?.mainsnak?.datavalue?.value?.id;
      if (!raw) return null;
      const str = String(raw);
      const match = str.match(/(Q\d+)/i);
      return match ? match[1].toUpperCase() : str.toUpperCase();
    })
    .filter(Boolean);
}

async function readJsonResponse(res, label) {
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`[${label}] HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function wikidataGetEntities(ids = []) {
  const normalized = [...new Set(ids.map((v) => String(v || '').toUpperCase()).filter(Boolean))];
  const missing = normalized.filter((id) => !entityCache.has(id));
  if (missing.length) {
    const url =
      'https://www.wikidata.org/w/api.php' +
      `?action=wbgetentities&ids=${encodeURIComponent(missing.join('|'))}` +
      '&props=claims&format=json&origin=*';
    const res = await fetch(url, { headers: { 'User-Agent': 'IBeentoBackfill/1.0 (tech@ibeento.com)' } });
    const data = await readJsonResponse(res, 'wikidataGetEntities');
    const entities = data?.entities || {};
    for (const id of missing) {
      entityCache.set(id, entities[id] || null);
    }
  }

  const out = {};
  for (const id of normalized) {
    out[id] = entityCache.get(id) || null;
  }
  return out;
}

function directTypeCodeFromMaps(typeId, category) {
  if (!typeId || !category) return null;
  const byCategory = WIKIDATA_TYPE_CODE?.[category];
  if (!byCategory) return null;
  return byCategory[String(typeId).toUpperCase()] || null;
}

async function getSubclassParents(qid) {
  const key = String(qid || '').toUpperCase();
  if (!key) return [];
  if (subclassCache.has(key)) return subclassCache.get(key);
  const entities = await wikidataGetEntities([key]);
  const entity = entities?.[key];
  const parents = getWikidataClaimsIds(entity, 'P279');
  subclassCache.set(key, parents);
  return parents;
}

async function resolveTypeCodeBySubclass(typeId, category, maxDepth = 5) {
  if (!typeId || !category) return null;
  const start = String(typeId).toUpperCase();
  const visited = new Set();
  let frontier = [start];
  let depth = 0;
  const candidates = [];

  while (frontier.length && depth <= maxDepth) {
    const next = [];
    for (const id of frontier) {
      if (!id || visited.has(id)) continue;
      visited.add(id);

      const code = directTypeCodeFromMaps(id, category);
      if (code) candidates.push({ code, depth });

      const parents = await getSubclassParents(id);
      for (const p of parents) {
        if (!visited.has(p)) next.push(p);
      }
    }
    frontier = next;
    depth += 1;
  }

  if (!candidates.length) return null;
  const specific = candidates.filter((c) => !GENERIC_TYPE_CODES.has(c.code));
  const pool = specific.length ? specific : candidates;
  pool.sort((a, b) => a.depth - b.depth || a.code.localeCompare(b.code));
  return pool[0].code;
}

async function resolveBestTypeCodeForZone(zone, entity) {
  const category = String(zone.type || '').trim();
  if (!WIKIDATA_TYPE_CODE[category]) return null;

  const p31 = getWikidataClaimsIds(entity, 'P31');
  if (!p31.length) return null;

  const candidates = [];
  if (zone.typeCode) candidates.push(zone.typeCode);

  for (const typeId of p31) {
    const direct = directTypeCodeFromMaps(typeId, category);
    if (direct) candidates.push(direct);
    const subclass = await resolveTypeCodeBySubclass(typeId, category, MAX_DEPTH);
    if (subclass) candidates.push(subclass);
  }

  const unique = [...new Set(candidates.filter(Boolean))];
  if (!unique.length) return null;
  const specific = unique.find((code) => !GENERIC_TYPE_CODES.has(code));
  return specific || unique[0];
}

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/travelplanner';
  await mongoose.connect(uri);

  const filter = {
    source: 'wikidata',
    externalId: /^Q\d+$/i,
  };
  if (ONLY_GENERIC) {
    filter.$or = [{ typeCode: { $in: [...GENERIC_TYPE_CODES] } }, { typeCode: null }, { typeCode: { $exists: false } }];
  }

  let query = Zone.find(filter).select('_id name type typeCode externalId');
  if (LIMIT > 0) query = query.limit(LIMIT);
  const zones = await query.lean();

  console.log(`[zones] candidates=${zones.length} apply=${APPLY} onlyGeneric=${ONLY_GENERIC}`);
  if (!zones.length) {
    await mongoose.disconnect();
    return;
  }

  const ids = zones.map((z) => String(z.externalId).toUpperCase());
  const entities = await wikidataGetEntities(ids);

  const ops = [];
  let skippedNoEntity = 0;
  let skippedNoCandidate = 0;
  let unchanged = 0;

  for (const zone of zones) {
    const qid = String(zone.externalId || '').toUpperCase();
    const entity = entities[qid];
    if (!entity) {
      skippedNoEntity += 1;
      continue;
    }

    const nextTypeCode = await resolveBestTypeCodeForZone(zone, entity);
    if (!nextTypeCode) {
      skippedNoCandidate += 1;
      continue;
    }

    if (String(zone.typeCode || '') === String(nextTypeCode)) {
      unchanged += 1;
      continue;
    }

    ops.push({
      updateOne: {
        filter: { _id: zone._id },
        update: { $set: { typeCode: nextTypeCode } }
      }
    });
    console.log(`- ${zone.name} (${qid}) ${zone.typeCode || 'null'} -> ${nextTypeCode}`);
  }

  if (APPLY && ops.length) {
    const result = await Zone.bulkWrite(ops, { ordered: false });
    console.log(`[zones] updated=${result.modifiedCount} matched=${result.matchedCount}`);
  } else {
    console.log(`[zones] dry-run updates=${ops.length}`);
  }

  console.log(`[zones] unchanged=${unchanged} noEntity=${skippedNoEntity} noCandidate=${skippedNoCandidate}`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
