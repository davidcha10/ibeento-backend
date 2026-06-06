const mongoose = require('mongoose');
const { syncZoneHierarchyByQid } = require('/Users/david/Desktop/App/backend/src/controllers/location.controller');
const { wikidataGetEntitiesRaw } = require('/Users/david/Desktop/App/backend/src/services/activity/open-source.service');
const Activity = require('/Users/david/Desktop/App/backend/src/models/Activity');
const Zone = require('/Users/david/Desktop/App/backend/src/models/Zone');

const PROD_URI = process.env.PROD_MONGODB_URI;
if (!PROD_URI) throw new Error('PROD_MONGODB_URI missing');

const TARGETS = [
  { qid: 'Q3034552', fallbackName: 'Palace of Versailles' },
  { qid: 'Q206521', fallbackName: 'Disneyland Paris' },
];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, label, max = 6) {
  let lastErr;
  for (let i = 1; i <= max; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || err);
      const is429 = /429|Too Many Requests|rate/i.test(msg);
      if (!is429 || i === max) break;
      const delay = Math.min(2000 * 2 ** (i - 1), 30000);
      console.log(`[retry] ${label} attempt ${i}/${max} failed with 429. Waiting ${delay}ms`);
      await wait(delay);
    }
  }
  throw lastErr;
}

function first(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v) return v;
  }
  return null;
}

function pickLabel(ent) {
  return first(ent?.labels, ['en', 'fr'])?.value || ent?.id;
}

function pickDescription(ent) {
  return first(ent?.descriptions, ['en', 'fr'])?.value || '';
}

function getClaimValue(ent, pid) {
  const claim = ent?.claims?.[pid]?.[0];
  return claim?.mainsnak?.datavalue?.value;
}

function parseCoords(coordValue) {
  if (!coordValue) return null;
  return {
    type: 'Point',
    coordinates: [coordValue.longitude, coordValue.latitude],
  };
}

function parseImageUrls(ent) {
  const p18 = ent?.claims?.P18 || [];
  const names = p18
    .map((c) => c?.mainsnak?.datavalue?.value)
    .filter(Boolean)
    .slice(0, 20);
  return names.map((f) => `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(f)}`);
}

async function ensureZonePathFromEntity(ent) {
  const parent = getClaimValue(ent, 'P131');
  const parentQid = parent?.id;
  if (!parentQid) return null;

  const zone = await withRetry(
    () => syncZoneHierarchyByQid(parentQid),
    `syncZoneHierarchyByQid(${parentQid})`
  );
  if (!zone?._id) return null;

  const fresh = await Zone.findById(zone._id).lean();
  const ancestors = Array.isArray(fresh?.ancestry) ? fresh.ancestry : [];
  const zonePathIds = [...ancestors, String(fresh._id)];
  return {
    zoneId: fresh._id,
    zonePathIds,
    address: fresh.label || '',
  };
}

async function upsertByQid(qid, fallbackName) {
  const entitiesMap = await withRetry(() => wikidataGetEntitiesRaw([qid]), `wikidataGetEntitiesRaw(${qid})`);
  const ent = entitiesMap?.[qid];
  if (!ent) throw new Error(`Entity not found for ${qid}`);

  const name = pickLabel(ent) || fallbackName;
  const description = pickDescription(ent);
  const coordValue = getClaimValue(ent, 'P625');
  const coords = parseCoords(coordValue);
  const websiteValue = getClaimValue(ent, 'P856');
  const website = typeof websiteValue === 'string' ? websiteValue : '';
  const media = parseImageUrls(ent);

  const zoneInfo = await ensureZonePathFromEntity(ent);
  const location = {
    ...(coords ? { geo: coords } : {}),
    ...(zoneInfo?.zoneId ? { zoneId: zoneInfo.zoneId, zonePathIds: zoneInfo.zonePathIds } : {}),
    ...(zoneInfo?.address ? { address: zoneInfo.address } : {}),
  };

  const docSet = {
    name,
    names: [name],
    description,
    type: 'place',
    location,
    media,
    active: true,
    externalRef: {
      provider: 'wikidata',
      id: qid,
      url: `https://www.wikidata.org/wiki/${qid}`,
    },
    sourceClaims: [{
      source: 'wikidata',
      confidence: 0.85,
      fields: ['name', 'description', 'location', 'media', 'externalRef'],
      accepted: true,
      acceptedAt: new Date(),
    }],
    accessHint: {
      source: 'wikidata',
      message: website ? `Official website: ${website}` : '',
      confidence: website ? 0.7 : 0.5,
    },
    audit: {
      isAudited: false,
      status: 'pending',
      notes: '',
    },
  };

  const saved = await Activity.findOneAndUpdate(
    { 'externalRef.provider': 'wikidata', 'externalRef.id': qid },
    { $set: docSet },
    { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
  );

  return {
    qid,
    id: String(saved._id),
    name: saved.name,
    zoneId: saved.location?.zoneId ? String(saved.location.zoneId) : null,
    zonePathLen: Array.isArray(saved.location?.zonePathIds) ? saved.location.zonePathIds.length : 0,
    auditStatus: saved.audit?.status,
  };
}

(async () => {
  await mongoose.connect(PROD_URI, { family: 4 });
  console.log('[mongo] connected');
  const results = [];
  for (const t of TARGETS) {
    const r = await upsertByQid(t.qid, t.fallbackName);
    results.push(r);
    console.log('[upsert]', JSON.stringify(r));
    await wait(2500);
  }
  console.log('[done]', JSON.stringify(results, null, 2));
  await mongoose.disconnect();
})().catch(async (e) => {
  console.error('[fatal]', e?.message || e);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
