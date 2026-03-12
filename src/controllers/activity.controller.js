const mongoose = require('mongoose');
const Activity = require('../models/Activity');
const BusinessUnit = require('../models/BusinessUnit');
const Zone = require('../models/Zone');
const ActivityCategory = require('../models/ActivityCategory');
const { Service } = require('../models/Service');
const { syncZoneHierarchyByQid } = require('./location.controller');


const {
  resolveActivityCategoryIdsFromWikidataClassIds,
} = require('../utils/categories-definer.helper');
const { scoreActivitiesForUser } = require('../services/activity/activity-scoring.service');
const {
  wikidataTourismSearch,
  wikidataSearchSingleActivityByText,
  wikidataGetEntitiesRaw,
} = require('../services/activity/open-source.service');

function collectActivityCategoryIds(activity) {
  const ids = [];
  if (Array.isArray(activity?.activityCategoryIds)) {
    for (const id of activity.activityCategoryIds) {
      if (!id) continue;
      ids.push(String(id));
    }
  }
  return Array.from(new Set(ids));
}

function normalizeDurationWindow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const min = Number(raw.minMinutes);
  const max = Number(raw.maxMinutes);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  if (min <= 0 || max <= 0) return null;
  if (min > max) return null;
  return { minMinutes: Math.round(min), maxMinutes: Math.round(max) };
}

function deriveDefaultDurationFromCategoryIds(categoryIds = [], categoryByIdMap = new Map()) {
  if (!Array.isArray(categoryIds) || !categoryIds.length) return null;

  const windows = [];
  for (const id of categoryIds) {
    const cat = categoryByIdMap.get(String(id));
    const w = normalizeDurationWindow(cat?.defaultDurationMin);
    if (w) windows.push(w);
  }
  if (!windows.length) return null;

  // Multi-category merge rule:
  // - min = max(mins) to avoid too-short estimates in combined experiences
  // - max = max(maxs) for an upper bound that preserves the longest category
  const minMinutes = Math.max(...windows.map((w) => w.minMinutes));
  const maxMinutes = Math.max(...windows.map((w) => w.maxMinutes), minMinutes);

  return {
    minMinutes,
    maxMinutes,
    source: 'category',
  };
}

function normalizeOpeningHoursPayload(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const out = {};

  // New lightweight shape
  if (Array.isArray(raw.openDays)) {
    const days = raw.openDays
      .map((v) => (typeof v === 'string' ? v.trim() : ''))
      .filter(Boolean);
    if (days.length) out.openDays = Array.from(new Set(days));
  }
  if (typeof raw.opensAt === 'string' && raw.opensAt.trim()) out.opensAt = raw.opensAt.trim();
  if (typeof raw.closesAt === 'string' && raw.closesAt.trim()) out.closesAt = raw.closesAt.trim();
  if (typeof raw.lastEntryAt === 'string' && raw.lastEntryAt.trim()) out.lastEntryAt = raw.lastEntryAt.trim();
  if (typeof raw.rawText === 'string' && raw.rawText.trim()) out.rawText = raw.rawText.trim();
  if (Array.isArray(raw.weeklySchedule)) {
    const allowedDays = new Set([
      'monday',
      'tuesday',
      'wednesday',
      'thursday',
      'friday',
      'saturday',
      'sunday',
      'holiday',
    ]);
    const normalized = raw.weeklySchedule
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const day = String(entry.day || '').trim().toLowerCase();
        if (!allowedDays.has(day)) return null;
        const opensAt = typeof entry.opensAt === 'string' ? entry.opensAt.trim() : '';
        const closesAt = typeof entry.closesAt === 'string' ? entry.closesAt.trim() : '';
        const closed = !!entry.closed;
        if (!closed && !opensAt && !closesAt) return null;
        return {
          day,
          opensAt: opensAt || undefined,
          closesAt: closesAt || undefined,
          closed,
        };
      })
      .filter(Boolean);
    if (normalized.length) out.weeklySchedule = normalized;
  }

  // Backward compatibility with legacy payloads (Google-like or prior schema)
  if (!out.rawText && typeof raw.raw === 'string' && raw.raw.trim()) {
    out.rawText = raw.raw.trim();
  }
  if (!out.rawText && Array.isArray(raw.weekdayDescriptions)) {
    const text = raw.weekdayDescriptions
      .map((v) => (typeof v === 'string' ? v.trim() : ''))
      .filter(Boolean)
      .join(' | ');
    if (text) out.rawText = text;
  }

  const allowedSources = new Set(['wikidata', 'google', 'manual', 'provider', 'fallback', 'unknown']);
  if (typeof raw.source === 'string' && allowedSources.has(raw.source.trim())) {
    out.source = raw.source.trim();
  }

  const allowedConfidence = new Set(['high', 'medium', 'low']);
  if (typeof raw.confidence === 'string' && allowedConfidence.has(raw.confidence.trim())) {
    out.confidence = raw.confidence.trim();
  }

  if (typeof raw.notes === 'string' && raw.notes.trim()) {
    out.notes = raw.notes.trim();
  }

  const hasSubstance = Boolean(
    (Array.isArray(out.openDays) && out.openDays.length) ||
      (Array.isArray(out.weeklySchedule) && out.weeklySchedule.length) ||
      out.opensAt ||
      out.closesAt ||
      out.lastEntryAt ||
      out.rawText
  );
  if (!hasSubstance) return null;

  const parsedDate = raw.updatedAt ? new Date(raw.updatedAt) : null;
  if (parsedDate && !Number.isNaN(parsedDate.getTime())) {
    out.updatedAt = parsedDate;
  } else if (out.source === 'wikidata') {
    out.updatedAt = new Date();
  }

  if (!out.source) out.source = 'unknown';
  if (!out.confidence) out.confidence = 'low';

  return out;
}

function looksEnglishEnough(value = '') {
  const s = String(value || '').trim();
  if (!s) return false;
  const latinLetters = (s.match(/[A-Za-z]/g) || []).length;
  return latinLetters >= 3;
}

function addressDetailScore(value = '') {
  const s = String(value || '').trim();
  if (!s) return 0;
  const parts = s
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean).length;
  // Score with a mix of structure depth and payload length.
  return parts * 10 + Math.min(40, Math.floor(s.length / 8));
}

function normalizeLocationSource(source, fallback = 'manual') {
  const s = String(source || '').trim().toLowerCase();
  if (!s) return fallback;
  if (s.startsWith('nominatim')) return 'nominatim';
  if (s === 'wikidata') return 'wikidata';
  if (s === 'manual') return 'manual';
  return fallback;
}

function normalizeObjectIdString(value) {
  if (!value) return null;
  const raw = typeof value === 'object' ? value._id || value.id || value : value;
  const asString = String(raw).trim();
  if (!asString || !mongoose.Types.ObjectId.isValid(asString)) return null;
  return asString;
}

function buildManualActivityExternalRefId(activityId) {
  const normalizedId = normalizeObjectIdString(activityId);
  if (!normalizedId) return '';
  return `manual:activity:${normalizedId}`;
}

function normalizeZoneType(value) {
  const raw = String(value || '').trim().toLowerCase();
  return raw || 'city';
}

function minRequiredByZoneType(zoneType) {
  const type = normalizeZoneType(zoneType);
  let minRequired = 20;

  if (type === 'country') minRequired = 45;
  else if (type === 'region' || type === 'province' || type === 'emirate') minRequired = 35;
  else if (type === 'city' || type === 'town' || type === 'commune') minRequired = 25;
  else if (type === 'district') minRequired = 18;
  else if (type === 'neighborhood' || type === 'locality' || type === 'subdistrict' || type === 'village') minRequired = 12;

  return Math.max(1, minRequired);
}

const DISCOVER_TARGET_PER_ZONE_DEFAULT = 12;
const DISCOVER_TARGET_PER_ZONE_MIN = 1;
const DISCOVER_TARGET_PER_ZONE_MAX = 200;

function normalizeDiscoverTargetPerZone(rawValue) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return DISCOVER_TARGET_PER_ZONE_DEFAULT;
  return Math.max(
    DISCOVER_TARGET_PER_ZONE_MIN,
    Math.min(DISCOVER_TARGET_PER_ZONE_MAX, Math.floor(parsed))
  );
}

function buildDiscoverEnabledCategoryFilter() {
  return {
    isActive: true,
    externalId: { $exists: true, $ne: null },
    $or: [
      { 'discover.enabled': { $exists: false } },
      { 'discover.enabled': true },
    ],
  };
}

function buildDiscoverClassConfig(activityCategories = []) {
  const classTargetByRootId = {};
  for (const category of Array.isArray(activityCategories) ? activityCategories : []) {
    const externalId = String(category?.externalId || '').trim().toUpperCase();
    if (!/^Q\d+$/.test(externalId)) continue;
    classTargetByRootId[externalId] = normalizeDiscoverTargetPerZone(
      category?.discover?.targetPerZone
    );
  }
  const rootClassIds = Object.keys(classTargetByRootId);
  return { rootClassIds, classTargetByRootId };
}

async function loadDiscoverClassConfig() {
  const activityCategories = await ActivityCategory.find(
    buildDiscoverEnabledCategoryFilter(),
    { externalId: 1, discover: 1 }
  ).lean();
  return buildDiscoverClassConfig(activityCategories);
}

async function hasZoneBeenDiscoverPreviewSearched(zoneId) {
  const normalizedZoneId = normalizeObjectIdString(zoneId);
  if (!normalizedZoneId) return false;

  const zone = await Zone.findById(normalizedZoneId)
    .select('discoverPreviewSearched')
    .lean();
  return !!zone?.discoverPreviewSearched;
}

async function markZoneDiscoverPreviewSearched(zoneId) {
  const normalizedZoneId = normalizeObjectIdString(zoneId);
  if (!normalizedZoneId) return;
  await Zone.findByIdAndUpdate(normalizedZoneId, {
    $set: { discoverPreviewSearched: true },
  }).lean();
}

function buildActivityLocationFilter(location = null) {
  const id = normalizeObjectIdString(location?._id);
  if (!id) return null;

  return {
    active: true,
    'location.zonePathIds': id,
  };
}

