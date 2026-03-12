const mongoose = require('mongoose');
const Zone = require('../models/Zone');
const Activity = require('../models/Activity');

const EXTRA_CONNECTIONS = new Map();
const ZONES_COLLECTION = Zone.collection?.name || 'zones';
const ACTIVITIES_COLLECTION = Activity.collection?.name || 'activities';

function parseIntWithBounds(raw, fallback, min, max) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function parseBool(raw, fallback = false) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const s = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  return fallback;
}

function readSyncConfig() {
  const localUri = String(process.env.LOCAL_MONGODB_URI || '').trim();
  const prodUri = String(process.env.PROD_MONGODB_URI || '').trim();

  const enabledByFlag = !['0', 'false', 'off'].includes(
    String(process.env.ZONE_DB_SYNC_ENABLED || 'true').trim().toLowerCase()
  );
  const allowInProd =
    process.env.NODE_ENV !== 'production' ||
    ['1', 'true', 'yes', 'on'].includes(
      String(process.env.ZONE_DB_SYNC_ALLOW_IN_PROD || 'false').trim().toLowerCase()
    );

  const hasUris = !!localUri && !!prodUri;
  const enabled = enabledByFlag && allowInProd && hasUris;

  let reason = null;
  if (!enabledByFlag) reason = 'ZONE_DB_SYNC_ENABLED is disabled';
  else if (!allowInProd) reason = 'ZONE_DB_SYNC_ALLOW_IN_PROD is required in production';
  else if (!hasUris) reason = 'LOCAL_MONGODB_URI and PROD_MONGODB_URI are required';

  return {
    enabled,
    reason,
    localUri,
    prodUri,
    hasLocalUri: !!localUri,
    hasProdUri: !!prodUri,
  };
}

async function getConnectionByUri(uri) {
  if (!uri) {
    throw new Error('Mongo URI is required');
  }

  const cached = EXTRA_CONNECTIONS.get(uri);
  if (cached) return cached;

  const familyRaw = Number(process.env.ZONE_DB_SYNC_MONGO_FAMILY || process.env.ACTIVITY_DB_SYNC_MONGO_FAMILY || 4);
  const family = familyRaw === 4 || familyRaw === 6 ? familyRaw : 4;

  const conn = mongoose.createConnection(uri, {
    maxPoolSize: 8,
    serverSelectionTimeoutMS: 10000,
    family,
  });
  await conn.asPromise();
  EXTRA_CONNECTIONS.set(uri, conn);
  return conn;
}

async function getZonesCollectionByUri(uri) {
  const conn = await getConnectionByUri(uri);
  return conn.collection(ZONES_COLLECTION);
}

async function getActivitiesCollectionByUri(uri) {
  const conn = await getConnectionByUri(uri);
  return conn.collection(ACTIVITIES_COLLECTION);
}

function buildExternalKey(doc) {
  const provider = String(doc?.source || '').trim();
  const id = String(doc?.externalId || '').trim();
  if (!provider || !id) return null;
  return `${provider}::${id}`;
}

function summarizeZone(doc) {
  return {
    key: buildExternalKey(doc),
    source: doc?.source || null,
    externalId: doc?.externalId || null,
    _id: doc?._id ? String(doc._id) : null,
    name: String(doc?.name || '').trim() || 'Untitled',
    canonicalType: String(doc?.taxonomySnapshot?.canonicalType || '').trim() || null,
    updatedAt: doc?.updatedAt || null,
    active: doc?.active !== false,
  };
}

function toTimestamp(value) {
  const d = value ? new Date(value) : null;
  if (!d || Number.isNaN(d.getTime())) return 0;
  return d.getTime();
}

