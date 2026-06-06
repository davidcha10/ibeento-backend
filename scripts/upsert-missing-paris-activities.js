#!/usr/bin/env node
/* eslint-disable no-console */
const path = require('path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const Zone = require('../src/models/Zone');
const Activity = require('../src/models/Activity');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const PROD_URI = process.env.PROD_MONGODB_URI;
if (!PROD_URI) throw new Error('Missing PROD_MONGODB_URI in backend/.env');

const TARGETS = [
  { qid: 'Q3034552', fallbackName: 'Palace of Versailles' },
  { qid: 'Q206521', fallbackName: 'Disneyland Paris' },
];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function slugify(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function withRetry(fn, label, maxAttempts = 6) {
  let lastErr;
  for (let i = 1; i <= maxAttempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || err);
      const isRetryable = /429|rate|timeout|ECONN|fetch failed|ENOTFOUND/i.test(msg);
      if (!isRetryable || i === maxAttempts) break;
      const delay = Math.min(2000 * (2 ** (i - 1)), 30000);
      console.log(`[retry] ${label} attempt ${i}/${maxAttempts} -> waiting ${delay}ms`);
      await wait(delay);
    }
  }
  throw lastErr;
}

function firstLocale(obj, locales = ['en', 'fr', 'es']) {
  for (const lc of locales) {
    const val = obj?.[lc]?.value;
    if (val) return String(val).trim();
  }
  return '';
}

