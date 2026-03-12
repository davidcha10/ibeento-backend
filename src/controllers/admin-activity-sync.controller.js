const mongoose = require('mongoose');
const Activity = require('../models/Activity');
const Zone = require('../models/Zone');
const { Service } = require('../models/Service');
const UserFavorite = require('../models/UserFavorite');
const ItineraryItem = require('../models/ItineraryItem');

const EXTRA_CONNECTIONS = new Map();
const ACTIVITIES_COLLECTION = Activity.collection?.name || 'activities';
const ZONES_COLLECTION = Zone.collection?.name || 'zones';
const SERVICES_COLLECTION = Service.collection?.name || 'services';
const USER_FAVORITES_COLLECTION = UserFavorite.collection?.name || 'userfavorites';
const ITINERARY_ITEMS_COLLECTION = ItineraryItem.collection?.name || 'itineraryitems';

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
    String(process.env.ACTIVITY_DB_SYNC_ENABLED || 'true').trim().toLowerCase()
  );
  const allowInProd =
    process.env.NODE_ENV !== 'production' ||
    ['1', 'true', 'yes', 'on'].includes(
      String(process.env.ACTIVITY_DB_SYNC_ALLOW_IN_PROD || 'false').trim().toLowerCase()
    );

  const hasUris = !!localUri && !!prodUri;
  const enabled = enabledByFlag && allowInProd && hasUris;

  let reason = null;
  if (!enabledByFlag) reason = 'ACTIVITY_DB_SYNC_ENABLED is disabled';
  else if (!allowInProd) reason = 'ACTIVITY_DB_SYNC_ALLOW_IN_PROD is required in production';
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

  // Some local networks + older Node runtimes fail Atlas handshakes via IPv6.
  // Default to IPv4 for sync connections, overridable with ACTIVITY_DB_SYNC_MONGO_FAMILY.
  const familyRaw = Number(process.env.ACTIVITY_DB_SYNC_MONGO_FAMILY || 4);
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

async function getActivitiesCollectionByUri(uri) {
  const conn = await getConnectionByUri(uri);
  return conn.collection(ACTIVITIES_COLLECTION);
}

async function getZonesCollectionByUri(uri) {
  const conn = await getConnectionByUri(uri);
  return conn.collection(ZONES_COLLECTION);
}

async function getActivityReferenceCollectionsByUri(uri) {
  const conn = await getConnectionByUri(uri);
  return {
    serviceCol: conn.collection(SERVICES_COLLECTION),
    userFavoriteCol: conn.collection(USER_FAVORITES_COLLECTION),
    itineraryItemCol: conn.collection(ITINERARY_ITEMS_COLLECTION),
  };
}

function normalizeObjectIdString(value) {
  if (!value) return null;
  const raw = typeof value === 'object' ? value?._id || value?.id || value : value;
  const id = String(raw || '').trim();
  if (!id || !mongoose.Types.ObjectId.isValid(id)) return null;
  return id;
}

function toObjectIdArray(ids = []) {
  return dedupeStrings(ids)
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));
}

function toObjectIdIfValid(value) {
  const id = normalizeObjectIdString(value);
  return id ? new mongoose.Types.ObjectId(id) : null;
}

async function remapLocalActivityReferences(refCols, fromIdRaw, toIdRaw) {
  const fromId = toObjectIdIfValid(fromIdRaw);
  const toId = toObjectIdIfValid(toIdRaw);
  if (!fromId || !toId || String(fromId) === String(toId)) {
    return {
      servicesMatched: 0,
      servicesModified: 0,
      favoritesMatched: 0,
      favoritesModified: 0,
      itineraryItemsMatched: 0,
      itineraryItemsModified: 0,
    };
  }

  const [serviceRes, favoriteRes, itineraryRes] = await Promise.all([
    refCols.serviceCol.updateMany({ activityId: fromId }, { $set: { activityId: toId } }),
    refCols.userFavoriteCol.updateMany({ activityId: fromId }, { $set: { activityId: toId } }),
    refCols.itineraryItemCol.updateMany({ activityId: fromId }, { $set: { activityId: toId } }),
  ]);

  return {
    servicesMatched: Number(serviceRes?.matchedCount || 0),
    servicesModified: Number(serviceRes?.modifiedCount || 0),
    favoritesMatched: Number(favoriteRes?.matchedCount || 0),
    favoritesModified: Number(favoriteRes?.modifiedCount || 0),
    itineraryItemsMatched: Number(itineraryRes?.matchedCount || 0),
    itineraryItemsModified: Number(itineraryRes?.modifiedCount || 0),
  };
}