function dedupeStrings(values = []) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const s = String(value || '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

async function loadComparableMaps(localCol, prodCol) {
  const [localDocs, prodDocs] = await Promise.all([
    localCol.find({}).toArray(),
    prodCol.find({}).toArray(),
  ]);

  const localByKey = new Map();
  const prodByKey = new Map();

  let skippedLocalNoExternalRef = 0;
  let skippedProdNoExternalRef = 0;

  for (const doc of localDocs) {
    const key = buildExternalKey(doc);
    if (!key) {
      skippedLocalNoExternalRef += 1;
      continue;
    }
    if (!localByKey.has(key)) localByKey.set(key, doc);
  }
  for (const doc of prodDocs) {
    const key = buildExternalKey(doc);
    if (!key) {
      skippedProdNoExternalRef += 1;
      continue;
    }
    if (!prodByKey.has(key)) prodByKey.set(key, doc);
  }

  const missingInProd = [];
  const missingInLocal = [];
  const newerInLocal = [];
  const newerInProd = [];

  for (const [key, localDoc] of localByKey.entries()) {
    const prodDoc = prodByKey.get(key);
    if (!prodDoc) {
      missingInProd.push(summarizeZone(localDoc));
      continue;
    }
    const localTs = toTimestamp(localDoc?.updatedAt);
    const prodTs = toTimestamp(prodDoc?.updatedAt);
    if (localTs > prodTs) newerInLocal.push(summarizeZone(localDoc));
    else if (prodTs > localTs) newerInProd.push(summarizeZone(prodDoc));
  }

  for (const [key, prodDoc] of prodByKey.entries()) {
    if (!localByKey.has(key)) {
      missingInLocal.push(summarizeZone(prodDoc));
    }
  }

  return {
    localDocs,
    prodDocs,
    localByKey,
    prodByKey,
    skippedLocalNoExternalRef,
    skippedProdNoExternalRef,
    missingInProd,
    missingInLocal,
    newerInLocal,
    newerInProd,
  };
}

function sortSummariesByUpdatedAtDesc(rows = []) {
  return [...rows].sort((a, b) => toTimestamp(b?.updatedAt) - toTimestamp(a?.updatedAt));
}

function isQid(value) {
  return /^Q\d+$/i.test(String(value || '').trim());
}

function buildSameQidDifferentZoneIdSummary(localByKey, prodByKey, sampleLimit = 100) {
  const rows = [];

  for (const [key, localDoc] of localByKey.entries()) {
    const prodDoc = prodByKey.get(key);
    if (!prodDoc) continue;

    const qid = String(localDoc?.externalId || '').trim().toUpperCase();
    if (!isQid(qid)) continue;

    const localZoneId = localDoc?._id ? String(localDoc._id) : null;
    const prodZoneId = prodDoc?._id ? String(prodDoc._id) : null;
    if (!localZoneId || !prodZoneId) continue;
    if (localZoneId === prodZoneId) continue;

    rows.push({
      key,
      zoneQid: qid,
      local: summarizeZone(localDoc),
      prod: summarizeZone(prodDoc),
    });
  }

  return {
    total: rows.length,
    rows: rows.slice(0, Math.max(1, Math.min(sampleLimit, 500))),
  };
}

function requireEnabledSyncConfig() {
  const config = readSyncConfig();
  if (!config.enabled) {
    const err = new Error(config.reason || 'Zone sync is disabled');
    err.status = 503;
    err.code = 'ZONE_SYNC_DISABLED';
    err.meta = {
      hasLocalUri: config.hasLocalUri,
      hasProdUri: config.hasProdUri,
      reason: config.reason,
    };
    throw err;
  }
  return config;
}

function normalizeObjectIdString(value) {
  if (!value) return null;
  const raw = typeof value === 'object' ? value?._id || value?.id || value : value;
  const id = String(raw || '').trim();
  if (!id || !mongoose.Types.ObjectId.isValid(id)) return null;
  return id;
}

function toObjectIdIfValid(value) {
  const id = normalizeObjectIdString(value);
  return id ? new mongoose.Types.ObjectId(id) : null;
}

function buildZoneSyncContext(compared) {
  const localById = new Map();
  const prodById = new Map();
  const localToProdId = new Map();

  for (const doc of compared.localDocs || []) {
    const id = normalizeObjectIdString(doc?._id);
    if (!id) continue;
    localById.set(id, doc);
  }
  for (const doc of compared.prodDocs || []) {
    const id = normalizeObjectIdString(doc?._id);
    if (!id) continue;
    prodById.set(id, doc);
  }

  for (const [key, localDoc] of (compared.localByKey || new Map()).entries()) {
    const prodDoc = compared.prodByKey.get(key);
    const localId = normalizeObjectIdString(localDoc?._id);
    const prodId = normalizeObjectIdString(prodDoc?._id);
    if (!localId || !prodId) continue;
    localToProdId.set(localId, prodId);
  }

  return {
    localById,
    prodById,
    localByKey: compared.localByKey,
    prodByKey: compared.prodByKey,
    localToProdId,
  };
}

function resolveProdZoneIdFromLocalId(localIdRaw, ctx) {
  const localId = normalizeObjectIdString(localIdRaw);
  if (!localId) return null;
  if (ctx.localToProdId.has(localId)) return ctx.localToProdId.get(localId) || null;
  if (ctx.prodById.has(localId)) return localId;

  const localDoc = ctx.localById.get(localId);
  if (!localDoc) return null;
  const key = buildExternalKey(localDoc);
  if (!key) return null;
  const prodDoc = ctx.prodByKey.get(key);
  const prodId = normalizeObjectIdString(prodDoc?._id);
  if (!prodId) return null;
  ctx.localToProdId.set(localId, prodId);
  return prodId;
}

function expandKeysWithAncestors(initialKeys = [], localByKey = new Map(), localById = new Map()) {
  const out = new Set(dedupeStrings(initialKeys));
  let changed = true;

  while (changed) {
    changed = false;
    for (const key of Array.from(out.values())) {
      const doc = localByKey.get(key);
      if (!doc) continue;

      const relatedIds = [
        normalizeObjectIdString(doc?.parentZoneId),
        normalizeObjectIdString(doc?.parentCountryId),
        ...(Array.isArray(doc?.ancestry) ? doc.ancestry.map((v) => normalizeObjectIdString(v)) : []),
      ].filter(Boolean);

      for (const relatedId of relatedIds) {
        const relatedDoc = localById.get(relatedId);
        const relatedKey = buildExternalKey(relatedDoc);
        if (!relatedKey || out.has(relatedKey)) continue;
        out.add(relatedKey);
        changed = true;
      }
    }
  }

  return Array.from(out.values());
}

function sortZoneKeysByHierarchy(keys = [], localByKey = new Map()) {
  return [...keys].sort((a, b) => {
    const da = localByKey.get(a);
    const db = localByKey.get(b);
    const depthA = Array.isArray(da?.ancestry) ? da.ancestry.length : Number(da?.level || 0);
    const depthB = Array.isArray(db?.ancestry) ? db.ancestry.length : Number(db?.level || 0);
    if (depthA !== depthB) return depthA - depthB;
    return String(a).localeCompare(String(b));
  });
}

function remapZoneHierarchyFields(sourceDoc, ctx) {
  const unresolved = [];

  const mappedParentZoneId = sourceDoc?.parentZoneId
    ? resolveProdZoneIdFromLocalId(sourceDoc.parentZoneId, ctx)
    : null;
  if (sourceDoc?.parentZoneId && !mappedParentZoneId) unresolved.push('parentZoneId');

  const mappedParentCountryId = sourceDoc?.parentCountryId
    ? resolveProdZoneIdFromLocalId(sourceDoc.parentCountryId, ctx)
    : null;
  if (sourceDoc?.parentCountryId && !mappedParentCountryId) unresolved.push('parentCountryId');

  const mappedAncestry = [];
  for (const raw of Array.isArray(sourceDoc?.ancestry) ? sourceDoc.ancestry : []) {
    const mapped = resolveProdZoneIdFromLocalId(raw, ctx);
    if (!mapped) {
      unresolved.push(`ancestry:${String(raw)}`);
      continue;
    }
    mappedAncestry.push(mapped);
  }

  const cloned = { ...sourceDoc };
  cloned.parentZoneId = mappedParentZoneId ? new mongoose.Types.ObjectId(mappedParentZoneId) : null;
  cloned.parentCountryId = mappedParentCountryId ? new mongoose.Types.ObjectId(mappedParentCountryId) : null;
  cloned.ancestry = dedupeStrings(mappedAncestry).map((id) => new mongoose.Types.ObjectId(id));

  return { cloned, unresolved };
}

function collectZoneChainKeys(startDoc, byIdMap) {
  if (!startDoc) return [];
  const keys = new Set();
  const pending = [];
  const visitedIds = new Set();

  const pushDoc = (doc) => {
    if (!doc) return;
    const key = buildExternalKey(doc);
    if (key) keys.add(key);
    const directIds = [
      normalizeObjectIdString(doc?._id),
      normalizeObjectIdString(doc?.parentZoneId),
      normalizeObjectIdString(doc?.parentCountryId),
      ...(Array.isArray(doc?.ancestry) ? doc.ancestry.map((v) => normalizeObjectIdString(v)) : []),
    ].filter(Boolean);
    for (const id of directIds) {
      if (!visitedIds.has(id)) pending.push(id);
    }
  };

  pushDoc(startDoc);

  while (pending.length) {
    const id = pending.shift();
    if (!id || visitedIds.has(id)) continue;
    visitedIds.add(id);
    const doc = byIdMap.get(id);
    if (!doc) continue;
    pushDoc(doc);
  }

  return Array.from(keys.values());
}

async function remapLocalZoneReferences(
  localZoneCol,
  localActivityCol,
  fromIdRaw,
  toIdRaw
) {
  const fromId = toObjectIdIfValid(fromIdRaw);
  const toId = toObjectIdIfValid(toIdRaw);
  if (!fromId || !toId || String(fromId) === String(toId)) {
    return {
      zonesMatched: 0,
      zonesModified: 0,
      activitiesMatched: 0,
      activitiesModified: 0,
    };
  }

  const [zoneRemapResult, activityRemapResult] = await Promise.all([
    localZoneCol.updateMany(
      {
        $or: [
          { parentZoneId: fromId },
          { parentCountryId: fromId },
          { ancestry: fromId },
        ],
      },
      [
        {
          $set: {
            parentZoneId: {
              $cond: [{ $eq: ['$parentZoneId', fromId] }, toId, '$parentZoneId'],
            },
            parentCountryId: {
              $cond: [{ $eq: ['$parentCountryId', fromId] }, toId, '$parentCountryId'],
            },
            ancestry: {
              $cond: [
                { $isArray: '$ancestry' },
                {
                  $map: {
                    input: '$ancestry',
                    as: 'aid',
                    in: { $cond: [{ $eq: ['$$aid', fromId] }, toId, '$$aid'] },
                  },
                },
                '$ancestry',
              ],
            },
          },
        },
      ]
    ),
    localActivityCol.updateMany(
      {
        $or: [
          { 'location.primaryZoneId': fromId },
          { 'location.zonePathIds': fromId },
        ],
      },
      [
        {
          $set: {
            'location.primaryZoneId': {
              $cond: [{ $eq: ['$location.primaryZoneId', fromId] }, toId, '$location.primaryZoneId'],
            },
            'location.zonePathIds': {
              $cond: [
                { $isArray: '$location.zonePathIds' },
                {
                  $map: {
                    input: '$location.zonePathIds',
                    as: 'zid',
                    in: { $cond: [{ $eq: ['$$zid', fromId] }, toId, '$$zid'] },
                  },
                },
                '$location.zonePathIds',
              ],
            },
          },
        },
      ]
    ),
  ]);

  return {
    zonesMatched: Number(zoneRemapResult?.matchedCount || 0),
    zonesModified: Number(zoneRemapResult?.modifiedCount || 0),
    activitiesMatched: Number(activityRemapResult?.matchedCount || 0),
    activitiesModified: Number(activityRemapResult?.modifiedCount || 0),
  };
}

exports.status = async (req, res) => {
  const config = readSyncConfig();
  return res.json({
    success: true,
    data: {
      enabled: config.enabled,
      reason: config.reason,
      hasLocalUri: config.hasLocalUri,
      hasProdUri: config.hasProdUri,
      nodeEnv: process.env.NODE_ENV || 'development',
    },
  });
};

exports.syncChain = async (req, res, next) => {
  try {
    const config = requireEnabledSyncConfig();
    const key = String(req.query?.key || req.body?.key || '').trim();
    if (!key) {
      return res.status(400).json({
        success: false,
        message: 'key is required',
      });
    }

    const [localCol, prodCol] = await Promise.all([
      getZonesCollectionByUri(config.localUri),
      getZonesCollectionByUri(config.prodUri),
    ]);

    const compared = await loadComparableMaps(localCol, prodCol);

    const localById = new Map();
    const prodById = new Map();
    for (const doc of compared.localDocs || []) {
      const id = normalizeObjectIdString(doc?._id);
      if (!id) continue;
      localById.set(id, doc);
    }
    for (const doc of compared.prodDocs || []) {
      const id = normalizeObjectIdString(doc?._id);
      if (!id) continue;
      prodById.set(id, doc);
    }

    const localDoc = compared.localByKey.get(key) || null;
    const prodDoc = compared.prodByKey.get(key) || null;

    const chainKeys = dedupeStrings([
      key,
      ...collectZoneChainKeys(localDoc, localById),
      ...collectZoneChainKeys(prodDoc, prodById),
    ]);

    return res.json({
      success: true,
      data: {
        key,
        chainKeys,
      },
    });
  } catch (err) {
    return next(err);
  }
};

exports.compareZones = async (req, res, next) => {
  try {
    const config = requireEnabledSyncConfig();
    const limit = parseIntWithBounds(req.query.limit, 200, 20, 2000);

    const [localCol, prodCol] = await Promise.all([
      getZonesCollectionByUri(config.localUri),
      getZonesCollectionByUri(config.prodUri),
    ]);

    const compared = await loadComparableMaps(localCol, prodCol);
    const sameQidDifferentZoneId = buildSameQidDifferentZoneIdSummary(
      compared.localByKey,
      compared.prodByKey,
      Math.min(limit, 300)
    );

    const missingInProd = sortSummariesByUpdatedAtDesc(compared.missingInProd).slice(0, limit);
    const missingInLocal = sortSummariesByUpdatedAtDesc(compared.missingInLocal).slice(0, limit);
    const newerInLocal = sortSummariesByUpdatedAtDesc(compared.newerInLocal).slice(0, limit);
    const newerInProd = sortSummariesByUpdatedAtDesc(compared.newerInProd).slice(0, limit);

    return res.json({
      success: true,
      data: {
        totals: {
          local: compared.localDocs.length,
          prod: compared.prodDocs.length,
          comparableLocal: compared.localByKey.size,
          comparableProd: compared.prodByKey.size,
          missingInProd: compared.missingInProd.length,
          missingInLocal: compared.missingInLocal.length,
          newerInLocal: compared.newerInLocal.length,
          newerInProd: compared.newerInProd.length,
          skippedLocalNoExternalRef: compared.skippedLocalNoExternalRef,
          skippedProdNoExternalRef: compared.skippedProdNoExternalRef,
          sameQidDifferentZoneId: sameQidDifferentZoneId.total,
        },
        sampleLimit: limit,
        missingInProd,
        missingInLocal,
        newerInLocal,
        newerInProd,
        sameQidDifferentZoneIdRows: sameQidDifferentZoneId.rows,
      },
    });
  } catch (err) {
    return next(err);
  }
};

exports.pushLocalToProd = async (req, res, next) => {
  try {
    const config = requireEnabledSyncConfig();
    const includeNewer = parseBool(req.body?.includeNewer, false);
    const dryRun = parseBool(req.body?.dryRun, false);
    const preserveIds = parseBool(req.body?.preserveIds, true);

    const [localCol, prodCol] = await Promise.all([
      getZonesCollectionByUri(config.localUri),
      getZonesCollectionByUri(config.prodUri),
    ]);

    const compared = await loadComparableMaps(localCol, prodCol);
    const requestedKeys = dedupeStrings(Array.isArray(req.body?.keys) ? req.body.keys : []);

    const autoKeys = [
      ...compared.missingInProd.map((row) => row.key).filter(Boolean),
      ...(includeNewer ? compared.newerInLocal.map((row) => row.key).filter(Boolean) : []),
    ];
    const initialKeys = dedupeStrings(requestedKeys.length ? requestedKeys : autoKeys);
    const ctx = buildZoneSyncContext(compared);
    const expandedKeys = expandKeysWithAncestors(initialKeys, compared.localByKey, ctx.localById);
    const keysToSync = sortZoneKeysByHierarchy(expandedKeys, compared.localByKey);

    const localDocsByKey = compared.localByKey;
    const now = new Date();

    const summary = {
      requested: keysToSync.length,
      dryRun,
      includeNewer,
      preserveIds,
      inserted: 0,
      updated: 0,
      unchanged: 0,
      idMismatchDetected: 0,
      skippedMissingSource: 0,
      skippedInvalidExternalRef: 0,
      skippedUnresolvedHierarchy: 0,
      failed: 0,
    };

    const details = [];

    for (const key of keysToSync) {
      const sourceDoc = localDocsByKey.get(key);
      if (!sourceDoc) {
        summary.skippedMissingSource += 1;
        details.push({ key, status: 'skipped_missing_source' });
        continue;
      }

      const provider = String(sourceDoc?.source || '').trim();
      const id = String(sourceDoc?.externalId || '').trim();
      if (!provider || !id) {
        summary.skippedInvalidExternalRef += 1;
        details.push({ key, status: 'skipped_invalid_external_ref' });
        continue;
      }

      const filter = {
        source: provider,
        externalId: id,
      };

      const sourceId = normalizeObjectIdString(sourceDoc?._id);
      const existingProdFromMap = ctx.prodByKey.get(key);
      const existingProd =
        existingProdFromMap ||
        (await prodCol.findOne(filter, { projection: { _id: 1, createdAt: 1, source: 1, externalId: 1 } }));
      const existingProdId = normalizeObjectIdString(existingProd?._id);
      const hasIdMismatch = !!(sourceId && existingProdId && sourceId !== existingProdId);
      if (hasIdMismatch) summary.idMismatchDetected += 1;

      const { cloned: remapped, unresolved } = remapZoneHierarchyFields(sourceDoc, ctx);
      if (unresolved.length) {
        summary.skippedUnresolvedHierarchy += 1;
        details.push({ key, status: 'skipped_unresolved_hierarchy', unresolved });
        continue;
      }

      if (dryRun) {
        details.push({
          key,
          status: 'planned',
          idMismatch: hasIdMismatch,
        });
        continue;
      }

      try {
        const cloned = { ...remapped };
        delete cloned._id;
        const createdAt = cloned.createdAt ? new Date(cloned.createdAt) : now;
        cloned.updatedAt = cloned.updatedAt ? new Date(cloned.updatedAt) : now;
        delete cloned.createdAt;

        const setOnInsert = { createdAt };
        if (preserveIds && sourceId && !existingProdId) {
          const sourceObjectId = toObjectIdIfValid(sourceId);
          if (sourceObjectId) setOnInsert._id = sourceObjectId;
        }

        const writeResult = await prodCol.updateOne(
          filter,
          {
            $set: cloned,
            $setOnInsert: setOnInsert,
          },
          { upsert: true }
        );

        const effectiveProdId =
          existingProdId ||
          normalizeObjectIdString(writeResult?.upsertedId?._id || writeResult?.upsertedId) ||
          (preserveIds ? sourceId : null);

        if (sourceId && effectiveProdId) {
          ctx.localToProdId.set(sourceId, effectiveProdId);
        }
        if (effectiveProdId) {
          ctx.prodById.set(effectiveProdId, { _id: new mongoose.Types.ObjectId(effectiveProdId), source: provider, externalId: id });
          ctx.prodByKey.set(key, { _id: new mongoose.Types.ObjectId(effectiveProdId), source: provider, externalId: id });
        }

        if (writeResult.upsertedCount > 0) {
          summary.inserted += 1;
          details.push({ key, status: 'inserted', idMismatch: hasIdMismatch, prodId: effectiveProdId });
        } else if (writeResult.modifiedCount > 0) {
          summary.updated += 1;
          details.push({ key, status: 'updated', idMismatch: hasIdMismatch, prodId: effectiveProdId });
        } else {
          summary.unchanged += 1;
          details.push({ key, status: 'unchanged', idMismatch: hasIdMismatch, prodId: effectiveProdId });
        }
      } catch (err) {
        summary.failed += 1;
        details.push({
          key,
          status: 'failed',
          message: String(err?.message || 'Unknown write error'),
        });
      }
    }

    return res.json({
      success: true,
      data: {
        summary,
        details,
      },
    });
  } catch (err) {
    return next(err);
  }
};

exports.pushProdToLocal = async (req, res, next) => {
  try {
    const config = requireEnabledSyncConfig();
    const includeNewer = parseBool(req.body?.includeNewer, false);
    const dryRun = parseBool(req.body?.dryRun, false);
    const preserveIds = parseBool(req.body?.preserveIds, true);
    const pruneLocalExtras = parseBool(req.body?.pruneLocalExtras, false);
    const mirror = parseBool(req.body?.mirror, false);

    const [localCol, prodCol, localActivityCol] = await Promise.all([
      getZonesCollectionByUri(config.localUri),
      getZonesCollectionByUri(config.prodUri),
      getActivitiesCollectionByUri(config.localUri),
    ]);

    if (mirror) {
      const [prodDocs, localCount] = await Promise.all([
        prodCol.find({}).toArray(),
        localCol.countDocuments(),
      ]);

      const summary = {
        requested: prodDocs.length,
        dryRun,
        includeNewer,
        preserveIds,
        pruneLocalExtras: true,
        mirror: true,
        inserted: dryRun ? prodDocs.length : 0,
        updated: 0,
        unchanged: 0,
        idMismatchDetected: 0,
        idReplacedToMatchProd: 0,
        skippedMissingSource: 0,
        skippedInvalidExternalRef: 0,
        skippedUnresolvedHierarchy: 0,
        failed: 0,
        deletedLocalExtras: dryRun ? localCount : 0,
      };

      if (!dryRun) {
        await localCol.deleteMany({});
        if (prodDocs.length) {
          await localCol.insertMany(prodDocs, { ordered: false });
        }
        summary.inserted = prodDocs.length;
        summary.deletedLocalExtras = localCount;
      }

      return res.json({
        success: true,
        data: {
          summary,
          details: [
            {
              status: dryRun ? 'planned_mirror' : 'mirrored',
              deletedLocal: localCount,
              insertedFromProd: prodDocs.length,
            },
          ],
        },
      });
    }

    const compared = await loadComparableMaps(localCol, prodCol);
    const requestedKeys = dedupeStrings(Array.isArray(req.body?.keys) ? req.body.keys : []);

    const autoKeys = [
      ...compared.missingInLocal.map((row) => row.key).filter(Boolean),
      ...(includeNewer ? compared.newerInProd.map((row) => row.key).filter(Boolean) : []),
    ];
    const initialKeys = dedupeStrings(requestedKeys.length ? requestedKeys : autoKeys);

    const swapped = {
      localDocs: compared.prodDocs,
      prodDocs: compared.localDocs,
      localByKey: compared.prodByKey,
      prodByKey: compared.localByKey,
    };
    const ctx = buildZoneSyncContext(swapped);
    const expandedKeys = expandKeysWithAncestors(initialKeys, compared.prodByKey, ctx.localById);
    const keysToSync = sortZoneKeysByHierarchy(expandedKeys, compared.prodByKey);

    const sourceDocsByKey = compared.prodByKey;
    const now = new Date();

    const summary = {
      requested: keysToSync.length,
      dryRun,
      includeNewer,
      preserveIds,
      pruneLocalExtras,
      mirror: false,
      inserted: 0,
      updated: 0,
      unchanged: 0,
      idMismatchDetected: 0,
      idReplacedToMatchProd: 0,
      skippedMissingSource: 0,
      skippedInvalidExternalRef: 0,
      skippedUnresolvedHierarchy: 0,
      failed: 0,
      deletedLocalExtras: 0,
    };

    const details = [];

    for (const key of keysToSync) {
      const sourceDoc = sourceDocsByKey.get(key);
      if (!sourceDoc) {
        summary.skippedMissingSource += 1;
        details.push({ key, status: 'skipped_missing_source' });
        continue;
      }

      const provider = String(sourceDoc?.source || '').trim();
      const id = String(sourceDoc?.externalId || '').trim();
      if (!provider || !id) {
        summary.skippedInvalidExternalRef += 1;
        details.push({ key, status: 'skipped_invalid_external_ref' });
        continue;
      }

      const filter = { source: provider, externalId: id };

      const sourceId = normalizeObjectIdString(sourceDoc?._id);
      const existingLocalFromMap = ctx.prodByKey.get(key);
      const existingLocal =
        existingLocalFromMap ||
        (await localCol.findOne(filter, { projection: { _id: 1, createdAt: 1, source: 1, externalId: 1 } }));
      const existingLocalId = normalizeObjectIdString(existingLocal?._id);
      const hasIdMismatch = !!(sourceId && existingLocalId && sourceId !== existingLocalId);
      if (hasIdMismatch) summary.idMismatchDetected += 1;

      const { cloned: remapped, unresolved } = remapZoneHierarchyFields(sourceDoc, ctx);
      if (unresolved.length) {
        summary.skippedUnresolvedHierarchy += 1;
        details.push({ key, status: 'skipped_unresolved_hierarchy', unresolved });
        continue;
      }

      if (dryRun) {
        details.push({ key, status: 'planned', idMismatch: hasIdMismatch });
        continue;
      }

      try {
        const cloned = { ...remapped };
        delete cloned._id;
        const createdAt = cloned.createdAt ? new Date(cloned.createdAt) : now;
        cloned.updatedAt = cloned.updatedAt ? new Date(cloned.updatedAt) : now;
        delete cloned.createdAt;

        const replaceWithProdId =
          preserveIds &&
          !!sourceId &&
          !!existingLocalId &&
          sourceId !== existingLocalId;

        if (replaceWithProdId) {
          const sourceObjectId = toObjectIdIfValid(sourceId);
          const existingLocalObjectId = toObjectIdIfValid(existingLocalId);
          if (!sourceObjectId || !existingLocalObjectId) {
            throw new Error('Invalid ObjectId while replacing local zone id');
          }

          const conflictingAtTargetId = await localCol.findOne(
            { _id: sourceObjectId },
            { projection: { _id: 1, source: 1, externalId: 1 } }
          );
          if (
            conflictingAtTargetId &&
            (String(conflictingAtTargetId?.source || '').trim() !== provider ||
              String(conflictingAtTargetId?.externalId || '').trim() !== id)
          ) {
            throw new Error(`Cannot replace local zone id: target _id ${sourceId} belongs to a different zone`);
          }

          const replaceDoc = {
            ...cloned,
            _id: sourceObjectId,
            createdAt,
            updatedAt: cloned.updatedAt,
          };

          await localCol.deleteOne({ _id: existingLocalObjectId });
          await localCol.replaceOne(
            { _id: sourceObjectId },
            replaceDoc,
            { upsert: true }
          );

          const refRemap = await remapLocalZoneReferences(
            localCol,
            localActivityCol,
            existingLocalId,
            sourceId
          );

          summary.idReplacedToMatchProd += 1;
          summary.updated += 1;

          ctx.localToProdId.set(sourceId, sourceId);
          ctx.prodById.delete(existingLocalId);
          ctx.prodById.set(sourceId, {
            _id: sourceObjectId,
            source: provider,
            externalId: id,
          });
          ctx.prodByKey.set(key, {
            _id: sourceObjectId,
            source: provider,
            externalId: id,
          });

          details.push({
            key,
            status: 'replaced_id_to_match_prod',
            idMismatch: true,
            localId: sourceId,
            previousLocalId: existingLocalId,
            refRemap,
          });
          continue;
        }

        const setOnInsert = { createdAt };
        if (preserveIds && sourceId && !existingLocalId) {
          const sourceObjectId = toObjectIdIfValid(sourceId);
          if (sourceObjectId) setOnInsert._id = sourceObjectId;
        }

        const writeResult = await localCol.updateOne(
          filter,
          { $set: cloned, $setOnInsert: setOnInsert },
          { upsert: true }
        );

        const effectiveLocalId =
          existingLocalId ||
          normalizeObjectIdString(writeResult?.upsertedId?._id || writeResult?.upsertedId) ||
          (preserveIds ? sourceId : null);

        if (sourceId && effectiveLocalId) {
          ctx.localToProdId.set(sourceId, effectiveLocalId);
        }
        if (effectiveLocalId) {
          ctx.prodById.set(effectiveLocalId, {
            _id: new mongoose.Types.ObjectId(effectiveLocalId),
            source: provider,
            externalId: id,
          });
          ctx.prodByKey.set(key, {
            _id: new mongoose.Types.ObjectId(effectiveLocalId),
            source: provider,
            externalId: id,
          });
        }

        if (writeResult.upsertedCount > 0) {
          summary.inserted += 1;
          details.push({ key, status: 'inserted', idMismatch: hasIdMismatch, localId: effectiveLocalId });
        } else if (writeResult.modifiedCount > 0) {
          summary.updated += 1;
          details.push({ key, status: 'updated', idMismatch: hasIdMismatch, localId: effectiveLocalId });
        } else {
          summary.unchanged += 1;
          details.push({ key, status: 'unchanged', idMismatch: hasIdMismatch, localId: effectiveLocalId });
        }
      } catch (err) {
        summary.failed += 1;
        details.push({
          key,
          status: 'failed',
          message: String(err?.message || 'Unknown write error'),
        });
      }
    }

    if (pruneLocalExtras) {
      const requestedSet = new Set(requestedKeys);
      const pruneRows = requestedSet.size
        ? compared.missingInProd.filter((row) => requestedSet.has(String(row?.key || '').trim()))
        : compared.missingInProd;

      for (const row of pruneRows) {
        const source = String(row?.source || '').trim();
        const externalId = String(row?.externalId || '').trim();
        const key = String(row?.key || '').trim();
        if (!source || !externalId) continue;

        if (dryRun) {
          summary.deletedLocalExtras += 1;
          details.push({ key, status: 'planned_delete_local_extra' });
          continue;
        }

        const del = await localCol.deleteOne({ source, externalId });
        if (del?.deletedCount) {
          summary.deletedLocalExtras += 1;
          details.push({ key, status: 'deleted_local_extra' });
        }
      }
    }

    return res.json({
      success: true,
      data: { summary, details },
    });
  } catch (err) {
    return next(err);
  }
};