async function fetchEntity(qid) {
  const id = String(qid || '').trim().toUpperCase();
  if (!/^Q\d+$/.test(id)) throw new Error(`Invalid QID: ${qid}`);
  const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&ids=${id}&props=labels|descriptions|claims`;
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Wikidata ${id} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  const entity = json?.entities?.[id];
  if (!entity) throw new Error(`No entity body for ${id}`);
  return entity;
}

function getClaimList(entity, pid) {
  const claims = entity?.claims?.[pid];
  return Array.isArray(claims) ? claims : [];
}

function getEntityIdClaim(entity, pid) {
  const claim = getClaimList(entity, pid)[0];
  return claim?.mainsnak?.datavalue?.value?.id || null;
}

function getStringClaim(entity, pid) {
  const claim = getClaimList(entity, pid)[0];
  const value = claim?.mainsnak?.datavalue?.value;
  return typeof value === 'string' ? value.trim() : '';
}

function getCoord(entity) {
  const claim = getClaimList(entity, 'P625')[0];
  const value = claim?.mainsnak?.datavalue?.value;
  if (!value || typeof value.longitude !== 'number' || typeof value.latitude !== 'number') return null;
  return { lng: value.longitude, lat: value.latitude };
}

function getCommonsImages(entity, limit = 10) {
  const out = [];
  const claims = getClaimList(entity, 'P18');
  for (const c of claims) {
    const fileName = c?.mainsnak?.datavalue?.value;
    if (!fileName) continue;
    out.push({
      url: `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(fileName)}`,
      type: 'image',
      order: out.length,
    });
    if (out.length >= limit) break;
  }
  return out;
}

async function ensureZoneChain(leafQid) {
  const visited = new Set();
  const chain = [];
  let currentQid = leafQid;

  while (currentQid && /^Q\d+$/.test(currentQid) && !visited.has(currentQid)) {
    visited.add(currentQid);
    const ent = await withRetry(() => fetchEntity(currentQid), `fetch zone ${currentQid}`);
    chain.push(ent);

    const parent = getEntityIdClaim(ent, 'P131');
    if (!parent) break;
    if (parent === currentQid) break;
    currentQid = parent;
    if (currentQid === 'Q142') {
      const franceEnt = await withRetry(() => fetchEntity('Q142'), 'fetch zone Q142');
      chain.push(franceEnt);
      break;
    }
    if (chain.length > 10) break;
  }

  const rootToLeaf = chain.reverse();
  let parentZoneId = null;
  let parentCountryId = null;
  const ancestry = [];

  for (let i = 0; i < rootToLeaf.length; i += 1) {
    const ent = rootToLeaf[i];
    const qid = String(ent.id || '').toUpperCase();
    const label = firstLocale(ent.labels) || qid;
    const slug = slugify(label) || qid.toLowerCase();
    const names = {
      en: ent?.labels?.en?.value || label,
      fr: ent?.labels?.fr?.value || undefined,
      es: ent?.labels?.es?.value || undefined,
    };
    const slugs = {
      en: slugify(names.en || label) || slug,
      fr: names.fr ? slugify(names.fr) : undefined,
      es: names.es ? slugify(names.es) : undefined,
    };
    Object.keys(names).forEach((k) => names[k] === undefined && delete names[k]);
    Object.keys(slugs).forEach((k) => slugs[k] === undefined && delete slugs[k]);

    const update = {
      name: label,
      names,
      slug,
      slugs,
      source: 'wikidata',
      externalId: qid,
      taxonomySnapshot: {
        canonicalType: 'zone',
        qid,
        wikidataName: label,
        auditStatus: 'pending',
      },
      level: i + 1,
      parentZoneId,
      parentCountryId,
      ancestry: [...ancestry],
      active: true,
    };

    const zone = await Zone.findOneAndUpdate(
      { source: 'wikidata', externalId: qid },
      { $set: update },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    if (i === 0) parentCountryId = zone._id;
    parentZoneId = zone._id;
    ancestry.push(zone._id);
  }

  const leaf = await Zone.findById(parentZoneId).lean();
  if (!leaf?._id) throw new Error(`Unable to resolve/create zone chain for ${leafQid}`);

  return {
    leafZoneId: leaf._id,
    zonePathIds: [...(Array.isArray(leaf.ancestry) ? leaf.ancestry : []), leaf._id],
    zoneName: leaf.name,
    leafExternalId: leaf.externalId,
  };
}

function buildActivityDescription(name, zoneName) {
  if (/Disneyland Paris/i.test(name)) {
    return 'Disneyland Paris is a major destination theme park resort near Paris, known for immersive attractions, family entertainment, and seasonal shows across multiple parks and themed areas.';
  }
  if (/Versailles/i.test(name)) {
    return 'The Palace of Versailles is a landmark former royal residence near Paris, famous for its grand architecture, historic state rooms, and extensive formal gardens.';
  }
  return `${name} is a notable place in ${zoneName || 'the Paris area'}, popular among travelers and visitors.`;
}

async function upsertActivity(target) {
  const ent = await withRetry(() => fetchEntity(target.qid), `fetch activity ${target.qid}`);
  const name = firstLocale(ent.labels) || target.fallbackName;
  const description = buildActivityDescription(name, 'Paris');
  const coord = getCoord(ent);
  const website = getStringClaim(ent, 'P856');
  const mediaImages = getCommonsImages(ent, 12);
  const parentAdminQid = getEntityIdClaim(ent, 'P131');
  if (!parentAdminQid) throw new Error(`No P131 found for ${target.qid}`);

  const zone = await ensureZoneChain(parentAdminQid);
  const slugBase = slugify(name) || target.qid.toLowerCase();
  const slug = `${slugBase}-${target.qid.toLowerCase()}`;

  const payload = {
    name,
    names: {
      en: ent?.labels?.en?.value || name,
      fr: ent?.labels?.fr?.value || undefined,
      es: ent?.labels?.es?.value || undefined,
    },
    slug,
    slugs: {
      en: slug,
      fr: ent?.labels?.fr?.value ? `${slugify(ent.labels.fr.value)}-${target.qid.toLowerCase()}` : undefined,
      es: ent?.labels?.es?.value ? `${slugify(ent.labels.es.value)}-${target.qid.toLowerCase()}` : undefined,
    },
    description,
    type: 'place',
    active: true,
    location: {
      primaryZoneId: zone.leafZoneId,
      zonePathIds: zone.zonePathIds,
      address: zone.zoneName,
      addressSource: 'wikidata',
      ...(coord ? { geo: { type: 'Point', coordinates: [coord.lng, coord.lat] }, geoSource: 'wikidata', geoConfidence: 'high' } : {}),
    },
    media: {
      cover: mediaImages[0]?.url || null,
      images: mediaImages,
    },
    accessHint: {
      requirement: 'unknown',
      message: website ? `Official website: ${website}` : '',
      source: 'wikidata',
      confidence: website ? 'medium' : 'low',
    },
    externalRef: {
      provider: 'wikidata',
      id: target.qid,
      url: `https://www.wikidata.org/wiki/${target.qid}`,
    },
    sourceClaims: [
      {
        source: 'wikidata',
        confidence: 0.85,
        fields: ['name', 'names', 'description', 'location', 'media', 'externalRef'],
        accepted: true,
        acceptedAt: new Date(),
      },
    ],
    audit: {
      isAudited: false,
      status: 'pending',
      notes: '',
    },
  };

  if (!payload.names.fr) delete payload.names.fr;
  if (!payload.names.es) delete payload.names.es;
  if (!payload.slugs.fr) delete payload.slugs.fr;
  if (!payload.slugs.es) delete payload.slugs.es;

  const doc = await Activity.findOneAndUpdate(
    { 'externalRef.provider': 'wikidata', 'externalRef.id': target.qid },
    { $set: payload },
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
  );

  return {
    qid: target.qid,
    activityId: String(doc._id),
    name: doc.name,
    zoneName: zone.zoneName,
    zoneExternalId: zone.leafExternalId,
    zonePathLen: Array.isArray(doc?.location?.zonePathIds) ? doc.location.zonePathIds.length : 0,
    auditStatus: doc?.audit?.status,
  };
}

async function main() {
  await mongoose.connect(PROD_URI, { family: 4 });
  console.log('[mongo] connected');

  const out = [];
  for (const target of TARGETS) {
    const result = await upsertActivity(target);
    out.push(result);
    console.log('[ok]', JSON.stringify(result));
    await wait(2000);
  }

  console.log('[done]', JSON.stringify(out, null, 2));
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('[fatal]', err?.message || err);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