function buildZoneExternalKey(doc) {
  const source = String(doc?.source || '').trim();
  const externalId = String(doc?.externalId || '').trim();
  if (!source || !externalId) return null;
  return `${source}::${externalId}`;
}

async function buildZoneIdMapping(localZoneCol, prodZoneCol) {
  const projection = { _id: 1, source: 1, externalId: 1 };
  const [localZones, prodZones] = await Promise.all([
    localZoneCol.find({}, { projection }).toArray(),
    prodZoneCol.find({}, { projection }).toArray(),
  ]);

  const localById = new Map();
  const prodById = new Map();
  const localToProdId = new Map();
  const prodByZoneKey = new Map();

  for (const z of localZones) {
    const id = normalizeObjectIdString(z?._id);
    if (!id) continue;
    localById.set(id, z);
  }

  for (const z of prodZones) {
    const id = normalizeObjectIdString(z?._id);
    if (!id) continue;
    prodById.set(id, z);
    const key = buildZoneExternalKey(z);
    if (key && !prodByZoneKey.has(key)) prodByZoneKey.set(key, z);
  }

  for (const [localId, localZone] of localById.entries()) {
    if (prodById.has(localId)) {
      localToProdId.set(localId, localId);
      continue;
    }
    const key = buildZoneExternalKey(localZone);
    if (!key) continue;
    const prodZone = prodByZoneKey.get(key);
    const prodId = normalizeObjectIdString(prodZone?._id);
    if (!prodId) continue;
    localToProdId.set(localId, prodId);
  }

  return {
    localById,
    prodById,
    localToProdId,
    prodByZoneKey,
  };
}

function resolveProdZoneIdFromLocalId(localIdRaw, zoneMap) {
  const localId = normalizeObjectIdString(localIdRaw);
  if (!localId) return null;
  if (zoneMap.localToProdId.has(localId)) return zoneMap.localToProdId.get(localId) || null;
  if (zoneMap.prodById.has(localId)) return localId;

  const localZone = zoneMap.localById.get(localId);
  if (!localZone) return null;
  const key = buildZoneExternalKey(localZone);
  if (!key) return null;
  const prodZone = zoneMap.prodByZoneKey.get(key);
  const prodId = normalizeObjectIdString(prodZone?._id);
  if (!prodId) return null;
  zoneMap.localToProdId.set(localId, prodId);
  return prodId;
}

function remapActivityLocationForProd(location = {}, zoneMap) {
  const mappedPrimaryId = resolveProdZoneIdFromLocalId(location?.primaryZoneId, zoneMap);
  if (!mappedPrimaryId) {
    return {
      ok: false,
      reason: 'unmapped_primary_zone',
      location: null,
      unmappedPathCount: 0,
    };
  }

  const pathRaw = Array.isArray(location?.zonePathIds) ? location.zonePathIds : [];
  const mappedPathIds = [];
  let unmappedPathCount = 0;
  for (const raw of pathRaw) {
    const mapped = resolveProdZoneIdFromLocalId(raw, zoneMap);
    if (!mapped) {
      unmappedPathCount += 1;
      continue;
    }
    mappedPathIds.push(mapped);
  }

  const dedupedPath = dedupeStrings([mappedPrimaryId, ...mappedPathIds]);
  const out = { ...(location || {}) };
  out.primaryZoneId = new mongoose.Types.ObjectId(mappedPrimaryId);
  out.zonePathIds = dedupedPath.map((id) => new mongoose.Types.ObjectId(id));

  return {
    ok: true,
    reason: null,
    location: out,
    unmappedPathCount,
  };
}