function dedupeObjectIdStrings(values = []) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const id = normalizeObjectIdString(value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function buildZonePathIdsFromZoneDoc(zoneDoc) {
  if (!zoneDoc?._id) return [];
  const ancestry = Array.isArray(zoneDoc.ancestry) ? [...zoneDoc.ancestry] : [];
  // ancestry in Zone is stored root -> parent. We store path leaf -> root for consistent reads.
  return dedupeObjectIdStrings([zoneDoc._id, ...ancestry.reverse()]);
}

async function hydrateActivitiesZonePath(rows = []) {
  const items = Array.isArray(rows) ? rows : [];
  if (!items.length) return items;

  const ids = new Set();
  for (const row of items) {
    const loc = row?.location || {};
    const primary = normalizeObjectIdString(loc?.primaryZoneId);
    if (primary) ids.add(primary);
    if (Array.isArray(loc?.zonePathIds)) {
      for (const z of loc.zonePathIds) {
        const zid = normalizeObjectIdString(z);
        if (zid) ids.add(zid);
      }
    }
  }
  if (!ids.size) return items;

  const zoneDocs = await Zone.find({ _id: { $in: Array.from(ids) } })
    .select('_id name taxonomySnapshot')
    .lean();
  const byId = new Map(zoneDocs.map((z) => [String(z._id), z]));

  return items.map((row) => {
    const loc = row?.location || null;
    if (!loc) return row;

    const primaryId = normalizeObjectIdString(loc.primaryZoneId);
    const nextPrimary = primaryId ? (byId.get(primaryId) || loc.primaryZoneId) : loc.primaryZoneId;

    let nextPath = loc.zonePathIds;
    if (Array.isArray(loc.zonePathIds)) {
      nextPath = loc.zonePathIds.map((z) => {
        const zid = normalizeObjectIdString(z);
        if (!zid) return z;
        return byId.get(zid) || z;
      });
    }

    return {
      ...row,
      location: {
        ...loc,
        primaryZoneId: nextPrimary,
        zonePathIds: nextPath,
      },
    };
  });
}

async function normalizeActivityLocationFromZones(location = {}) {
  const primaryRaw =
    location?.primaryZoneId ||
    (Array.isArray(location?.zonePathIds) ? location.zonePathIds[0] : null) ||
    location?.zoneId ||
    null;
  const primaryZoneId = normalizeObjectIdString(primaryRaw);
  if (!primaryZoneId) return null;

  const zoneDoc = await Zone.findById(primaryZoneId)
    .select('_id ancestry timeZone')
    .lean();
  if (!zoneDoc) return null;

  const zonePathIds = buildZonePathIdsFromZoneDoc(zoneDoc);
  return {
    primaryZoneId,
    zonePathIds,
    timeZone: location?.timeZone || zoneDoc?.timeZone || undefined,
    address: typeof location?.address === 'string' ? location.address : undefined,
    addresses:
      location?.addresses && typeof location.addresses === 'object' && !Array.isArray(location.addresses)
        ? location.addresses
        : undefined,
    addressSource: location?.addressSource || undefined,
    geo: location?.geo || undefined,
    geoSource: location?.geoSource || undefined,
    geoConfidence: location?.geoConfidence || undefined,
  };
}

async function hasActiveLinkedService(activityId) {
  if (!activityId) return false;
  return !!(await Service.exists({
    activityId: new mongoose.Types.ObjectId(String(activityId)),
    isActive: { $ne: false },
  }));
}

const DISCOVER_PREVIEW_JOB_TTL_MS = 30 * 60 * 1000;
const DISCOVER_PREVIEW_JOB_MAX_ITEMS = 120;
const DISCOVER_PREVIEW_NO_LOCATIONS_LIMIT = 50;
const discoverPreviewJobs = new Map();

function createHttpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function stageMessageByCode(stage) {
  if (stage === 'preparing') return 'Preparing results...';
  if (stage === 'collecting') return 'Gathering options...';
  if (stage === 'evaluating') return 'Refining results...';
  if (stage === 'finalizing') return 'Finalizing list...';
  if (stage === 'done') return 'Ready.';
  if (stage === 'failed') return 'Could not complete this request.';
  return 'Working...';
}

function toProgressDestination(location = {}, index = 0) {
  return {
    locationId: location?._id ? String(location._id) : `idx-${index}`,
    label:
      String(location?.label || location?.name || '').trim() ||
      `Destination ${index + 1}`,
    status: 'pending',
    acceptedCount: 0,
  };
}

function computeDiscoverProgressPercent(stage, destinationsCompleted = 0, destinationsTotal = 0) {
  if (stage === 'done') return 100;
  if (stage === 'failed') return 100;
  if (stage === 'preparing') return 8;
  if (stage === 'collecting') {
    if (!destinationsTotal) return 42;
    const ratio = Math.max(0, Math.min(1, destinationsCompleted / destinationsTotal));
    return Math.round(12 + ratio * 66);
  }
  if (stage === 'evaluating') return 86;
  if (stage === 'finalizing') return 96;
  return 4;
}

function cleanupDiscoverPreviewJobs() {
  const now = Date.now();
  for (const [jobId, job] of discoverPreviewJobs.entries()) {
    const updatedAtMs = new Date(job.updatedAt || job.createdAt || now).getTime();
    if (!Number.isFinite(updatedAtMs)) {
      discoverPreviewJobs.delete(jobId);
      continue;
    }
    if (now - updatedAtMs > DISCOVER_PREVIEW_JOB_TTL_MS) {
      discoverPreviewJobs.delete(jobId);
    }
  }

  if (discoverPreviewJobs.size > DISCOVER_PREVIEW_JOB_MAX_ITEMS) {
    const ordered = Array.from(discoverPreviewJobs.values()).sort(
      (a, b) => new Date(a.updatedAt || a.createdAt).getTime() - new Date(b.updatedAt || b.createdAt).getTime()
    );
    const overflow = discoverPreviewJobs.size - DISCOVER_PREVIEW_JOB_MAX_ITEMS;
    for (let i = 0; i < overflow; i += 1) {
      const job = ordered[i];
      if (!job?.jobId) continue;
      discoverPreviewJobs.delete(job.jobId);
    }
  }
}

function normalizeProgressDestinations(destinations = []) {
  if (!Array.isArray(destinations)) return [];
  return destinations.map((row, index) => ({
    locationId: row?.locationId ? String(row.locationId) : `idx-${index}`,
    label: String(row?.label || `Destination ${index + 1}`).trim(),
    status: String(row?.status || 'pending'),
    acceptedCount: Number(row?.acceptedCount || 0),
  }));
}

function updateDiscoverPreviewJobProgress(job, patch = {}) {
  if (!job) return;

  if (patch.stage) {
    job.stage = String(patch.stage);
    job.message = patch.message || stageMessageByCode(job.stage);
  } else if (patch.message) {
    job.message = String(patch.message);
  }

  if (Number.isFinite(Number(patch.destinationsTotal))) {
    job.progress.destinationsTotal = Math.max(0, Number(patch.destinationsTotal));
  }
  if (Number.isFinite(Number(patch.destinationsCompleted))) {
    job.progress.destinationsCompleted = Math.max(0, Number(patch.destinationsCompleted));
  }
  if (Array.isArray(patch.destinations)) {
    job.progress.destinations = normalizeProgressDestinations(patch.destinations);
  }
  if (patch.currentDestinationId !== undefined) {
    job.progress.currentDestinationId = patch.currentDestinationId
      ? String(patch.currentDestinationId)
      : null;
  }
  if (patch.currentDestinationLabel !== undefined) {
    job.progress.currentDestinationLabel = patch.currentDestinationLabel
      ? String(patch.currentDestinationLabel)
      : null;
  }
  if (Number.isFinite(Number(patch.currentDestinationIndex))) {
    job.progress.currentDestinationIndex = Math.max(0, Number(patch.currentDestinationIndex));
  } else if (patch.currentDestinationIndex === null) {
    job.progress.currentDestinationIndex = null;
  }
  if (patch.currentStep !== undefined) {
    job.progress.currentStep = patch.currentStep ? String(patch.currentStep) : null;
  }

  const explicitPercent = Number(patch.percent);
  if (Number.isFinite(explicitPercent)) {
    job.progress.percent = Math.max(0, Math.min(100, Math.round(explicitPercent)));
  } else {
    job.progress.percent = computeDiscoverProgressPercent(
      job.stage,
      job.progress.destinationsCompleted,
      job.progress.destinationsTotal
    );
  }

  job.updatedAt = new Date().toISOString();
}

function serializeDiscoverPreviewJob(job, options = {}) {
  const includeResult = !!options.includeResult;
  if (!job) return null;
  return {
    jobId: job.jobId,
    status: job.status,
    stage: job.stage,
    message: job.message,
    progress: {
      percent: job.progress?.percent || 0,
      destinationsTotal: job.progress?.destinationsTotal || 0,
      destinationsCompleted: job.progress?.destinationsCompleted || 0,
      destinations: normalizeProgressDestinations(job.progress?.destinations || []),
      currentDestinationId: job.progress?.currentDestinationId || null,
      currentDestinationLabel: job.progress?.currentDestinationLabel || null,
      currentDestinationIndex: Number.isFinite(Number(job.progress?.currentDestinationIndex))
        ? Number(job.progress.currentDestinationIndex)
        : null,
      currentStep: job.progress?.currentStep || null,
    },
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt || null,
    error: job.error || null,
    result: includeResult ? job.result || null : undefined,
  };
}

async function runDiscoverPreviewCore(payload = {}, onProgress = null) {
  const discoverStartMs = Date.now();
  const { locations = [], userId, discoverControl = {} } = payload || {};
  const rawMinSitelinks = Number(discoverControl?.minSitelinks);
  const minSitelinks = Number.isFinite(rawMinSitelinks)
    ? Math.max(0, Math.floor(rawMinSitelinks))
    : 1;

  if (!Array.isArray(locations)) {
    throw createHttpError(400, 'locations[] must be an array');
  }

  for (const loc of locations) {
    if ((locations.length && !loc) || !loc._id || !loc.type) {
      throw createHttpError(400, 'Each location needs _id and type');
    }
  }

  const progressDestinations = locations.map((location, index) => toProgressDestination(location, index));
  const report = (patch = {}) => {
    if (typeof onProgress !== 'function') return;
    onProgress({
      ...patch,
      destinationsTotal: locations.length,
      destinations: patch.destinations || progressDestinations,
    });
  };

  report({
    stage: 'preparing',
    destinationsCompleted: 0,
    currentDestinationId: null,
    currentDestinationLabel: null,
    currentDestinationIndex: null,
    currentStep: 'init',
    message: 'Preparing your activity recommendations...',
  });

  // Fallback global: if no locations are selected, return a priority-sorted feed.
  if (locations.length === 0) {
    report({
      stage: 'collecting',
      destinationsCompleted: 0,
      currentStep: 'global-db-fetch',
      message: 'Loading activities...',
    });
    const dbFetchStartMs = Date.now();
    const dbActivities = await Activity.find({ active: true })
      .populate('tags', 'name slug')
      .sort({
        'ranking.priority': -1,
        createdAt: -1,
      })
      .limit(DISCOVER_PREVIEW_NO_LOCATIONS_LIMIT)
      .lean();
    const dbFetchMs = Date.now() - dbFetchStartMs;

    const dbCategoryIds = Array.from(
      new Set(dbActivities.flatMap((a) => collectActivityCategoryIds(a)))
    );

    let categoriesMap = new Map();
    if (dbCategoryIds.length) {
      const categories = await ActivityCategory.find({
        _id: { $in: dbCategoryIds },
      }).lean();
      categoriesMap = new Map(categories.map((c) => [String(c._id), c]));
    }

    const enrichedDb = dbActivities.map((a) => {
      const activityCategoryIds = collectActivityCategoryIds(a);
      const activityCategories = activityCategoryIds
        .map((id) => categoriesMap.get(String(id)) || null)
        .filter(Boolean);
      return {
        ...a,
        source: 'db',
        activityCategoryIds,
        activityCategories,
        activityCategory: activityCategories[0] || null,
      };
    });

    report({
      stage: 'evaluating',
      destinationsCompleted: 0,
      currentStep: 'global-ranking',
      message: 'Organizing the best options...',
    });
    const hydratedDb = await hydrateActivitiesZonePath(enrichedDb);
    const scoreStartMs = Date.now();
    const scored = await scoreActivitiesForUser(hydratedDb, userId);
    const limited = scored.slice(0, DISCOVER_PREVIEW_NO_LOCATIONS_LIMIT);
    const scoreMs = Date.now() - scoreStartMs;
    const totalMs = Date.now() - discoverStartMs;

    console.log('[discoverPreview][timing][no-locations-fallback]', {
      dbFetchMs,
      scoreMs,
      returned: limited.length,
      totalMs,
    });

    report({
      stage: 'done',
      percent: 100,
      destinationsCompleted: 0,
      currentStep: 'complete',
      message: 'Activities are ready.',
    });
    return {
      data: limited,
      meta: {
        persistedAddedCount: 0,
        skippedWithoutGeoCount: 0,
        skippedWithoutGeo: [],
        persistErrorCount: 0,
        persistErrors: [],
      },
    };
  }

  const allRows = [];
  const skippedWithoutGeo = [];
  const persistErrors = [];
  let persistedAddedCount = 0;
  const { rootClassIds, classTargetByRootId } = await loadDiscoverClassConfig();

  report({
    stage: 'collecting',
    destinationsCompleted: 0,
    currentDestinationId: null,
    currentDestinationLabel: null,
    currentDestinationIndex: null,
    currentStep: 'start',
    message: 'Searching activities for your destination...',
  });

  let completedDestinations = 0;
  for (let idx = 0; idx < locations.length; idx += 1) {
    const l = locations[idx];
    const locationStartMs = Date.now();
    const minRequired = minRequiredByZoneType(l?.type);
    const locFilter = buildActivityLocationFilter(l);
    if (!locFilter) {
      progressDestinations[idx] = {
        ...progressDestinations[idx],
        status: 'done',
      };
      completedDestinations += 1;
      report({
        stage: 'collecting',
        destinationsCompleted: completedDestinations,
        currentDestinationId: l?._id ? String(l._id) : null,
        currentDestinationLabel: l?.label || l?.name || `Destination ${idx + 1}`,
        currentDestinationIndex: idx + 1,
        currentStep: 'skip-invalid-filter',
        message: 'We could not process one destination. Continuing with the others.',
      });
      continue;
    }

    progressDestinations[idx] = {
      ...progressDestinations[idx],
      status: 'processing',
    };
    report({
      stage: 'collecting',
      destinationsCompleted: completedDestinations,
      currentDestinationId: l?._id ? String(l._id) : null,
      currentDestinationLabel: l?.label || l?.name || `Destination ${idx + 1}`,
      currentDestinationIndex: idx + 1,
      currentStep: 'db-check',
      message: 'Checking available activities...',
    });

    const dbFetchStartMs = Date.now();
    const dbActivities = await Activity.find(locFilter)
      .populate('tags', 'name slug')
      .sort({
        'ranking.priority': -1,
        createdAt: -1,
      })
      .lean();
    const dbFetchMs = Date.now() - dbFetchStartMs;

    const dbCategoryIds = Array.from(
      new Set(dbActivities.flatMap((a) => collectActivityCategoryIds(a)))
    );

    let categoriesMap = new Map();
    if (dbCategoryIds.length) {
      const categories = await ActivityCategory.find({
        _id: { $in: dbCategoryIds },
      }).lean();
      categoriesMap = new Map(categories.map((c) => [String(c._id), c]));
    }

    const enrichedDb = dbActivities.map((a) => {
      const activityCategoryIds = collectActivityCategoryIds(a);
      const activityCategories = activityCategoryIds
        .map((id) => categoriesMap.get(String(id)) || null)
        .filter(Boolean);
      return {
        ...a,
        source: 'db',
        activityCategoryIds,
        activityCategories,
        activityCategory: activityCategories[0] || null,
      };
    });

    allRows.push(...enrichedDb);

    if (dbActivities.length >= minRequired) {
      progressDestinations[idx] = {
        ...progressDestinations[idx],
        status: 'done',
        acceptedCount: dbActivities.length,
      };
      completedDestinations += 1;
      report({
        stage: 'collecting',
        destinationsCompleted: completedDestinations,
        currentDestinationId: l?._id ? String(l._id) : null,
        currentDestinationLabel: l?.label || l?.name || `Destination ${idx + 1}`,
        currentDestinationIndex: idx + 1,
        currentStep: 'db-sufficient',
        message: 'We found activities for this destination.',
      });

      console.log('[discoverPreview][timing]', {
        locationId: String(l._id),
        locationType: l.type,
        minRequired,
        fromDbOnly: true,
        dbFetchMs,
        totalLocationMs: Date.now() - locationStartMs,
      });
      continue;
    }

    const hasCompletedSearchState = await hasZoneBeenDiscoverPreviewSearched(l?._id);
    if (hasCompletedSearchState) {
      progressDestinations[idx] = {
        ...progressDestinations[idx],
        status: 'done',
        acceptedCount: dbActivities.length,
      };
      completedDestinations += 1;
      report({
        stage: 'collecting',
        destinationsCompleted: completedDestinations,
        currentDestinationId: l?._id ? String(l._id) : null,
        currentDestinationLabel: l?.label || l?.name || `Destination ${idx + 1}`,
        currentDestinationIndex: idx + 1,
        currentStep: 'skip-searched',
        message: 'Using previously prepared activities for this destination.',
      });

      console.log('[discoverPreview][timing]', {
        locationId: String(l._id),
        locationType: l.type,
        minRequired,
        fromDbOnly: true,
        skippedExternalSearchByPersistedState: true,
        dbFetchMs,
        totalLocationMs: Date.now() - locationStartMs,
      });
      continue;
    }

    report({
      stage: 'collecting',
      destinationsCompleted: completedDestinations,
      currentDestinationId: l?._id ? String(l._id) : null,
      currentDestinationLabel: l?.label || l?.name || `Destination ${idx + 1}`,
      currentDestinationIndex: idx + 1,
      currentStep: 'resolve-context',
      message: 'Verifying destination details...',
    });
    const resolveCtxStartMs = Date.now();
    const locationContext = await resolveLocationContextForPreview(l);
    const resolveCtxMs = Date.now() - resolveCtxStartMs;
    if (!locationContext?.name) {
      progressDestinations[idx] = {
        ...progressDestinations[idx],
        status: 'done',
        acceptedCount: dbActivities.length,
      };
      completedDestinations += 1;
      report({
        stage: 'collecting',
        destinationsCompleted: completedDestinations,
        currentDestinationId: l?._id ? String(l._id) : null,
        currentDestinationLabel: l?.label || l?.name || `Destination ${idx + 1}`,
        currentDestinationIndex: idx + 1,
        currentStep: 'context-missing',
        message: 'We could not verify this destination yet.',
      });
      continue;
    }

    report({
      stage: 'collecting',
      destinationsCompleted: completedDestinations,
      currentDestinationId: l?._id ? String(l._id) : null,
      currentDestinationLabel: l?.label || l?.name || `Destination ${idx + 1}`,
      currentDestinationIndex: idx + 1,
      currentStep: 'external-search',
      message: 'Searching for more activities...',
    });
    const openSearchStartMs = Date.now();
    let openCandidates = [];
    let externalSearchMode = 'configured';
    try {
      openCandidates = await wikidataTourismSearch(locationContext, null, {
        rootClassIds,
        classTargetByRootId,
      });
    } catch (primarySearchErr) {
      console.warn('[discoverPreview] primary external search failed; retrying with default class set', {
        locationId: String(l?._id || ''),
        locationType: l?.type || null,
        error: primarySearchErr?.message || primarySearchErr,
      });
      report({
        stage: 'collecting',
        destinationsCompleted: completedDestinations,
        currentDestinationId: l?._id ? String(l._id) : null,
        currentDestinationLabel: l?.label || l?.name || `Destination ${idx + 1}`,
        currentDestinationIndex: idx + 1,
        currentStep: 'external-search-retry',
        message: 'This is taking longer than expected. Retrying now...',
      });
      openCandidates = await wikidataTourismSearch(locationContext, null, {});
      externalSearchMode = 'fallback-default-classes';
    }
    const openCandidatesFiltered = openCandidates.filter(
      (row) => Number(row?._preview?.sitelinksCount || 0) >= minSitelinks
    );
    const openSearchMs = Date.now() - openSearchStartMs;
    report({
      stage: 'collecting',
      destinationsCompleted: completedDestinations,
      currentDestinationId: l?._id ? String(l._id) : null,
      currentDestinationLabel: l?.label || l?.name || `Destination ${idx + 1}`,
      currentDestinationIndex: idx + 1,
      currentStep: 'persist-candidates',
      message: 'Saving activities...',
    });
    const persistStartMs = Date.now();
    const persistedOpen = await persistOpenCandidatesForLocation(openCandidatesFiltered, l);
    const persistMs = Date.now() - persistStartMs;
    persistedAddedCount += Number(persistedOpen?.saved?.length || 0);
    allRows.push(...persistedOpen.saved);
    if (persistedOpen.skippedWithoutGeo.length) {
      skippedWithoutGeo.push(...persistedOpen.skippedWithoutGeo);
    }
    if (persistedOpen.failed.length) {
      persistErrors.push(...persistedOpen.failed);
    }
    if (persistedOpen.saved.length > 0) {
      try {
        await markZoneDiscoverPreviewSearched(l?._id);
      } catch (stateErr) {
        console.warn('[discoverPreview] could not mark zone as searched (external_search_completed)', {
          locationId: String(l?._id || ''),
          error: stateErr?.message || stateErr,
        });
      }
    } else {
      console.log('[discoverPreview] external search completed with zero new activities; search state remains active', {
        locationId: String(l?._id || ''),
      });
    }

    progressDestinations[idx] = {
      ...progressDestinations[idx],
      status: 'done',
      acceptedCount: dbActivities.length + persistedOpen.saved.length,
    };
    completedDestinations += 1;
    report({
      stage: 'collecting',
      destinationsCompleted: completedDestinations,
      currentDestinationId: l?._id ? String(l._id) : null,
      currentDestinationLabel: l?.label || l?.name || `Destination ${idx + 1}`,
      currentDestinationIndex: idx + 1,
      currentStep: 'destination-complete',
      message: 'Destination completed.',
    });

    console.log('[discoverPreview][timing]', {
      locationId: String(l._id),
      locationType: l.type,
      minRequired,
      fromDbOnly: false,
      dbFetchMs,
      resolveCtxMs,
      openSearchMs,
      externalSearchMode,
      persistMs,
      openCandidates: openCandidates.length,
      openCandidatesAfterSitelinksFilter: openCandidatesFiltered.length,
      persistedSaved: persistedOpen.saved.length,
      persistedSkippedNoGeo: persistedOpen.skippedWithoutGeo.length,
      persistedFailed: persistedOpen.failed.length,
      totalLocationMs: Date.now() - locationStartMs,
    });
  }

  const dedupMap = new Map();
  for (const a of allRows) {
    const key =
      (a.source === 'db' && a._id && `db:${String(a._id)}`) ||
      (a.source !== 'db' && a?.externalRef?.provider && a?.externalRef?.id
        ? `ext:${a.externalRef.provider}:${a.externalRef.id}`
        : null) ||
      `${a.source}:${a.slug || a.name || Math.random()}`;
    if (!dedupMap.has(key)) dedupMap.set(key, a);
  }

  report({
    stage: 'evaluating',
    destinationsCompleted: completedDestinations,
    currentDestinationId: null,
    currentDestinationLabel: null,
    currentDestinationIndex: null,
    currentStep: 'dedupe-rank',
    message: 'Organizing your results...',
  });

  const deduped = Array.from(dedupMap.values());
  const hydratedDeduped = await hydrateActivitiesZonePath(deduped);
  const scoreStartMs = Date.now();
  const scored = await scoreActivitiesForUser(hydratedDeduped, userId);
  const scoreMs = Date.now() - scoreStartMs;
  const totalMs = Date.now() - discoverStartMs;

  console.log('[discoverPreview][timing][total]', {
    locationsCount: locations.length,
    rowsBeforeDedup: allRows.length,
    rowsAfterDedup: deduped.length,
    scoreMs,
    totalMs,
  });

  report({
    stage: 'finalizing',
    destinationsCompleted: completedDestinations,
    currentDestinationId: null,
    currentDestinationLabel: null,
    currentDestinationIndex: null,
    currentStep: 'finalizing',
    message: 'Finalizing your activity list...',
  });

  report({
    stage: 'done',
    percent: 100,
    destinationsCompleted: completedDestinations,
    currentDestinationId: null,
    currentDestinationLabel: null,
    currentDestinationIndex: null,
    currentStep: 'complete',
    message: 'Activities are ready.',
  });

  return {
    data: scored,
    meta: {
      persistedAddedCount,
      skippedWithoutGeoCount: skippedWithoutGeo.length,
      skippedWithoutGeo: skippedWithoutGeo.slice(0, 20),
      persistErrorCount: persistErrors.length,
      persistErrors: persistErrors.slice(0, 20),
    },
  };
}

exports.discover = async (req, res) => exports.discoverPreview(req, res);

exports.discoverPreviewStartJob = async (req, res) => {
  try {
    cleanupDiscoverPreviewJobs();

    const payload = req.body || {};
    const locations = Array.isArray(payload.locations) ? payload.locations : [];
    if (!Array.isArray(payload.locations)) {
      return res
        .status(400)
        .json({ success: false, message: 'locations[] must be an array' });
    }
    for (const loc of locations) {
      if ((locations.length && !loc) || !loc._id || !loc.type) {
        return res.status(400).json({
          success: false,
          message: 'Each location needs _id and type',
        });
      }
    }

    const jobId = new mongoose.Types.ObjectId().toString();
    const nowIso = new Date().toISOString();
    const job = {
      jobId,
      status: 'queued',
      stage: 'preparing',
      message: stageMessageByCode('preparing'),
      progress: {
        percent: 0,
        destinationsTotal: locations.length,
        destinationsCompleted: 0,
        destinations: locations.map((loc, idx) => toProgressDestination(loc, idx)),
        currentDestinationId: null,
        currentDestinationLabel: null,
        currentDestinationIndex: null,
        currentStep: 'queued',
      },
      result: null,
      error: null,
      createdAt: nowIso,
      startedAt: null,
      updatedAt: nowIso,
      finishedAt: null,
    };
    discoverPreviewJobs.set(jobId, job);

    setImmediate(async () => {
      try {
        job.status = 'running';
        job.startedAt = new Date().toISOString();
        job.updatedAt = job.startedAt;
        updateDiscoverPreviewJobProgress(job, {
          stage: 'preparing',
          destinationsCompleted: 0,
          destinations: job.progress.destinations,
        });

        const response = await runDiscoverPreviewCore(payload, (patch) => {
          updateDiscoverPreviewJobProgress(job, patch);
        });

        job.status = 'done';
        job.result = response;
        job.finishedAt = new Date().toISOString();
        job.updatedAt = job.finishedAt;
        updateDiscoverPreviewJobProgress(job, {
          stage: 'done',
          percent: 100,
          destinationsCompleted: job.progress.destinationsTotal,
        });
      } catch (err) {
        job.status = 'failed';
        job.stage = 'failed';
        job.message = stageMessageByCode('failed');
        job.error = {
          message: err?.message || 'Unknown error',
        };
        job.finishedAt = new Date().toISOString();
        job.updatedAt = job.finishedAt;
        updateDiscoverPreviewJobProgress(job, { percent: 100 });
        console.error('Error in discoverPreviewStartJob worker:', err);
      } finally {
        cleanupDiscoverPreviewJobs();
      }
    });

    return res.status(202).json({
      success: true,
      job: serializeDiscoverPreviewJob(job),
    });
  } catch (err) {
    console.error('Error in discoverPreviewStartJob:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

exports.discoverPreviewJobStatus = async (req, res) => {
  cleanupDiscoverPreviewJobs();
  const jobId = String(req.params.jobId || '').trim();
  const job = discoverPreviewJobs.get(jobId);
  if (!job) {
    return res.status(404).json({ success: false, message: 'Job not found' });
  }
  return res.json({
    success: true,
    job: serializeDiscoverPreviewJob(job),
  });
};

exports.discoverPreviewJobResult = async (req, res) => {
  cleanupDiscoverPreviewJobs();
  const jobId = String(req.params.jobId || '').trim();
  const job = discoverPreviewJobs.get(jobId);
  if (!job) {
    return res.status(404).json({ success: false, message: 'Job not found' });
  }
  if (job.status === 'failed') {
    return res.status(422).json({
      success: false,
      message: job?.error?.message || 'Job failed',
      job: serializeDiscoverPreviewJob(job),
    });
  }
  if (job.status !== 'done' || !job.result) {
    return res.status(409).json({
      success: false,
      message: 'Job still in progress',
      job: serializeDiscoverPreviewJob(job),
    });
  }
  return res.json({
    success: true,
    data: job.result.data || [],
    meta: job.result.meta || {},
    job: serializeDiscoverPreviewJob(job),
  });
};

// ===== Discover Preview (OPEN DATA, NO Google) =====
exports.discoverPreview = async (req, res) => {
  try {
    const response = await runDiscoverPreviewCore(req.body || {});
    return res.json({
      success: true,
      data: response.data,
      meta: response.meta,
    });
  } catch (err) {
    const status = Number(err?.status) || 500;
    console.error('Error in discoverPreview:', err);
    return res.status(status).json({ success: false, message: err.message });
  }
};

// ===== Discover Preview One (OPEN DATA, search + create one activity) =====
exports.discoverPreviewOne = async (req, res) => {
  try {
    const { location = null, query = '', externalId = null, userId } = req.body || {};
    const safeQuery = String(query || '').trim();
    const safeExternalId = String(externalId || '').trim().toUpperCase();
    if (!location || !location._id || !location.type) {
      return res.status(400).json({
        success: false,
        message: 'location with _id and type is required',
      });
    }
    if ((!safeQuery || safeQuery.length < 2) && !/^Q\d+$/.test(safeExternalId)) {
      return res.status(400).json({
        success: false,
        message: 'query must have at least 2 characters or provide externalId',
      });
    }

    const locationContext = await resolveLocationContextForPreview(location);
    if (!locationContext?.name) {
      return res.status(400).json({
        success: false,
        message: 'could not resolve location context',
      });
    }

    const { rootClassIds } = await loadDiscoverClassConfig();

    const candidates = await wikidataSearchSingleActivityByText({
      term: safeQuery,
      locationInput: locationContext,
      rootClassIds,
      limit: 8,
      preferredExternalId: safeExternalId || null,
    });

    if (!candidates.length) {
      return res.json({ success: true, data: null });
    }

    const selectedCandidate =
      safeExternalId
        ? candidates.find((c) => String(c?.externalId || '').toUpperCase() === safeExternalId) || candidates[0]
        : candidates[0];

    const persisted = await persistOpenCandidatesForLocation([selectedCandidate], location);
    if (!persisted.saved.length) {
      return res.json({
        success: true,
        data: null,
        meta: {
          skippedWithoutGeoCount: persisted.skippedWithoutGeo.length,
          persistErrorCount: persisted.failed.length,
        },
      });
    }

    const activity = persisted.saved[0];
    const activityCategoryIds = collectActivityCategoryIds(activity);
    let activityCategories = [];
    if (activityCategoryIds.length) {
      activityCategories = await ActivityCategory.find({
        _id: { $in: activityCategoryIds },
      }).lean();
    }

    const enriched = {
      ...activity,
      source: 'db',
      activityCategoryIds,
      activityCategories,
      activityCategory: activityCategories[0] || null,
    };

    const hydrated = await hydrateActivitiesZonePath([enriched]);
    const scored = await scoreActivitiesForUser(hydrated, userId);
    return res.json({
      success: true,
      data: scored[0] || hydrated[0] || enriched,
    });
  } catch (err) {
    console.error('Error in discoverPreviewOne:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

exports.discoverPreviewSuggest = async (req, res) => {
  try {
    const { location = null, query = '' } = req.body || {};
    const safeQuery = String(query || '').trim();
    if (!location || !location._id || !location.type) {
      return res.status(400).json({
        success: false,
        message: 'location with _id and type is required',
      });
    }
    if (!safeQuery || safeQuery.length < 2) {
      return res.json({ success: true, data: [] });
    }

    const locationContext = await resolveLocationContextForPreview(location);
    if (!locationContext?.name) {
      return res.json({ success: true, data: [] });
    }

    const { rootClassIds } = await loadDiscoverClassConfig();

    const candidates = await wikidataSearchSingleActivityByText({
      term: safeQuery,
      locationInput: locationContext,
      rootClassIds,
      limit: 8,
    });

    const data = candidates.map((c) => ({
      externalId: c.externalId || null,
      name: c.name || '',
      description: c.description || '',
      category: Array.isArray(c?._preview?.classLabels) ? c._preview.classLabels[0] || null : null,
      distanceKm: Number.isFinite(Number(c?._preview?.distanceKm)) ? Number(c._preview.distanceKm) : null,
      sitelinksCount: Number(c?._preview?.sitelinksCount || 0),
    }));

    return res.json({ success: true, data });
  } catch (err) {
    console.error('Error in discoverPreviewSuggest:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

async function resolveLocationContextForPreview(location) {
  if (!location?._id || !location?.type) return null;

  const id = location._id;
  const fallbackName = location.label || location.name || null;
  const zoneDoc = await Zone.findById(id)
    .select('name externalId taxonomySnapshot')
    .lean();
  if (zoneDoc) {
    const canonicalType = String(
      zoneDoc?.taxonomySnapshot?.canonicalType ||
      location.type ||
      'city'
    ).trim().toLowerCase();
    return {
      name: zoneDoc?.name || fallbackName,
      type: canonicalType,
      externalId: zoneDoc?.externalId || null,
    };
  }
  return {
    name: fallbackName,
    type: location.type,
    externalId: null,
  };
}

async function persistOpenCandidatesForLocation(candidates = [], location = null) {
  if (!Array.isArray(candidates) || !candidates.length || !location) {
    return { saved: [], skippedWithoutGeo: [], failed: [] };
  }

  const baseLocObj = await resolveActivityLocationObject(location);
  const categoryByClassQidCache = new Map();
  const activeCategories = await ActivityCategory.find(
    { isActive: true, externalId: { $exists: true, $ne: null } },
    { _id: 1, externalId: 1, defaultDurationMin: 1 }
  ).lean();
  const categoryByExternalId = new Map(
    activeCategories.map((c) => [String(c.externalId || '').trim().toUpperCase(), String(c._id)])
  );
  const categoryByIdForDuration = new Map(
    activeCategories.map((c) => [String(c._id), c])
  );
  const out = [];
  const skippedWithoutGeo = [];
  const failed = [];
  const candidateZoneLocationCache = new Map();
  for (const c of candidates) {
    if (!c?.name || !c?.slug) continue;

    try {
    const locObj = await resolveCandidateSpecificZoneLocation(
      c,
      { ...baseLocObj },
      candidateZoneLocationCache
    );
    const address = typeof c?.location?.address === 'string'
      ? c.location.address.trim()
      : '';
    const addressSource = typeof c?.location?.addressSource === 'string'
      ? normalizeLocationSource(c.location.addressSource, 'manual')
      : '';
    const rawAddresses = c?.location?.addresses;
    const addressesObj =
      rawAddresses && typeof rawAddresses === 'object' && !Array.isArray(rawAddresses)
        ? rawAddresses
        : null;
    if (address) {
      locObj.address = address;
    }
    if (addressSource) {
      locObj.addressSource = addressSource;
    }
    if (addressesObj) {
      const sanitizedAddresses = {};
      for (const [lang, value] of Object.entries(addressesObj)) {
        if (!lang) continue;
        if (typeof value !== 'string') continue;
        const v = value.trim();
        if (!v) continue;
        sanitizedAddresses[String(lang).toLowerCase()] = v;
      }
      if (Object.keys(sanitizedAddresses).length > 0) {
        locObj.addresses = sanitizedAddresses;
      }
    }
    const geo = c?.location?.geo;
    const geoSource = c?.location?.geoSource;
    const geoConfidence = c?.location?.geoConfidence;
    if (geo?.type === 'Point' && Array.isArray(geo.coordinates) && geo.coordinates.length === 2) {
      const [lng, lat] = geo.coordinates;
      if (Number.isFinite(Number(lng)) && Number.isFinite(Number(lat))) {
        locObj.geo = {
          type: 'Point',
          coordinates: [Number(lng), Number(lat)],
        };
        if (geoSource) {
          locObj.geoSource = normalizeLocationSource(geoSource, 'manual');
        }
        if (geoConfidence) {
          locObj.geoConfidence = geoConfidence;
        }
      }
    }
      // Hard requirement: every activity must have coordinates.
      const hasGeo =
        locObj?.geo?.type === 'Point' &&
        Array.isArray(locObj?.geo?.coordinates) &&
        locObj.geo.coordinates.length === 2 &&
        Number.isFinite(Number(locObj.geo.coordinates[0])) &&
        Number.isFinite(Number(locObj.geo.coordinates[1]));
      if (!hasGeo) {
        skippedWithoutGeo.push({
          name: c.name,
          externalId: c.externalId || c?._preview?.placeId || null,
        });
        continue;
      }

      const externalId =
        c.externalId || c?._preview?.placeId || null;
      const externalProvider =
        c?._preview?.provider === 'wikidata' ? 'wikidata' : null;
      const externalRef =
        externalProvider && externalId
          ? {
              provider: externalProvider,
              id: String(externalId),
              url: `https://www.wikidata.org/wiki/${String(externalId)}`,
            }
          : null;

      const classIdsRaw = Array.isArray(c?._preview?.classIds) ? c._preview.classIds : [];
      const classIds = classIdsRaw
        .map((x) => String(x || '').trim().toUpperCase())
        .filter((x) => /^Q\d+$/.test(x));
      const openingHoursPayload = normalizeOpeningHoursPayload(
        c?.availability?.openingHours || null
      );
      const cacheKey = classIds.join('|');
      let activityCategoryIds = [];
      if (cacheKey) {
        if (categoryByClassQidCache.has(cacheKey)) {
          activityCategoryIds = categoryByClassQidCache.get(cacheKey);
        } else {
          activityCategoryIds = await resolveActivityCategoryIdsFromWikidataClassIds(
            classIds,
            categoryByExternalId
          );
          categoryByClassQidCache.set(cacheKey, activityCategoryIds || []);
        }
      }
      const derivedDuration = deriveDefaultDurationFromCategoryIds(
        activityCategoryIds,
        categoryByIdForDuration
      );

      let doc = null;
      if (externalRef) {
        doc = await Activity.findOne({
          'externalRef.provider': externalRef.provider,
          'externalRef.id': externalRef.id,
        }).lean();
      }
      if (!doc) {
        doc = await Activity.findOne({ slug: c.slug }).lean();
      }

      if (!doc) {
        const slug = await ensureUniqueActivitySlug(c.slug);
        try {
          doc = await Activity.create({
            name: c.name,
            slug,
            description: c.description || '',
            active: true,
            location: locObj,
            media: {
              cover: c?.media?.cover || null,
              images: Array.isArray(c?.media?.images) ? c.media.images : [],
            },
            ranking: {
              ratingAvg: c?.ranking?.ratingAvg ?? 0,
              reviewsCount: c?.ranking?.reviewsCount ?? 0,
              priority: c?.ranking?.priority ?? 100,
            },
            ...(openingHoursPayload
              ? {
                  availability: {
                    openingHours: openingHoursPayload,
                    blackoutDates: [],
                  },
                }
              : {}),
            ...(derivedDuration ? { defaultDurationMin: derivedDuration } : {}),
            ...(activityCategoryIds.length ? { activityCategoryIds } : {}),
            ...(externalRef ? { externalRef } : {}),
          });
        } catch (createErr) {
          // Concurrency-safe fallback: if a duplicate key races in, recover existing row.
          if (Number(createErr?.code) === 11000) {
            if (externalRef) {
              doc = await Activity.findOne({
                'externalRef.provider': externalRef.provider,
                'externalRef.id': externalRef.id,
              }).lean();
            }
            if (!doc) {
              doc = await Activity.findOne({
                slug,
                'location.primaryZoneId': locObj?.primaryZoneId || null,
              }).lean();
            }
          } else {
            throw createErr;
          }
          if (!doc) throw createErr;
        }
        doc = doc.toObject ? doc.toObject() : doc;
      } else {
        const update = {};
        if (!doc.description && c.description) update.description = c.description;
        if (!doc.location && Object.keys(locObj).length) {
          update.location = locObj;
        } else if (doc.location) {
          const isManualAddressProtected =
            String(doc?.location?.addressSource || '').toLowerCase() === 'manual' ||
            String(doc?.externalRef?.provider || '').toLowerCase() === 'manual';

          const existingZonePathIds = Array.isArray(doc?.location?.zonePathIds)
            ? doc.location.zonePathIds.map((z) => String(z))
            : [];
          const incomingZonePathIds = Array.isArray(locObj?.zonePathIds)
            ? locObj.zonePathIds.map((z) => String(z))
            : [];
          if (incomingZonePathIds.length) {
            const mergedZonePathIds = Array.from(new Set([...existingZonePathIds, ...incomingZonePathIds]));
            if (mergedZonePathIds.length > existingZonePathIds.length) {
              update['location.zonePathIds'] = mergedZonePathIds;
            }
          }
          if (!doc.location.primaryZoneId && locObj.primaryZoneId) {
            update['location.primaryZoneId'] = locObj.primaryZoneId;
          }
          if (!doc.location.timeZone && locObj.timeZone) update['location.timeZone'] = locObj.timeZone;
          const currentAddress = typeof doc.location.address === 'string' ? doc.location.address : '';
          const incomingAddress = typeof locObj.address === 'string' ? locObj.address : '';
          const shouldReplaceAddress =
            (!currentAddress && !!incomingAddress) ||
            (incomingAddress &&
              looksEnglishEnough(incomingAddress) &&
              !looksEnglishEnough(currentAddress)) ||
            (incomingAddress &&
              looksEnglishEnough(incomingAddress) &&
              looksEnglishEnough(currentAddress) &&
              addressDetailScore(incomingAddress) > addressDetailScore(currentAddress) + 6);
          if (!isManualAddressProtected && shouldReplaceAddress) {
            update['location.address'] = locObj.address;
            if (locObj.addressSource) {
              update['location.addressSource'] = locObj.addressSource;
            }
          }
          if (!isManualAddressProtected && !doc.location.addressSource && locObj.addressSource) {
            update['location.addressSource'] = locObj.addressSource;
          }
          const docAddresses =
            doc.location.addresses && typeof doc.location.addresses === 'object'
              ? doc.location.addresses
              : {};
          if (!isManualAddressProtected && locObj.addresses && typeof locObj.addresses === 'object') {
            const mergedAddresses = {
              ...docAddresses,
              ...locObj.addresses,
            };
            if (Object.keys(mergedAddresses).length > Object.keys(docAddresses).length) {
              update['location.addresses'] = mergedAddresses;
            }
          }
          const hasGeoInDoc =
            Array.isArray(doc?.location?.geo?.coordinates) &&
            doc.location.geo.coordinates.length === 2;
          if (!hasGeoInDoc && locObj.geo) {
            update['location.geo'] = locObj.geo;
            if (locObj.geoSource) update['location.geoSource'] = locObj.geoSource;
            if (locObj.geoConfidence) update['location.geoConfidence'] = locObj.geoConfidence;
          }
        }
        if (!doc?.media?.cover && c?.media?.cover) {
          update['media.cover'] = c.media.cover;
        }
        if (Array.isArray(c?.media?.images) && c.media.images.length) {
          const existingImages = Array.isArray(doc?.media?.images) ? doc.media.images : [];
          const byUrl = new Map();

          for (const img of existingImages) {
            const url = img?.url ? String(img.url) : null;
            if (!url) continue;
            if (!byUrl.has(url)) byUrl.set(url, img);
          }
          for (const img of c.media.images) {
            const url = img?.url ? String(img.url) : null;
            if (!url) continue;
            if (!byUrl.has(url)) byUrl.set(url, img);
          }

          const merged = Array.from(byUrl.values())
            .slice(0, 10)
            .map((img, idx) => ({
              ...img,
              order: idx,
            }));

          const currentCount = existingImages.length;
          if (currentCount < 10 && merged.length > currentCount) {
            update['media.images'] = merged;
          }
        }
        if (
          externalRef &&
          (!doc.externalRef?.provider || !doc.externalRef?.id)
        ) {
          update.externalRef = externalRef;
        }
        const existingOpening = doc?.availability?.openingHours || null;
        const hasExistingOpening = Boolean(
          existingOpening &&
            (
              (Array.isArray(existingOpening.openDays) && existingOpening.openDays.length) ||
              (typeof existingOpening.opensAt === 'string' && existingOpening.opensAt.trim()) ||
              (typeof existingOpening.closesAt === 'string' && existingOpening.closesAt.trim()) ||
              (typeof existingOpening.lastEntryAt === 'string' && existingOpening.lastEntryAt.trim()) ||
              (typeof existingOpening.rawText === 'string' && existingOpening.rawText.trim())
            )
        );
        if (!hasExistingOpening && openingHoursPayload) {
          update['availability.openingHours'] = openingHoursPayload;
        }
        const existingCategoryIds = collectActivityCategoryIds(doc);
        const mergedCategoryIds = Array.from(
          new Set([...existingCategoryIds, ...activityCategoryIds])
        );
        if (mergedCategoryIds.length > existingCategoryIds.length) {
          update.activityCategoryIds = mergedCategoryIds;
        }
        const mergedDerivedDuration = deriveDefaultDurationFromCategoryIds(
          mergedCategoryIds,
          categoryByIdForDuration
        );
        const hasManualDuration =
          doc?.defaultDurationMin?.source === 'manual' &&
          Number.isFinite(Number(doc?.defaultDurationMin?.minMinutes)) &&
          Number.isFinite(Number(doc?.defaultDurationMin?.maxMinutes));
        if (!hasManualDuration && mergedDerivedDuration) {
          const prev = normalizeDurationWindow(doc?.defaultDurationMin);
          const sameWindow =
            prev &&
            prev.minMinutes === mergedDerivedDuration.minMinutes &&
            prev.maxMinutes === mergedDerivedDuration.maxMinutes &&
            doc?.defaultDurationMin?.source === 'category';
          if (!sameWindow) {
            update.defaultDurationMin = mergedDerivedDuration;
          }
        }
        if (Object.keys(update).length) {
          doc = await Activity.findByIdAndUpdate(doc._id, { $set: update }, { new: true }).lean();
        }
      }

      out.push({
        ...doc,
        source: 'db',
        _preview: c._preview || null,
      });
    } catch (err) {
      failed.push({
        name: c?.name || null,
        externalId: c?.externalId || c?._preview?.placeId || null,
        message: err?.message || 'persist failed',
      });
      continue;
    }
  }

  return {
    saved: out,
    skippedWithoutGeo,
    failed,
  };
}

async function resolveActivityLocationObject(location) {
  if (!location?._id || !location?.type) return {};

  const loc = {};
  const zoneDoc = await Zone.findById(location._id)
    .select('_id ancestry timeZone')
    .lean();

  if (!zoneDoc) return {};
  loc.primaryZoneId = zoneDoc._id;
  loc.zonePathIds = buildZonePathIdsFromZoneDoc(zoneDoc);
  if (zoneDoc.timeZone) loc.timeZone = zoneDoc.timeZone;
  return loc;
}

function normalizeQid(value) {
  const qid = String(value || '').trim().toUpperCase();
  return /^Q\d+$/.test(qid) ? qid : null;
}

function normalizeLocaleKey(value = '') {
  const locale = String(value || '').trim().toLowerCase();
  if (!locale) return '';
  return locale.replace(/_/g, '-');
}

function toPlainLocaleMap(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  if (raw instanceof Map) return Object.fromEntries(raw.entries());
  return { ...raw };
}

function sanitizeLocaleMap(raw = {}, { slug = false } = {}) {
  const input = toPlainLocaleMap(raw);
  const out = {};
  for (const [localeRaw, valueRaw] of Object.entries(input)) {
    const locale = normalizeLocaleKey(localeRaw);
    if (!locale) continue;
    const value = slug ? slugify(valueRaw || '') : String(valueRaw || '').trim();
    if (!value) continue;
    out[locale] = value;
  }
  return out;
}

function extractLocalizedLabelsFromWikidataEntity(entity = {}) {
  const labels = entity && typeof entity === 'object' && entity.labels && typeof entity.labels === 'object'
    ? entity.labels
    : {};
  const out = {};
  for (const [localeRaw, payload] of Object.entries(labels)) {
    const locale = normalizeLocaleKey(localeRaw);
    const value = String(payload?.value || '').trim();
    if (!locale || !value) continue;
    out[locale] = value;
  }
  return out;
}

async function resolveCandidateSpecificZoneLocation(candidate, baseLocObj = {}, perRequestCache = new Map()) {
  const adminParentQid =
    normalizeQid(candidate?._preview?.adminParentId) ||
    normalizeQid((Array.isArray(candidate?._preview?.adminEntityIds) ? candidate._preview.adminEntityIds[0] : null));

  if (!adminParentQid) return baseLocObj;

  if (perRequestCache.has(adminParentQid)) {
    const cached = perRequestCache.get(adminParentQid);
    return cached ? { ...baseLocObj, ...cached } : baseLocObj;
  }

  try {
    const syncResult = await syncZoneHierarchyByQid(adminParentQid);
    const leafZoneId = normalizeObjectIdString(syncResult?.leafZoneId);

    if (!leafZoneId) {
      perRequestCache.set(adminParentQid, null);
      return baseLocObj;
    }

    const refined = await resolveActivityLocationObject({
      _id: leafZoneId,
      type: 'locality',
    });

    if (!refined?.primaryZoneId) {
      perRequestCache.set(adminParentQid, null);
      return baseLocObj;
    }

    perRequestCache.set(adminParentQid, refined);
    return { ...baseLocObj, ...refined };
  } catch (err) {
    console.warn('[activities.discover] failed to sync candidate zone hierarchy', {
      adminParentQid,
      message: err?.message || 'unknown error',
    });
    perRequestCache.set(adminParentQid, null);
    return baseLocObj;
  }
}

async function ensureUniqueActivitySlug(baseSlug) {
  const normalizedBase = slugify(baseSlug || '');
  let candidate = normalizedBase;
  let i = 2;
  while (await Activity.exists({ slug: candidate })) {
    candidate = `${normalizedBase}-${i}`;
    i += 1;
  }
  return candidate;
}


// Helper: slugify que soporta también nombres no latinos (ej. japonés).
// Si tras normalizar y limpiar no queda nada (por ejemplo, solo kanjis),
// genera un fallback seguro para evitar slugs vacíos.
function slugify(input = '') {
  const base = String(input)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // quita acentos para alfabetos latinos
    .toLowerCase()
    .trim()
    // permite letras y números de cualquier idioma, espacios y guiones
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (base) {
    return base;
  }

  // Fallback: si no queda nada (por ejemplo, solo caracteres especiales),
  // generamos un slug genérico pero no vacío.
  return `item-${Date.now()}`;
}

const ACTIVITY_TYPE_VALUES = new Set([
  'accommodation',
  'experience',
  'food_drinks',
  'transport',
  'practical',
  'practical_services',
  'place',
]);

function normalizeActivityTypeValue(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) return '';
  if (value === 'accomodation') return 'accommodation';
  if (!ACTIVITY_TYPE_VALUES.has(value)) return '';
  return value;
}

const BUSINESS_UNIT_WRITE_ROLES = new Set(['owner', 'admin', 'operator']);

function isAdminUser(req) {
  return String(req?.user?.role || '').trim().toLowerCase() === 'admin';
}

function requesterId(req) {
  return String(req?.user?._id || req?.user?.id || '').trim();
}

function normalizeOwnershipMode(raw) {
  const mode = String(raw || '').trim().toLowerCase();
  if (mode === 'global' || mode === 'business_unit') return mode;
  return '';
}

function normalizeOwnershipPayload(rawOwnership = {}) {
  if (!rawOwnership || typeof rawOwnership !== 'object' || Array.isArray(rawOwnership)) {
    return { ownership: null, error: null };
  }

  const mode = normalizeOwnershipMode(rawOwnership.mode);
  if (!mode) {
    return { ownership: null, error: 'Invalid ownership.mode. Allowed values: global, business_unit' };
  }

  const businessUnitId = normalizeObjectIdString(rawOwnership.businessUnitId);
  if (mode === 'business_unit' && !businessUnitId) {
    return { ownership: null, error: 'ownership.businessUnitId is required when ownership.mode is business_unit' };
  }

  const createdFromServiceId = normalizeObjectIdString(rawOwnership.createdFromServiceId);

  return {
    ownership: {
      mode,
      businessUnitId: mode === 'business_unit' ? businessUnitId : null,
      createdFromServiceId: createdFromServiceId || null,
    },
    error: null,
  };
}

async function hasBusinessUnitWriteAccess(req, businessUnitId) {
  const normalizedBusinessUnitId = normalizeObjectIdString(businessUnitId);
  if (!normalizedBusinessUnitId) return false;

  const bu = await BusinessUnit.findById(normalizedBusinessUnitId)
    .select('_id user teamMembers.userId teamMembers.role teamMembers.status')
    .lean();
  if (!bu?._id) return false;

  const requester = requesterId(req);
  if (!requester) return false;
  if (String(bu.user || '') === requester) return true;

  const teamMembers = Array.isArray(bu.teamMembers) ? bu.teamMembers : [];
  return teamMembers.some((member) => {
    const memberUserId = String(member?.userId || '').trim();
    const memberRole = String(member?.role || '').trim().toLowerCase();
    const memberStatus = String(member?.status || '').trim().toLowerCase();
    return (
      memberUserId &&
      memberUserId === requester &&
      memberStatus === 'active' &&
      BUSINESS_UNIT_WRITE_ROLES.has(memberRole)
    );
  });
}

async function resolveActivityWriteAccess(activityDoc, req) {
  if (!activityDoc?._id) return { allowed: false, reason: 'Activity not found' };
  if (isAdminUser(req)) return { allowed: true, backfillOwnership: null };

  const requester = requesterId(req);
  if (!requester) return { allowed: false, reason: 'Unauthorized' };

  const mode = normalizeOwnershipMode(activityDoc?.ownership?.mode || 'global') || 'global';
  const businessUnitId = normalizeObjectIdString(activityDoc?.ownership?.businessUnitId);

  if (mode === 'business_unit' && businessUnitId) {
    const hasAccess = await hasBusinessUnitWriteAccess(req, businessUnitId);
    if (hasAccess) return { allowed: true, backfillOwnership: null };
    return { allowed: false, reason: 'Forbidden: this activity belongs to another business unit' };
  }

  return { allowed: false, reason: 'Forbidden: global activities are read-only for providers' };
}

function getActivityDisplayName(activityDoc = {}) {
  return String(activityDoc?.name || '').trim() || 'Untitled activity';
}

// ===== Create =====
exports.create = async (req, res) => {
  try {
    const data = { ...req.body };

    if (!data.name) {
      return res.status(400).json({ success: false, message: 'name is required' });
    }

    if (Object.prototype.hasOwnProperty.call(data, 'type')) {
      const normalizedType = normalizeActivityTypeValue(data.type);
      if (!normalizedType) {
        return res.status(400).json({
          success: false,
          message: 'Invalid activity type',
        });
      }
      data.type = normalizedType;
    }

    // slug
    data.slug = (data.slug && String(data.slug).trim()) || slugify(data.name);

    if (!data.location) {
      data.location = {};
    }
    const normalizedLocation = await normalizeActivityLocationFromZones(data.location);
    if (!normalizedLocation) {
      return res.status(400).json({
        success: false,
        message: 'location.primaryZoneId is required and must reference an existing Zone',
      });
    }
    data.location = normalizedLocation;

    // Ensure external reference is always normalized and unique.
    const extProvider = String(data?.externalRef?.provider || '').trim().toLowerCase();
    let extId = String(data?.externalRef?.id || '').trim();
    const extUrl = String(data?.externalRef?.url || '').trim();

    if (!extProvider) {
      return res.status(400).json({
        success: false,
        message: 'externalRef.provider is required',
      });
    }

    if (extProvider === 'manual' && !extId) {
      if (!data._id) data._id = new mongoose.Types.ObjectId();
      extId = buildManualActivityExternalRefId(data._id);
    }

    if (!extId) {
      return res.status(400).json({
        success: false,
        message: 'externalRef.id is required',
      });
    }

    const existsExternal = await Activity.findOne({
      'externalRef.provider': extProvider,
      'externalRef.id': extId,
    }).select('_id').lean();
    if (existsExternal) {
      return res.status(409).json({
        success: false,
        message: 'An activity with this externalId already exists for this provider',
      });
    }
    data.externalRef = {
      ...(data.externalRef || {}),
      provider: extProvider,
      id: extId,
      url: extUrl || undefined,
    };

    // Defaults
    if (data.tags && !Array.isArray(data.tags)) data.tags = [data.tags];
    if (data.categories && !Array.isArray(data.categories)) data.categories = [data.categories];

    if (isAdminUser(req)) {
      const normalized = normalizeOwnershipPayload(data.ownership || { mode: 'global' });
      if (normalized.error) {
        return res.status(400).json({ success: false, message: normalized.error });
      }
      data.ownership = normalized.ownership || { mode: 'global', businessUnitId: null, createdFromServiceId: null };
    } else {
      const normalized = normalizeOwnershipPayload(data.ownership || {});
      if (normalized.error && !normalized.ownership) {
        return res.status(400).json({ success: false, message: normalized.error });
      }
      const ownership = normalized.ownership;
      const businessUnitId = ownership?.businessUnitId || null;
      if (!businessUnitId) {
        return res.status(400).json({
          success: false,
          message: 'ownership.businessUnitId is required for non-admin activity creation',
        });
      }
      const hasAccess = await hasBusinessUnitWriteAccess(req, businessUnitId);
      if (!hasAccess) {
        return res.status(403).json({ success: false, message: 'Forbidden: no write access to the business unit' });
      }
      data.ownership = {
        mode: 'business_unit',
        businessUnitId,
        createdFromServiceId: ownership?.createdFromServiceId || null,
      };
    }

    // Active default true if not provided
    if (typeof data.active !== 'boolean') data.active = true;

    const requiresTicket = !!data?.purchaseHint?.requiresTicket;
    if (requiresTicket) {
      return res.status(400).json({
        success: false,
        message: 'Cannot enable "Requires ticket" when creating an activity. Create and link an active service first.',
      });
    }

    // Ensure slug + primaryZoneId not duplicated
    const existsSlug = await Activity.findOne({
      slug: data.slug,
      'location.primaryZoneId': data.location?.primaryZoneId
    }).select('_id').lean();
    if (existsSlug) {
      return res.status(409).json({
        success: false,
        message: 'Slug already exists for this zone'
      });
    }

    const doc = await Activity.create(data);
    return res.status(201).json({ success: true, data: doc });
  } catch (error) {
    console.error('Error creating Activity:', error);
    const message = String(error?.message || '').trim() || 'Failed to create Activity';
    return res.status(500).json({ success: false, message, error });
  }
};

// ===== List (with filters & pagination) =====
exports.list = async (req, res) => {
  try {
    const {
      q,
      type,
      zoneId,
      audited,
      active,
      tags,
      categories,
      bookable,
      minPrice,
      maxPrice,
      limit = 50,
      offset = 0,
      sort // e.g. "priority:asc,ratingAvg:desc"
    } = req.query;

    const filter = {};

    if (q) {
      const re = new RegExp(String(q).trim(), 'i');
      filter.$or = [
        { name: re },
        { slug: re },
        { description: re }
      ];
    }

    if (type) {
      const normalizedTypes = String(type)
        .split(',')
        .map((entry) => normalizeActivityTypeValue(entry))
        .filter(Boolean);

      if (!normalizedTypes.length) {
        return res.status(400).json({
          success: false,
          message: 'Invalid activity type filter',
        });
      }

      filter.type = normalizedTypes.length === 1
        ? normalizedTypes[0]
        : { $in: Array.from(new Set(normalizedTypes)) };
    }

    if (zoneId) {
      const zoneIds = String(zoneId)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (zoneIds.length === 1) {
        filter['location.zonePathIds'] = zoneIds[0];
      } else if (zoneIds.length > 1) {
        filter['location.zonePathIds'] = { $in: zoneIds };
      }
    }

    if (audited === 'true') filter['audit.isAudited'] = true;
    if (audited === 'false') filter['audit.isAudited'] = false;

    if (active === 'true')  filter.active = true;
    if (active === 'false') filter.active = false;

    if (tags) {
      const arr = String(tags)
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .map(id => new mongoose.Types.ObjectId(id));
      if (arr.length) filter.tags = { $in: arr };
    }

    if (categories) {
      const arr = String(categories).split(',').map(s => s.trim()).filter(Boolean);
      if (arr.length) filter.categories = { $in: arr };
    }

    if (bookable === 'true')  filter.bookable = true;
    if (bookable === 'false') filter.bookable = false;

    const priceFilter = {};
    if (minPrice !== undefined) priceFilter.$gte = Number(minPrice);
    if (maxPrice !== undefined) priceFilter.$lte = Number(maxPrice);
    if (Object.keys(priceFilter).length) filter.priceFrom = priceFilter;

    // Sorting
    let sortDoc = { 'ranking.priority': 1, 'createdAt': 1 };
    if (sort) {
      sortDoc = {};
      String(sort).split(',').forEach(pair => {
        const [k, dir] = pair.split(':');
        if (!k) return;
        const keyMap = {
          priority: 'ranking.priority',
          rating: 'ranking.ratingAvg',
          reviews: 'ranking.reviewsCount',
          createdAt: 'createdAt',
          priceFrom: 'priceFrom'
        };
        const mapped = keyMap[k.trim()] || k.trim();
        sortDoc[mapped] = (dir && dir.trim().toLowerCase() === 'desc') ? -1 : 1;
      });
    }

    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const off = Math.max(parseInt(offset, 10) || 0, 0);

    const [results, total] = await Promise.all([
      Activity.find(filter)
        .populate('location.primaryZoneId', 'name externalId taxonomySnapshot')
        .populate('tags', 'name slug')
        .sort(sortDoc)
        .skip(off)
        .limit(lim)
        .lean(),
      Activity.countDocuments(filter)
    ]);

    const activityObjectIds = (Array.isArray(results) ? results : [])
      .map((row) => String(row?._id || '').trim())
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .map((id) => new mongoose.Types.ObjectId(id));

    let serviceCountByActivityId = new Map();
    if (activityObjectIds.length) {
      const counts = await Service.aggregate([
        {
          $match: {
            activityId: { $in: activityObjectIds },
            isActive: true,
          },
        },
        {
          $group: {
            _id: '$activityId',
            total: { $sum: 1 },
          },
        },
      ]);
      serviceCountByActivityId = new Map(
        (Array.isArray(counts) ? counts : []).map((row) => [
          String(row?._id || '').trim(),
          Number(row?.total || 0),
        ])
      );
    }

    const enrichedResults = (Array.isArray(results) ? results : []).map((row) => ({
      ...row,
      serviceCount: serviceCountByActivityId.get(String(row?._id || '').trim()) || 0,
    }));

    return res.status(200).json({ success: true, data: enrichedResults, total, limit: lim, offset: off });
  } catch (error) {
    console.error('Error fetching Activities:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch Activities', error });
  }
};

// ===== Get by ID =====
exports.get = async (req, res) => {
  try {
    const { id } = req.params;
    const doc = await Activity.findById(id)
      .populate('location.primaryZoneId', 'name externalId taxonomySnapshot')
      .populate('tags', 'name slug')
      .lean();

    if (!doc) return res.status(404).json({ success: false, message: 'Activity not found' });
    return res.status(200).json({ success: true, data: doc });
  } catch (error) {
    console.error('Error fetching Activity:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch Activity', error });
  }
};

// ===== Update =====
exports.update = async (req, res) => {
  try {
    const { id } = req.params;
    const data = { ...req.body };
    const current = await Activity.findById(id).select('purchaseHint ownership externalRef').lean();
    if (!current) return res.status(404).json({ success: false, message: 'Activity not found' });

    const writeAccess = await resolveActivityWriteAccess({ ...current, _id: id }, req);
    if (!writeAccess.allowed) {
      return res.status(403).json({ success: false, message: writeAccess.reason || 'Forbidden' });
    }

    // Keep slug consistent / unique if provided or if name changes w/o slug
    if (data.slug) data.slug = slugify(data.slug);
    if (!data.slug && data.name) data.slug = slugify(data.name);

    if (data.location) {
      const normalizedLocation = await normalizeActivityLocationFromZones(data.location);
      if (!normalizedLocation) {
        return res.status(400).json({
          success: false,
          message: 'location.primaryZoneId is required and must reference an existing Zone',
        });
      }
      data.location = normalizedLocation;
    }

    if (data.tags && !Array.isArray(data.tags)) data.tags = [data.tags];

    if (Object.prototype.hasOwnProperty.call(data, 'type')) {
      const normalizedType = normalizeActivityTypeValue(data.type);
      if (!normalizedType) {
        return res.status(400).json({
          success: false,
          message: 'Invalid activity type',
        });
      }
      data.type = normalizedType;
    }

    // Normalize external reference on updates as well.
    if (Object.prototype.hasOwnProperty.call(data, 'externalRef')) {
      const extPatch = data.externalRef && typeof data.externalRef === 'object' ? data.externalRef : {};
      const extProvider =
        String(
          Object.prototype.hasOwnProperty.call(extPatch, 'provider')
            ? extPatch.provider
            : current?.externalRef?.provider || ''
        )
          .trim()
          .toLowerCase();
      let extId = String(
        Object.prototype.hasOwnProperty.call(extPatch, 'id')
          ? extPatch.id
          : current?.externalRef?.id || ''
      ).trim();
      const extUrl = String(
        Object.prototype.hasOwnProperty.call(extPatch, 'url')
          ? extPatch.url
          : current?.externalRef?.url || ''
      ).trim();

      if (!extProvider) {
        return res.status(400).json({
          success: false,
          message: 'externalRef.provider is required',
        });
      }
      if (extProvider === 'manual' && !extId) {
        extId = buildManualActivityExternalRefId(id);
      }
      if (!extId) {
        return res.status(400).json({
          success: false,
          message: 'externalRef.id is required',
        });
      }

      const existsExternal = await Activity.findOne({
        _id: { $ne: id },
        'externalRef.provider': extProvider,
        'externalRef.id': extId,
      }).select('_id').lean();
      if (existsExternal) {
        return res.status(409).json({
          success: false,
          message: 'An activity with this externalId already exists for this provider',
        });
      }

      data.externalRef = {
        ...(current?.externalRef || {}),
        ...extPatch,
        provider: extProvider,
        id: extId,
        url: extUrl || undefined,
      };
    } else if (
      String(current?.externalRef?.provider || '').trim().toLowerCase() === 'manual' &&
      !String(current?.externalRef?.id || '').trim()
    ) {
      // Backfill legacy manual activities that still have empty externalRef.id.
      data.externalRef = {
        ...(current?.externalRef || {}),
        provider: 'manual',
        id: buildManualActivityExternalRefId(id),
      };
    }

    if (isAdminUser(req)) {
      if (Object.prototype.hasOwnProperty.call(data, 'ownership')) {
        const normalized = normalizeOwnershipPayload(data.ownership || {});
        if (normalized.error) {
          return res.status(400).json({ success: false, message: normalized.error });
        }
        data.ownership = normalized.ownership;
      }
    } else {
      delete data.ownership;
      if (writeAccess.backfillOwnership) {
        data.ownership = writeAccess.backfillOwnership;
      }
    }

    // Ensure slug is unique if changed
    if (data.slug) {
      const existsSlug = await Activity.findOne({ _id: { $ne: id }, slug: data.slug }).select('_id').lean();
      if (existsSlug) return res.status(409).json({ success: false, message: 'Slug already exists for Activity' });
    }

    let finalRequiresTicket = !!current?.purchaseHint?.requiresTicket;
    if (
      data?.purchaseHint &&
      Object.prototype.hasOwnProperty.call(data.purchaseHint, 'requiresTicket')
    ) {
      finalRequiresTicket = !!data.purchaseHint.requiresTicket;
    }

    if (finalRequiresTicket) {
      const hasActiveService = await hasActiveLinkedService(id);
      if (!hasActiveService) {
        return res.status(400).json({
          success: false,
          message: 'Cannot enable "Requires ticket" without at least one active linked service for this activity.',
        });
      }
    }

    const updated = await Activity.findByIdAndUpdate(id, data, { new: true, runValidators: true });
    if (!updated) return res.status(404).json({ success: false, message: 'Activity not found' });

    return res.status(200).json({ success: true, data: updated });
  } catch (error) {
    console.error('Error updating Activity:', error);
    const message = String(error?.message || '').trim() || 'Failed to update Activity';
    return res.status(500).json({ success: false, message, error });
  }
};

// ===== Acquire ownership =====
exports.acquireOwnership = async (req, res) => {
  try {
    const activityId = normalizeObjectIdString(req?.params?.id);
    if (!activityId) {
      return res.status(400).json({ success: false, message: 'Invalid activity id' });
    }

    const businessUnitId = normalizeObjectIdString(
      req?.body?.businessUnitId || req?.query?.businessUnitId
    );
    if (!businessUnitId) {
      return res.status(400).json({
        success: false,
        message: 'businessUnitId is required',
      });
    }

    const activity = await Activity.findById(activityId).lean();
    if (!activity?._id) {
      return res.status(404).json({ success: false, message: 'Activity not found' });
    }

    const requesterIsAdmin = isAdminUser(req);
    const currentMode = normalizeOwnershipMode(activity?.ownership?.mode || 'global') || 'global';
    const currentBusinessUnitId = normalizeObjectIdString(activity?.ownership?.businessUnitId);
    const sourceName = getActivityDisplayName(activity);

    if (currentMode === 'business_unit' && currentBusinessUnitId === businessUnitId) {
      return res.status(200).json({
        success: true,
        data: {
          action: 'already_owned',
          activityId: String(activity._id),
          activityName: sourceName,
          sourceActivityId: String(activity._id),
          sourceActivityName: sourceName,
          message: 'This activity already belongs to your business unit.',
        },
      });
    }

    if (!requesterIsAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Only admin can assign or reassign activity ownership to a business unit.',
      });
    }

    const businessUnitExists = await BusinessUnit.exists({ _id: businessUnitId });
    if (!businessUnitExists) {
      return res.status(404).json({
        success: false,
        message: 'Business unit not found',
      });
    }

    const nextOwnership = {
      mode: 'business_unit',
      businessUnitId,
      createdFromServiceId: normalizeObjectIdString(activity?.ownership?.createdFromServiceId) || null,
    };

    const updated = await Activity.findByIdAndUpdate(
      activityId,
      { ownership: nextOwnership },
      { new: true, runValidators: true }
    ).lean();

    const action = currentMode === 'global' ? 'assigned_by_admin' : 'reassigned_by_admin';
    const message = currentMode === 'global'
      ? 'Global activity assigned to business unit by admin.'
      : 'Activity ownership reassigned to business unit by admin.';

    return res.status(200).json({
      success: true,
      data: {
        action,
        activityId: String(updated?._id || activityId),
        activityName: getActivityDisplayName(updated || activity),
        sourceActivityId: String(activity._id),
        sourceActivityName: sourceName,
        message,
      },
    });
  } catch (error) {
    console.error('Error acquiring activity ownership:', error);
    const status = Number(error?.status) || 500;
    const message = String(error?.message || '').trim() || 'Failed to acquire activity ownership';
    return res.status(status).json({ success: false, message });
  }
};

exports.upsertNamesSlugsFromWikidata = async (req, res) => {
  try {
    const activityId = normalizeObjectIdString(req?.params?.id);
    if (!activityId) {
      return res.status(400).json({ success: false, message: 'Invalid activity id' });
    }

    const current = await Activity.findById(activityId)
      .select('_id name slug names slugs externalRef ownership')
      .lean();
    if (!current?._id) {
      return res.status(404).json({ success: false, message: 'Activity not found' });
    }

    const writeAccess = await resolveActivityWriteAccess(current, req);
    if (!writeAccess.allowed) {
      return res.status(403).json({ success: false, message: writeAccess.reason || 'Forbidden' });
    }

    const bodyQid = normalizeQid(req?.body?.qid);
    const externalQid = normalizeQid(current?.externalRef?.id);
    const qid = bodyQid || externalQid;
    if (!qid) {
      return res.status(400).json({
        success: false,
        message: 'Wikidata QID is required (body.qid or externalRef.id with QID format).',
      });
    }

    const entityMap = await wikidataGetEntitiesRaw([qid], {
      languages: ['en', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'ko', 'zh', 'ar'],
    });
    const entity = entityMap?.[qid];
    if (!entity || entity.missing) {
      return res.status(404).json({
        success: false,
        message: `No Wikidata entity found for ${qid}`,
      });
    }

    const fetchedNames = extractLocalizedLabelsFromWikidataEntity(entity);
    const existingNames = sanitizeLocaleMap(current?.names, { slug: false });
    const existingSlugs = sanitizeLocaleMap(current?.slugs, { slug: true });

    const names = { ...existingNames };
    let namesAdded = 0;
    for (const [locale, value] of Object.entries(fetchedNames)) {
      if (names[locale]) continue;
      names[locale] = value;
      namesAdded += 1;
    }
    if (!names.en && String(current?.name || '').trim()) {
      names.en = String(current.name).trim();
    }

    const slugs = { ...existingSlugs };
    let slugsAdded = 0;
    for (const [locale, value] of Object.entries(names)) {
      if (slugs[locale]) continue;
      const nextSlug = slugify(value || '');
      if (!nextSlug) continue;
      slugs[locale] = nextSlug;
      slugsAdded += 1;
    }
    if (!slugs.en && String(current?.slug || '').trim()) {
      const fallbackSlug = slugify(current.slug);
      if (fallbackSlug) {
        slugs.en = fallbackSlug;
        slugsAdded += 1;
      }
    }

    const updated = await Activity.findByIdAndUpdate(
      activityId,
      { $set: { names, slugs } },
      { new: true, runValidators: true }
    );
    if (!updated) {
      return res.status(404).json({ success: false, message: 'Activity not found' });
    }

    return res.status(200).json({
      success: true,
      data: updated,
      meta: {
        qid,
        namesAdded,
        slugsAdded,
      },
    });
  } catch (error) {
    console.error('Error upserting activity localized names/slugs from Wikidata:', error);
    const message = String(error?.message || '').trim() || 'Failed to upsert names/slugs from Wikidata';
    return res.status(500).json({ success: false, message, error });
  }
};

// ===== Deactivate (soft delete) =====
exports.deactivate = async (req, res) => {
  try {
    const { id } = req.params;
    const current = await Activity.findById(id).select('_id ownership').lean();
    if (!current) return res.status(404).json({ success: false, message: 'Activity not found' });
    const writeAccess = await resolveActivityWriteAccess(current, req);
    if (!writeAccess.allowed) {
      return res.status(403).json({ success: false, message: writeAccess.reason || 'Forbidden' });
    }
    const updated = await Activity.findByIdAndUpdate(id, { active: false }, { new: true });
    if (!updated) return res.status(404).json({ success: false, message: 'Activity not found' });
    return res.status(200).json({ success: true, data: updated });
  } catch (error) {
    console.error('Error deactivating Activity:', error);
    return res.status(500).json({ success: false, message: 'Failed to deactivate Activity', error });
  }
};

// ===== Restore =====
exports.restore = async (req, res) => {
  try {
    const { id } = req.params;
    const current = await Activity.findById(id).select('_id ownership').lean();
    if (!current) return res.status(404).json({ success: false, message: 'Activity not found' });
    const writeAccess = await resolveActivityWriteAccess(current, req);
    if (!writeAccess.allowed) {
      return res.status(403).json({ success: false, message: writeAccess.reason || 'Forbidden' });
    }
    const updated = await Activity.findByIdAndUpdate(id, { active: true }, { new: true });
    if (!updated) return res.status(404).json({ success: false, message: 'Activity not found' });
    return res.status(200).json({ success: true, data: updated });
  } catch (error) {
    console.error('Error restoring Activity:', error);
    return res.status(500).json({ success: false, message: 'Failed to restore Activity', error });
  }
};

// ===== Hard delete =====
exports.remove = async (req, res) => {
  try {
    const { id } = req.params;
    const current = await Activity.findById(id).select('_id ownership').lean();
    if (!current) return res.status(404).json({ success: false, message: 'Activity not found' });
    const writeAccess = await resolveActivityWriteAccess(current, req);
    if (!writeAccess.allowed) {
      return res.status(403).json({ success: false, message: writeAccess.reason || 'Forbidden' });
    }
    const deleted = await Activity.findByIdAndDelete(id);
    if (!deleted) return res.status(404).json({ success: false, message: 'Activity not found' });
    return res.status(200).json({ success: true, message: 'Activity deleted permanently' });
  } catch (error) {
    console.error('Error deleting Activity:', error);
    return res.status(500).json({ success: false, message: 'Failed to delete Activity', error });
  }
};