async function buildSameQidDifferentZoneIdSummary(localByKey, prodByKey, localZoneCol, prodZoneCol, sampleLimit = 100) {
  const candidates = [];
  const localZoneIds = new Set();
  const prodZoneIds = new Set();

  for (const [key, localDoc] of localByKey.entries()) {
    const prodDoc = prodByKey.get(key);
    if (!prodDoc) continue;

    const localZoneId = normalizeObjectIdString(localDoc?.location?.primaryZoneId);
    const prodZoneId = normalizeObjectIdString(prodDoc?.location?.primaryZoneId);
    if (!localZoneId || !prodZoneId) continue;
    if (localZoneId === prodZoneId) continue;

    localZoneIds.add(localZoneId);
    prodZoneIds.add(prodZoneId);
    candidates.push({
      key,
      name: String(localDoc?.name || prodDoc?.name || '').trim() || 'Untitled',
      localZoneId,
      prodZoneId,
    });
  }

  if (!candidates.length) {
    return { total: 0, rows: [] };
  }

  const [localZones, prodZones] = await Promise.all([
    localZoneCol
      .find(
        { _id: { $in: toObjectIdArray(Array.from(localZoneIds.values())) } },
        { projection: { _id: 1, name: 1, externalId: 1 } }
      )
      .toArray(),
    prodZoneCol
      .find(
        { _id: { $in: toObjectIdArray(Array.from(prodZoneIds.values())) } },
        { projection: { _id: 1, name: 1, externalId: 1 } }
      )
      .toArray(),
  ]);

  const localZoneById = new Map(localZones.map((z) => [String(z?._id), z]));
  const prodZoneById = new Map(prodZones.map((z) => [String(z?._id), z]));

  const rows = [];
  for (const candidate of candidates) {
    const localZone = localZoneById.get(candidate.localZoneId);
    const prodZone = prodZoneById.get(candidate.prodZoneId);
    if (!localZone || !prodZone) continue;

    const localQid = String(localZone?.externalId || '').trim().toUpperCase();
    const prodQid = String(prodZone?.externalId || '').trim().toUpperCase();
    if (!localQid || !prodQid) continue;
    if (localQid !== prodQid) continue;

    rows.push({
      key: candidate.key,
      name: candidate.name,
      zoneQid: localQid,
      localZone: {
        _id: candidate.localZoneId,
        name: String(localZone?.name || '').trim() || null,
      },
      prodZone: {
        _id: candidate.prodZoneId,
        name: String(prodZone?.name || '').trim() || null,
      },
    });
  }

  return {
    total: rows.length,
    rows: rows.slice(0, Math.max(1, Math.min(sampleLimit, 500))),
  };
}

function buildExternalKey(doc) {
  const provider = String(doc?.externalRef?.provider || '').trim();
  const id = String(doc?.externalRef?.id || '').trim();
  if (!provider || !id) return null;
  return `${provider}::${id}`;
}

function summarizeActivity(doc) {
  return {
    key: buildExternalKey(doc),
    externalRef: {
      provider: doc?.externalRef?.provider || null,
      id: doc?.externalRef?.id || null,
    },
    _id: doc?._id ? String(doc._id) : null,
    name: String(doc?.name || '').trim() || 'Untitled',
    primaryZoneId: normalizeObjectIdString(doc?.location?.primaryZoneId),
    zonePathIds: Array.isArray(doc?.location?.zonePathIds)
      ? doc.location.zonePathIds.map((id) => normalizeObjectIdString(id)).filter(Boolean)
      : [],
    updatedAt: doc?.updatedAt || null,
    active: doc?.active !== false,
  };
}

function summarizeZoneForActivity(zoneDoc) {
  if (!zoneDoc) return null;
  const source = String(zoneDoc?.source || '').trim() || null;
  const externalId = String(zoneDoc?.externalId || '').trim() || null;
  const key = source && externalId ? `${source}::${externalId}` : null;
  return {
    key,
    source,
    externalId,
    _id: zoneDoc?._id ? String(zoneDoc._id) : null,
    name: String(zoneDoc?.name || '').trim() || 'Untitled',
    canonicalType: String(zoneDoc?.taxonomySnapshot?.canonicalType || '').trim() || null,
    updatedAt: zoneDoc?.updatedAt || null,
    active: zoneDoc?.active !== false,
  };
}

async function attachPrimaryZoneContext(rows, zoneCol) {
  const safeRows = Array.isArray(rows) ? rows : [];
  if (!safeRows.length) return safeRows;

  const zoneIds = dedupeStrings(safeRows.map((row) => normalizeObjectIdString(row?.primaryZoneId)).filter(Boolean));
  if (!zoneIds.length) return safeRows;

  const zoneDocs = await zoneCol
    .find(
      { _id: { $in: toObjectIdArray(zoneIds) } },
      {
        projection: {
          _id: 1,
          source: 1,
          externalId: 1,
          name: 1,
          taxonomySnapshot: 1,
          updatedAt: 1,
          active: 1,
        },
      }
    )
    .toArray();

  const zoneById = new Map(zoneDocs.map((doc) => [String(doc?._id), summarizeZoneForActivity(doc)]));
  return safeRows.map((row) => {
    const zoneId = normalizeObjectIdString(row?.primaryZoneId);
    return {
      ...row,
      primaryZone: zoneId ? zoneById.get(zoneId) || null : null,
    };
  });
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
      missingInProd.push(summarizeActivity(localDoc));
      continue;
    }
    const localTs = toTimestamp(localDoc?.updatedAt);
    const prodTs = toTimestamp(prodDoc?.updatedAt);
    if (localTs > prodTs) newerInLocal.push(summarizeActivity(localDoc));
    else if (prodTs > localTs) newerInProd.push(summarizeActivity(prodDoc));
  }

  for (const [key, prodDoc] of prodByKey.entries()) {
    if (!localByKey.has(key)) {
      missingInLocal.push(summarizeActivity(prodDoc));
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

function requireEnabledSyncConfig() {
  const config = readSyncConfig();
  if (!config.enabled) {
    const err = new Error(config.reason || 'Activity sync is disabled');
    err.status = 503;
    err.code = 'ACTIVITY_SYNC_DISABLED';
    err.meta = {
      hasLocalUri: config.hasLocalUri,
      hasProdUri: config.hasProdUri,
      reason: config.reason,
    };
    throw err;
  }
  return config;
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

exports.compareActivities = async (req, res, next) => {
  try {
    const config = requireEnabledSyncConfig();
    const limit = parseIntWithBounds(req.query.limit, 200, 20, 2000);

    const [localCol, prodCol, localZoneCol, prodZoneCol] = await Promise.all([
      getActivitiesCollectionByUri(config.localUri),
      getActivitiesCollectionByUri(config.prodUri),
      getZonesCollectionByUri(config.localUri),
      getZonesCollectionByUri(config.prodUri),
    ]);

    const compared = await loadComparableMaps(localCol, prodCol);
    const sameQidDifferentZoneId = await buildSameQidDifferentZoneIdSummary(
      compared.localByKey,
      compared.prodByKey,
      localZoneCol,
      prodZoneCol,
      Math.min(limit, 300)
    );

    const missingInProdBase = sortSummariesByUpdatedAtDesc(compared.missingInProd).slice(0, limit);
    const missingInLocalBase = sortSummariesByUpdatedAtDesc(compared.missingInLocal).slice(0, limit);
    const newerInLocalBase = sortSummariesByUpdatedAtDesc(compared.newerInLocal).slice(0, limit);
    const newerInProdBase = sortSummariesByUpdatedAtDesc(compared.newerInProd).slice(0, limit);

    const [missingInProd, missingInLocal, newerInLocal, newerInProd] = await Promise.all([
      attachPrimaryZoneContext(missingInProdBase, localZoneCol),
      attachPrimaryZoneContext(missingInLocalBase, prodZoneCol),
      attachPrimaryZoneContext(newerInLocalBase, localZoneCol),
      attachPrimaryZoneContext(newerInProdBase, prodZoneCol),
    ]);

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

exports.listMissingKeysByZone = async (req, res, next) => {
  try {
    const config = requireEnabledSyncConfig();
    const directionRaw = String(req.body?.direction || req.query?.direction || 'localToProd').trim();
    const direction = directionRaw === 'prodToLocal' ? 'prodToLocal' : 'localToProd';
    const zoneKeys = dedupeStrings(
      Array.isArray(req.body?.zoneKeys)
        ? req.body.zoneKeys
        : String(req.query?.zoneKeys || '')
            .split(',')
            .map((v) => String(v || '').trim())
    );
    if (!zoneKeys.length) {
      return res.json({
        success: true,
        data: {
          direction,
          zoneKeys: [],
          count: 0,
          keys: [],
        },
      });
    }

    const [localCol, prodCol, localZoneCol, prodZoneCol] = await Promise.all([
      getActivitiesCollectionByUri(config.localUri),
      getActivitiesCollectionByUri(config.prodUri),
      getZonesCollectionByUri(config.localUri),
      getZonesCollectionByUri(config.prodUri),
    ]);

    const compared = await loadComparableMaps(localCol, prodCol);
    const zoneKeySet = new Set(zoneKeys);

    const sourceRowsBase = direction === 'prodToLocal' ? compared.missingInLocal : compared.missingInProd;
    const sourceZoneCol = direction === 'prodToLocal' ? prodZoneCol : localZoneCol;
    const sourceRows = await attachPrimaryZoneContext(sourceRowsBase, sourceZoneCol);

    const keys = dedupeStrings(
      sourceRows
        .filter((row) => zoneKeySet.has(String(row?.primaryZone?.key || '').trim()))
        .map((row) => String(row?.key || '').trim())
        .filter(Boolean)
    );

    return res.json({
      success: true,
      data: {
        direction,
        zoneKeys,
        count: keys.length,
        keys,
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
    
    const [localCol, prodCol, localZoneCol, prodZoneCol] = await Promise.all([
      getActivitiesCollectionByUri(config.localUri),
      getActivitiesCollectionByUri(config.prodUri),
      getZonesCollectionByUri(config.localUri),
      getZonesCollectionByUri(config.prodUri),
    ]);

    const compared = await loadComparableMaps(localCol, prodCol);
    const zoneMap = await buildZoneIdMapping(localZoneCol, prodZoneCol);
    const requestedKeys = dedupeStrings(Array.isArray(req.body?.keys) ? req.body.keys : []);

    const autoKeys = [
      ...compared.missingInProd.map((row) => row.key).filter(Boolean),
      ...(includeNewer ? compared.newerInLocal.map((row) => row.key).filter(Boolean) : []),
    ];
    const keysToSync = dedupeStrings(requestedKeys.length ? requestedKeys : autoKeys);

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
      skippedUnmappedPrimaryZone: 0,
      unmappedZonePathEntries: 0,
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

      const provider = String(sourceDoc?.externalRef?.provider || '').trim();
      const id = String(sourceDoc?.externalRef?.id || '').trim();
      if (!provider || !id) {
        summary.skippedInvalidExternalRef += 1;
        details.push({ key, status: 'skipped_invalid_external_ref' });
        continue;
      }

      const filter = {
        'externalRef.provider': provider,
        'externalRef.id': id,
      };

      const sourceId = sourceDoc?._id ? String(sourceDoc._id) : null;
      const existingProdFromMap = compared.prodByKey.get(key);
      const existingProd =
        existingProdFromMap ||
        (await prodCol.findOne(filter, { projection: { _id: 1, createdAt: 1 } }));
      const existingProdId = existingProd?._id ? String(existingProd._id) : null;
      const hasIdMismatch = !!(preserveIds && sourceId && existingProdId && sourceId !== existingProdId);
      if (hasIdMismatch) summary.idMismatchDetected += 1;

      const remapped = remapActivityLocationForProd(sourceDoc?.location || {}, zoneMap);
      if (!remapped.ok) {
        summary.skippedUnmappedPrimaryZone += 1;
        details.push({ key, status: 'skipped_unmapped_primary_zone' });
        continue;
      }
      if (remapped.unmappedPathCount > 0) {
        summary.unmappedZonePathEntries += remapped.unmappedPathCount;
      }

      if (dryRun) {
        details.push({ key, status: 'planned', idMismatch: hasIdMismatch, unmappedZonePathCount: remapped.unmappedPathCount });
        continue;
      }

      try {
        const cloned = { ...sourceDoc, location: remapped.location };
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

        if (writeResult.upsertedCount > 0) {
          summary.inserted += 1;
          details.push({ key, status: 'inserted', idMismatch: hasIdMismatch });
        } else if (writeResult.modifiedCount > 0) {
          summary.updated += 1;
          details.push({ key, status: 'updated', idMismatch: hasIdMismatch });
        } else {
          summary.unchanged += 1;
          details.push({ key, status: 'unchanged', idMismatch: hasIdMismatch });
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

    const [localCol, prodCol, localZoneCol, prodZoneCol, localRefCols] = await Promise.all([
      getActivitiesCollectionByUri(config.localUri),
      getActivitiesCollectionByUri(config.prodUri),
      getZonesCollectionByUri(config.localUri),
      getZonesCollectionByUri(config.prodUri),
      getActivityReferenceCollectionsByUri(config.localUri),
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
        skippedUnmappedPrimaryZone: 0,
        unmappedZonePathEntries: 0,
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
    const zoneMap = await buildZoneIdMapping(prodZoneCol, localZoneCol);
    const requestedKeys = dedupeStrings(Array.isArray(req.body?.keys) ? req.body.keys : []);

    const autoKeys = [
      ...compared.missingInLocal.map((row) => row.key).filter(Boolean),
      ...(includeNewer ? compared.newerInProd.map((row) => row.key).filter(Boolean) : []),
    ];
    const keysToSync = dedupeStrings(requestedKeys.length ? requestedKeys : autoKeys);

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
      skippedUnmappedPrimaryZone: 0,
      unmappedZonePathEntries: 0,
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

      const provider = String(sourceDoc?.externalRef?.provider || '').trim();
      const id = String(sourceDoc?.externalRef?.id || '').trim();
      if (!provider || !id) {
        summary.skippedInvalidExternalRef += 1;
        details.push({ key, status: 'skipped_invalid_external_ref' });
        continue;
      }

      const filter = {
        'externalRef.provider': provider,
        'externalRef.id': id,
      };

      const sourceId = sourceDoc?._id ? String(sourceDoc._id) : null;
      const existingLocalFromMap = compared.localByKey.get(key);
      const existingLocal =
        existingLocalFromMap ||
        (await localCol.findOne(filter, { projection: { _id: 1, createdAt: 1 } }));
      const existingLocalId = existingLocal?._id ? String(existingLocal._id) : null;
      const hasIdMismatch = !!(preserveIds && sourceId && existingLocalId && sourceId !== existingLocalId);
      if (hasIdMismatch) summary.idMismatchDetected += 1;

      const remapped = remapActivityLocationForProd(sourceDoc?.location || {}, zoneMap);
      if (!remapped.ok) {
        summary.skippedUnmappedPrimaryZone += 1;
        details.push({ key, status: 'skipped_unmapped_primary_zone' });
        continue;
      }
      if (remapped.unmappedPathCount > 0) {
        summary.unmappedZonePathEntries += remapped.unmappedPathCount;
      }

      if (dryRun) {
        details.push({
          key,
          status: 'planned',
          idMismatch: hasIdMismatch,
          unmappedZonePathCount: remapped.unmappedPathCount,
        });
        continue;
      }

      try {
        const cloned = { ...sourceDoc, location: remapped.location };
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
            throw new Error('Invalid ObjectId while replacing local activity id');
          }

          const conflictingAtTargetId = await localCol.findOne(
            { _id: sourceObjectId },
            { projection: { _id: 1, externalRef: 1 } }
          );
          if (
            conflictingAtTargetId &&
            (String(conflictingAtTargetId?.externalRef?.provider || '').trim() !== provider ||
              String(conflictingAtTargetId?.externalRef?.id || '').trim() !== id)
          ) {
            throw new Error(`Cannot replace local activity id: target _id ${sourceId} belongs to a different activity`);
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

          const refRemap = await remapLocalActivityReferences(
            localRefCols,
            existingLocalId,
            sourceId
          );

          summary.idReplacedToMatchProd += 1;
          summary.updated += 1;
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
          {
            $set: cloned,
            $setOnInsert: setOnInsert,
          },
          { upsert: true }
        );

        if (writeResult.upsertedCount > 0) {
          summary.inserted += 1;
          details.push({ key, status: 'inserted', idMismatch: hasIdMismatch });
        } else if (writeResult.modifiedCount > 0) {
          summary.updated += 1;
          details.push({ key, status: 'updated', idMismatch: hasIdMismatch });
        } else {
          summary.unchanged += 1;
          details.push({ key, status: 'unchanged', idMismatch: hasIdMismatch });
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
        const provider = String(row?.externalRef?.provider || '').trim();
        const id = String(row?.externalRef?.id || '').trim();
        const key = String(row?.key || '').trim();
        if (!provider || !id) continue;

        if (dryRun) {
          summary.deletedLocalExtras += 1;
          details.push({ key, status: 'planned_delete_local_extra' });
          continue;
        }

        const del = await localCol.deleteOne({
          'externalRef.provider': provider,
          'externalRef.id': id,
        });
        if (del?.deletedCount) {
          summary.deletedLocalExtras += 1;
          details.push({ key, status: 'deleted_local_extra' });
        }
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
