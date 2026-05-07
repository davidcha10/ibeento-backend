const mongoose = require('mongoose');
const crypto = require('crypto');
const Activity = require('../models/Activity');
const BusinessUnit = require('../models/BusinessUnit');
const Zone = require('../models/Zone');
const ActivityCategory = require('../models/ActivityCategory');
const DiscoverPreviewJob = require('../models/DiscoverPreviewJob');
const SocialImportLink = require('../models/SocialImportLink');
const UserFavorite = require('../models/UserFavorite');
const { Service } = require('../models/Service');
const { syncZoneHierarchyByQid } = require('./location.controller');
const googlePlacesService = require('../services/google-places.service');
const geminiService = require('../services/gemini.service');


const {
  resolveActivityCategoryIdsFromWikidataClassIds,
} = require('../utils/categories-definer.helper');
const { scoreActivitiesForUser } = require('../services/activity/activity-scoring.service');
const {
  wikidataTourismSearch,
  wikidataSearchSingleActivityByText,
  wikidataGetEntitiesRaw,
} = require('../services/activity/open-source.service');
const {
  buildGoogleCachePayload,
  calculatePriorityFromGoogleCache,
  isGoogleCacheExpired,
  activityHasCanonicalData,
  refreshGoogleCacheByPlaceId,
  validGeoPoint,
} = require('../services/activity/google-cache-maintenance.service');

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

const DISCOVER_PREVIEW_NO_LOCATIONS_LIMIT = 50;
const DISCOVER_PREVIEW_WORKER_TICK_MS = Number(process.env.DISCOVER_PREVIEW_WORKER_TICK_MS || 2000);
const DISCOVER_PREVIEW_WORKER_LOCK_MS = Number(process.env.DISCOVER_PREVIEW_WORKER_LOCK_MS || (2 * 60 * 1000));
const DISCOVER_PREVIEW_WORKER_RETRY_BASE_MS = Number(process.env.DISCOVER_PREVIEW_WORKER_RETRY_BASE_MS || 30000);
const DISCOVER_PREVIEW_WORKER_RETRY_MAX_MS = Number(process.env.DISCOVER_PREVIEW_WORKER_RETRY_MAX_MS || (15 * 60 * 1000));
const DISCOVER_PREVIEW_WORKER_MAX_TOTAL_MS = Number(process.env.DISCOVER_PREVIEW_WORKER_MAX_TOTAL_MS || (60 * 60 * 1000));

let discoverPreviewWorkerTimer = null;
let discoverPreviewWorkerInFlight = false;

function normalizeDiscoverJobLocationKey(loc = {}) {
  const rawId =
    loc?._id ||
    loc?.id ||
    loc?.zoneId ||
    loc?.primaryZoneId ||
    null;
  const id = String(rawId || '').trim();
  const type = String(loc?.type || '').trim().toLowerCase();
  if (!id || !type) return null;
  return { id, type };
}

function buildDiscoverPreviewJobRequestKey(payload = {}) {
  const minSitelinksRaw = Number(payload?.discoverControl?.minSitelinks);
  const minSitelinks = Number.isFinite(minSitelinksRaw)
    ? Math.max(0, Math.floor(minSitelinksRaw))
    : 1;

  const normalizedLocations = (Array.isArray(payload?.locations) ? payload.locations : [])
    .map((loc) => normalizeDiscoverJobLocationKey(loc))
    .filter(Boolean)
    .sort((a, b) => {
      const idCmp = String(a.id).localeCompare(String(b.id));
      if (idCmp !== 0) return idCmp;
      return String(a.type).localeCompare(String(b.type));
    });

  return JSON.stringify({
    minSitelinks,
    locations: normalizedLocations,
  });
}

async function findReusableDiscoverPreviewJobByRequestKey(requestKey = '') {
  if (!requestKey) return null;
  const jobs = await DiscoverPreviewJob.find({ requestKey })
    .sort({ updatedAt: -1, createdAt: -1 })
    .lean();
  if (!jobs.length) return null;

  const active = jobs.find((job) => job?.status === 'running' || job?.status === 'queued');
  if (active) return active;

  const done = jobs.find((job) => job?.status === 'done' && job?.result);
  if (done) return done;

  return jobs[0] || null;
}

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
  const createdAt = job.createdAt ? new Date(job.createdAt).toISOString() : new Date().toISOString();
  const startedAt = job.startedAt ? new Date(job.startedAt).toISOString() : null;
  const updatedAt = job.updatedAt ? new Date(job.updatedAt).toISOString() : createdAt;
  const finishedAt = job.finishedAt ? new Date(job.finishedAt).toISOString() : null;
  return {
    jobId: job.jobId,
    requestKey: job.requestKey || null,
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
    createdAt,
    startedAt,
    updatedAt,
    finishedAt,
    error: job.error || null,
    result: includeResult ? job.result || null : undefined,
  };
}

function sanitizeDiscoverPreviewPayload(payload = {}) {
  const rawMinSitelinks = Number(payload?.discoverControl?.minSitelinks);
  const minSitelinks = Number.isFinite(rawMinSitelinks)
    ? Math.max(0, Math.floor(rawMinSitelinks))
    : 1;

  const locations = (Array.isArray(payload?.locations) ? payload.locations : [])
    .map((loc) => {
      if (!loc || typeof loc !== 'object') return null;
      const id = String(loc?._id || loc?.id || loc?.zoneId || loc?.primaryZoneId || '').trim();
      const type = String(loc?.type || '').trim();
      if (!id || !type) return null;
      return {
        _id: id,
        type,
        label: String(loc?.label || loc?.name || '').trim(),
        name: String(loc?.name || loc?.label || '').trim(),
      };
    })
    .filter(Boolean);

  // Discover se vuelve totalmente backend-owned y no depende de un usuario en sesión.
  return {
    locations,
    discoverControl: { minSitelinks },
  };
}

async function claimNextDiscoverPreviewJobForWorker() {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - DISCOVER_PREVIEW_WORKER_LOCK_MS);
  const lockToken = new mongoose.Types.ObjectId().toString();

  const claimed = await DiscoverPreviewJob.findOneAndUpdate(
    {
      $or: [
        { status: 'queued', nextRunAt: { $lte: now } },
        { status: 'running', lockedAt: { $lt: staleBefore } },
      ],
    },
    {
      $set: {
        status: 'running',
        lockToken,
        lockedAt: now,
        startedAt: now,
        finishedAt: null,
      },
      $unset: {
        error: '',
      },
    },
    {
      sort: { nextRunAt: 1, updatedAt: 1 },
      new: true,
    }
  ).lean();

  return claimed || null;
}

async function persistDiscoverPreviewJobProgress(jobState, lockToken) {
  if (!jobState?.jobId || !lockToken) return;
  await DiscoverPreviewJob.updateOne(
    { jobId: String(jobState.jobId), lockToken: String(lockToken) },
    {
      $set: {
        stage: jobState.stage,
        message: jobState.message,
        progress: jobState.progress,
        lockedAt: new Date(),
      },
    }
  );
}

async function processDiscoverPreviewJob(claimedJob) {
  if (!claimedJob?.jobId || !claimedJob?.lockToken) return;

  if (hasDiscoverCycleExceededMax(claimedJob)) {
    const elapsedSec = Math.round(getDiscoverCycleElapsedMs(claimedJob) / 1000);
    await DiscoverPreviewJob.updateOne(
      { jobId: String(claimedJob.jobId), lockToken: String(claimedJob.lockToken) },
      {
        $set: {
          status: 'failed',
          stage: 'failed',
          message: 'This search exceeded the 1-hour processing limit.',
          error: { message: `Discover search exceeded max duration (${elapsedSec}s)` },
          lastErrorAt: new Date(),
          finishedAt: new Date(),
          nextRunAt: null,
          lockedAt: null,
          lockToken: null,
        },
      }
    );
    return;
  }

  const jobState = {
    jobId: String(claimedJob.jobId),
    requestKey: claimedJob.requestKey || null,
    payload: sanitizeDiscoverPreviewPayload(claimedJob.payload || {}),
    status: 'running',
    stage: String(claimedJob.stage || 'preparing'),
    message: String(claimedJob.message || stageMessageByCode('preparing')),
    progress: {
      percent: Number(claimedJob?.progress?.percent || 0),
      destinationsTotal: Number(claimedJob?.progress?.destinationsTotal || 0),
      destinationsCompleted: Number(claimedJob?.progress?.destinationsCompleted || 0),
      destinations: normalizeProgressDestinations(claimedJob?.progress?.destinations || []),
      currentDestinationId: claimedJob?.progress?.currentDestinationId || null,
      currentDestinationLabel: claimedJob?.progress?.currentDestinationLabel || null,
      currentDestinationIndex: Number.isFinite(Number(claimedJob?.progress?.currentDestinationIndex))
        ? Number(claimedJob.progress.currentDestinationIndex)
        : null,
      currentStep: claimedJob?.progress?.currentStep || null,
    },
  };

  const lockToken = String(claimedJob.lockToken);
  const heartbeatMs = Math.max(5000, Math.floor(DISCOVER_PREVIEW_WORKER_LOCK_MS / 6));
  const heartbeat = setInterval(() => {
    DiscoverPreviewJob.updateOne(
      { jobId: jobState.jobId, lockToken },
      { $set: { lockedAt: new Date() } }
    ).catch(() => {});
  }, heartbeatMs);

  try {
    updateDiscoverPreviewJobProgress(jobState, {
      stage: 'preparing',
      destinationsCompleted: 0,
      destinations: jobState.progress.destinations,
    });
    await persistDiscoverPreviewJobProgress(jobState, lockToken);

    const response = await runDiscoverPreviewCore(jobState.payload, (patch) => {
      updateDiscoverPreviewJobProgress(jobState, patch);
      persistDiscoverPreviewJobProgress(jobState, lockToken).catch((err) => {
        console.warn('[discoverPreview][worker] could not persist progress patch', err?.message || err);
      });
    });

    updateDiscoverPreviewJobProgress(jobState, {
      stage: 'done',
      percent: 100,
      destinationsCompleted: jobState.progress.destinationsTotal,
    });

    await DiscoverPreviewJob.updateOne(
      { jobId: jobState.jobId, lockToken },
      {
        $set: {
          status: 'done',
          stage: jobState.stage,
          message: jobState.message,
          progress: jobState.progress,
          result: response,
          finishedAt: new Date(),
          nextRunAt: null,
          lockedAt: null,
          lockToken: null,
          error: null,
        },
      }
    );
  } catch (err) {
    const nextAttempts = Number(claimedJob?.attempts || 0) + 1;
    const elapsedMs = getDiscoverCycleElapsedMs(claimedJob);
    const reachedMaxDuration = elapsedMs >= DISCOVER_PREVIEW_WORKER_MAX_TOTAL_MS;
    const retryDelayMs = Math.min(
      DISCOVER_PREVIEW_WORKER_RETRY_MAX_MS,
      DISCOVER_PREVIEW_WORKER_RETRY_BASE_MS * Math.pow(2, Math.max(0, nextAttempts - 1))
    );
    const nextRunAt = new Date(Date.now() + retryDelayMs);
    const retryInSec = Math.max(1, Math.round(retryDelayMs / 1000));

    if (reachedMaxDuration) {
      await DiscoverPreviewJob.updateOne(
        { jobId: jobState.jobId, lockToken },
        {
          $set: {
            status: 'failed',
            stage: 'failed',
            message: 'This search exceeded the 1-hour processing limit.',
            error: { message: err?.message || 'Discover search exceeded max duration' },
            lastErrorAt: new Date(),
            finishedAt: new Date(),
            nextRunAt: null,
            lockedAt: null,
            lockToken: null,
          },
          $inc: { attempts: 1 },
        }
      );
      console.error('[discoverPreview][worker] job failed and hit max duration; stopping retries', err);
      return;
    }

    await DiscoverPreviewJob.updateOne(
      { jobId: jobState.jobId, lockToken },
      {
        $set: {
          status: 'queued',
          stage: 'failed',
          message: `Retrying automatically in ${retryInSec} seconds...`,
          error: { message: err?.message || 'Unknown error' },
          lastErrorAt: new Date(),
          nextRunAt,
          lockedAt: null,
          lockToken: null,
        },
        $inc: { attempts: 1 },
      }
    );
    console.error('[discoverPreview][worker] job failed, queued for retry', err);
  } finally {
    clearInterval(heartbeat);
  }
}

async function discoverPreviewWorkerTick() {
  if (discoverPreviewWorkerInFlight) return;
  discoverPreviewWorkerInFlight = true;
  try {
    const claimed = await claimNextDiscoverPreviewJobForWorker();
    if (!claimed) return;
    await processDiscoverPreviewJob(claimed);
  } catch (err) {
    console.error('[discoverPreview][worker] tick error', err);
  } finally {
    discoverPreviewWorkerInFlight = false;
  }
}

function startDiscoverPreviewPersistentWorker() {
  if (discoverPreviewWorkerTimer) return;
  discoverPreviewWorkerTimer = setInterval(discoverPreviewWorkerTick, DISCOVER_PREVIEW_WORKER_TICK_MS);
  setImmediate(() => {
    discoverPreviewWorkerTick().catch(() => {});
  });
}

function getDiscoverCycleStartedAtMs(job = {}) {
  const cycleMs = new Date(job?.cycleStartedAt || 0).getTime();
  if (Number.isFinite(cycleMs) && cycleMs > 0) return cycleMs;
  const createdMs = new Date(job?.createdAt || 0).getTime();
  if (Number.isFinite(createdMs) && createdMs > 0) return createdMs;
  return Date.now();
}

function getDiscoverCycleElapsedMs(job = {}) {
  return Math.max(0, Date.now() - getDiscoverCycleStartedAtMs(job));
}

function hasDiscoverCycleExceededMax(job = {}) {
  return getDiscoverCycleElapsedMs(job) >= DISCOVER_PREVIEW_WORKER_MAX_TOTAL_MS;
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
    const rawPayload = req.body || {};
    if (!Array.isArray(rawPayload.locations)) {
      return res
        .status(400)
        .json({ success: false, message: 'locations[] must be an array' });
    }
    const payload = sanitizeDiscoverPreviewPayload(rawPayload);
    const locations = Array.isArray(payload.locations) ? payload.locations : [];
    for (const loc of locations) {
      if ((locations.length && !loc) || !loc._id || !loc.type) {
        return res.status(400).json({
          success: false,
          message: 'Each location needs _id and type',
        });
      }
    }
    if (rawPayload.locations.length !== locations.length) {
      return res.status(400).json({
        success: false,
        message: 'Each location needs _id and type',
      });
    }

    const requestKey = buildDiscoverPreviewJobRequestKey(payload);
    const reusableJob = await findReusableDiscoverPreviewJobByRequestKey(requestKey);
    if (reusableJob?.status === 'running' || reusableJob?.status === 'queued') {
      startDiscoverPreviewPersistentWorker();
      return res.status(202).json({
        success: true,
        reused: true,
        job: serializeDiscoverPreviewJob(reusableJob),
      });
    }
    if (reusableJob?.status === 'failed' && reusableJob?.jobId) {
      await DiscoverPreviewJob.updateOne(
        { jobId: String(reusableJob.jobId) },
        {
          $set: {
            status: 'queued',
            stage: 'preparing',
            message: stageMessageByCode('preparing'),
            nextRunAt: new Date(),
            lockedAt: null,
            lockToken: null,
            finishedAt: null,
            payload,
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
            cycleStartedAt: new Date(),
            attempts: 0,
            startedAt: null,
            lastErrorAt: null,
          },
        }
      );
      const requeued = await DiscoverPreviewJob.findOne({ jobId: String(reusableJob.jobId) }).lean();
      startDiscoverPreviewPersistentWorker();
      return res.status(202).json({
        success: true,
        reused: true,
        requeued: true,
        job: serializeDiscoverPreviewJob(requeued || reusableJob),
      });
    }

    const jobId = new mongoose.Types.ObjectId().toString();
    const createdDoc = await DiscoverPreviewJob.create({
      jobId,
      requestKey,
      payload,
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
      attempts: 0,
      cycleStartedAt: new Date(),
      nextRunAt: new Date(),
      lockedAt: null,
      lockToken: null,
      startedAt: null,
      finishedAt: null,
    });

    startDiscoverPreviewPersistentWorker();

    return res.status(202).json({
      success: true,
      job: serializeDiscoverPreviewJob(createdDoc.toObject()),
    });
  } catch (err) {
    console.error('Error in discoverPreviewStartJob:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

exports.discoverPreviewJobStatus = async (req, res) => {
  try {
    const jobId = String(req.params.jobId || '').trim();
    const job = await DiscoverPreviewJob.findOne({ jobId }).lean();
    if (!job) {
      return res.status(404).json({ success: false, message: 'Job not found' });
    }
    return res.json({
      success: true,
      job: serializeDiscoverPreviewJob(job),
    });
  } catch (err) {
    console.error('Error in discoverPreviewJobStatus:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

exports.discoverPreviewJobResult = async (req, res) => {
  try {
    const jobId = String(req.params.jobId || '').trim();
    const job = await DiscoverPreviewJob.findOne({ jobId }).lean();
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
      data: Array.isArray(job?.result?.data) ? job.result.data : [],
      meta: job?.result?.meta || {},
      job: serializeDiscoverPreviewJob(job),
    });
  } catch (err) {
    console.error('Error in discoverPreviewJobResult:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ===== Discover Preview (OPEN DATA, NO Google) =====
exports.discoverPreview = async (req, res) => {
  try {
    const { locations = [], userId } = req.body || {};

    if (!Array.isArray(locations)) {
      return res.status(400).json({ success: false, message: 'locations[] must be an array' });
    }
    for (const loc of locations) {
      if ((locations.length && !loc) || !loc._id || !loc.type) {
        return res.status(400).json({ success: false, message: 'Each location needs _id and type' });
      }
    }

    if (locations.length === 0) {
      const dbActivities = await Activity.find({ active: true })
        .populate('tags', 'name slug')
        .sort({ 'ranking.priority': -1, createdAt: -1 })
        .limit(80)
        .lean();

      const dbCategoryIds = Array.from(new Set(dbActivities.flatMap((a) => collectActivityCategoryIds(a))));
      let categoriesMap = new Map();
      if (dbCategoryIds.length) {
        const categories = await ActivityCategory.find({ _id: { $in: dbCategoryIds } }).lean();
        categoriesMap = new Map(categories.map((c) => [String(c._id), c]));
      }
      const enriched = dbActivities.map((a) => {
        const activityCategoryIds = collectActivityCategoryIds(a);
        const activityCategories = activityCategoryIds.map((id) => categoriesMap.get(String(id)) || null).filter(Boolean);
        return { ...a, source: 'db', activityCategoryIds, activityCategories, activityCategory: activityCategories[0] || null };
      });
      const hydrated = await hydrateActivitiesZonePath(enriched);
      const scored = await scoreActivitiesForUser(hydrated, userId);
      return res.json({ success: true, data: scored, meta: { needsPopulation: [] } });
    }

    const allRows = [];
    const needsPopulation = [];

    for (const l of locations) {
      const locFilter = buildActivityLocationFilter(l);
      if (!locFilter) continue;

      const dbActivities = await Activity.find(locFilter)
        .populate('tags', 'name slug')
        .sort({ 'ranking.priority': -1, createdAt: -1 })
        .lean();

      const dbCategoryIds = Array.from(new Set(dbActivities.flatMap((a) => collectActivityCategoryIds(a))));
      let categoriesMap = new Map();
      if (dbCategoryIds.length) {
        const categories = await ActivityCategory.find({ _id: { $in: dbCategoryIds } }).lean();
        categoriesMap = new Map(categories.map((c) => [String(c._id), c]));
      }
      const enriched = dbActivities.map((a) => {
        const activityCategoryIds = collectActivityCategoryIds(a);
        const activityCategories = activityCategoryIds.map((id) => categoriesMap.get(String(id)) || null).filter(Boolean);
        return { ...a, source: 'db', activityCategoryIds, activityCategories, activityCategory: activityCategories[0] || null };
      });
      allRows.push(...enriched);

      const minRequired = minRequiredByZoneType(l?.type);
      if (dbActivities.length >= minRequired) continue;

      const hasBeenSearched = await hasZoneBeenDiscoverPreviewSearched(l?._id);
      if (hasBeenSearched) continue;

      needsPopulation.push({ _id: String(l._id), type: l.type, label: l.label || l.name || '' });
    }

    const hydrated = await hydrateActivitiesZonePath(allRows);
    const scored = await scoreActivitiesForUser(hydrated, userId);

    return res.json({
      success: true,
      data: scored,
      meta: { needsPopulation },
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

exports.importSocialActivities = async (req, res) => {
  try {
    const payload = req.body || {};
    const url = String(payload?.url || '').trim();
    const imageBase64 = String(payload?.imageBase64 || '').trim() || null;
    const imageMimeType = String(payload?.imageMimeType || 'image/jpeg').trim();
    const source = normalizeSocialImportSource(payload?.source, url);
    const now = new Date();
    const requester = normalizeObjectIdString(req?.user?._id || req?.user?.id);
    const bypassCache = payload?.bypassCache === true || payload?.refresh === true;

    const normalizedUrl = normalizeSocialImportUrl(url) || null;
    const postId = normalizedUrl ? extractSocialPostId(normalizedUrl) : null;

    // 1. Cache: si el link ya fue procesado y tiene activities guardadas → retornar
    const cachedLink = !bypassCache && normalizedUrl
      ? await SocialImportLink.findOne({ normalizedUrl }).lean()
      : null;
    const cachedActivities = await resolveCachedSocialImportActivities(cachedLink);
    if (cachedActivities.length) {
      await recordSocialImportLinkUsage({ normalizedUrl, originalUrl: url, source, postId, userId: requester, now });
      return res.status(200).json({
        success: true,
        data: cachedActivities,
        meta: { cached: true, linkId: String(cachedLink._id), source, location: null },
      });
    }

    // 2. Enriquecer texto con metadata del URL (caption de Instagram, etc.)
    const fetchedText = await buildSocialImportResolverText(payload, { source, url });
    const aiInput = buildSocialImportAiExtractionInput(payload, fetchedText);

    // 3. Extracción con Gemini (texto primero → imagen fallback)
    let labels = [];
    let extractionMethod = 'none';
    let aiLocationContext = null;
    try {
      const primaryGeminiResult = await geminiService.extractPlacesFromSocialContent({
        text: aiInput.primaryText,
        imageBase64: imageBase64 || null,
        mimeType: imageMimeType,
      });

      let geminiResult = primaryGeminiResult;
      if (!geminiResult?.places?.length && aiInput.audioText) {
        geminiResult = await geminiService.extractPlacesFromSocialContent({
          text: aiInput.fallbackAudioText,
          imageBase64: imageBase64 || null,
          mimeType: imageMimeType,
        });
        extractionMethod = `ai_${geminiResult.method}_audio_fallback`;
      } else {
        extractionMethod = `ai_${geminiResult?.method || 'none'}`;
      }

      labels = normalizeGeminiPlaceCandidates(geminiResult?.places);
      const locationResult = await geminiService.extractLocationContextFromSocialContent({
        text: geminiResult?.places?.length ? aiInput.primaryText : aiInput.fallbackAudioText,
      });
      aiLocationContext = locationResult?.location || null;
    } catch (err) {
      console.warn('[social-import] Gemini extraction failed', err?.message);
    }

    if (!labels.length) {
      return res.status(400).json({
        success: false,
        message: 'No place candidates were found in the shared content.',
        meta: { extractionMethod },
      });
    }

    // 3. Resolver contexto de ubicación
    const location = await resolveSocialImportLocation({ ...payload, candidates: labels });
    const locationContext = location?._id ? await resolveLocationContextForPreview(location) : null;

    // 4. Para cada label: BD primero → Google Places si no está en BD
    const results = [];
    const unresolved = [];
    const seenPlaceIds = new Set();
    const maxCandidates = Math.min(labels.length, 10);

    for (const item of labels.slice(0, maxCandidates)) {
      const query = String(item?.label || '').trim();
      if (!query) continue;
      // Descartar labels que son direcciones de calle (ej: "21 donggyo-ro 34-gil, Mapo-gu")
      if (isStreetAddressLabel(query)) {
        unresolved.push({ label: query, reason: 'street_address_ignored' });
        continue;
      }
      try {
        const searchQuery = buildSocialImportGoogleSearchQuery(query, item, locationContext, aiLocationContext);
        const cachePlaces = await googlePlacesService.searchTextForPlaceCache({
          textQuery: searchQuery,
          maxResultCount: 10,
        });
        const match = pickBestGoogleCachePlace(
          cachePlaces,
          query,
          locationContext?.name || aiInput.primaryText,
          { ...item, aiLocationContext }
        );
        if (!match?.place) {
          unresolved.push({ label: query, reason: 'no_google_place_match' });
          continue;
        }

        const googleCache = buildGoogleCachePayload(match.place);
        const placeId = String(googleCache?.placeId || '').trim();

        // Dedup: descartar si ya procesamos este placeId en este request
        if (placeId && seenPlaceIds.has(placeId)) {
          unresolved.push({ label: query, reason: 'duplicate_place' });
          continue;
        }
        if (placeId) seenPlaceIds.add(placeId);

        // Buscar en BD: primero por placeId exacto, luego por geo/slug
        let existingActivity = placeId
          ? await Activity.findOne({ 'googleCache.placeId': placeId }).lean()
          : null;
        if (!existingActivity) {
          existingActivity = await findExistingActivityForGoogleCache(googleCache, query, location);
        }
        if (existingActivity?._id) {
          existingActivity = await Activity.findById(existingActivity._id).lean() || existingActivity;
        }

        results.push({
          ...(existingActivity || {
            name: googleCache.name || query,
            type: inferActivityTypeFromGoogleTypes(googleCache.types),
          }),
          googleCache,
          media: existingActivity?.media || buildSocialImportPreviewMedia(match.place, req),
          _socialImport: {
            exists: !!existingActivity?._id,
            existingActivityId: existingActivity?._id ? String(existingActivity._id) : undefined,
            confidence: match.confidence,
            originalLabel: query,
            previewOnly: true,
          },
        });
      } catch (err) {
        unresolved.push({ label: query, reason: err?.message || 'search_failed' });
      }
    }

    if (!results.length) {
      return res.status(422).json({
        success: false,
        message: 'No candidates could be resolved with Google Places.',
        meta: { location, extractionMethod, unresolved },
      });
    }

    // 5. Guardar extracción en SocialImportLink (sólo metadata, sin resolvedActivities todavía)
    if (normalizedUrl) {
      await SocialImportLink.findOneAndUpdate(
        { normalizedUrl },
        {
          $set: {
            source,
            postId,
            'extraction.status': 'pending',
            'extraction.method': extractionMethod,
            'extraction.fetchedAt': now,
            'extraction.candidates': labels.map((l) => ({
              name: l.label,
              confidence: l.confidence === 'high' ? 0.9 : l.confidence === 'medium' ? 0.6 : 0.3,
              type: 'exact_place',
            })),
          },
          $addToSet: { originalUrls: url },
        },
        { upsert: true, new: true }
      ).lean();
    }

    return res.status(200).json({
      success: true,
      data: results,
      meta: {
        cached: false,
        source,
        location,
        extractionMethod,
        receivedCandidates: labels.length,
        resolvedCount: results.length,
        unresolved,
      },
    });
  } catch (err) {
    console.error('Error importing social activities:', err);
    return res.status(500).json({ success: false, message: err?.message || 'Failed to import social activities' });
  }
};

exports.saveSocialImportFavorites = async (req, res) => {
  try {
    const payload = req.body || {};
    const userId = normalizeObjectIdString(req?.user?._id || req?.user?.id);
    const url = String(payload?.url || '').trim();
    const source = normalizeSocialImportSource(payload?.source, url);
    const places = Array.isArray(payload?.places) ? payload.places : [];
    const location = payload?.location || null;
    const now = new Date();

    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }
    if (!places.length) {
      return res.status(400).json({ success: false, message: 'No places selected' });
    }

    const normalizedUrl = normalizeSocialImportUrl(url) || null;
    const postId = normalizedUrl ? extractSocialPostId(normalizedUrl) : null;
    const locationContext = location?._id ? await resolveLocationContextForPreview(location) : null;
    const baseLocObj = location?._id ? await resolveActivityLocationObject(location) : {};

    const savedActivityIds = [];
    const failedPlaces = [];

    for (const [placeIndex, place] of places.entries()) {
      try {
        // Si ya tiene _id está en BD, solo necesitamos el ID
        let activityId = normalizeObjectIdString(
          place?._id || place?._socialImport?.existingActivityId
        );

        // Si no tiene _id hay que crear la activity
        if (!activityId) {
          const googleCache = place?.googleCache;
          const placeId = String(googleCache?.placeId || '').trim();
          const label = String(place?.name || googleCache?.name || '').trim();

          if (!label || !placeId) continue;

          // Double-check en BD antes de crear
          let doc = await Activity.findOne({ 'googleCache.placeId': placeId }).lean();
          if (!doc) {
            doc = await findExistingActivityForGoogleCache(
              buildGoogleCachePayload(googleCache), label, location
            );
          }

          if (!doc) {
            const builtGoogleCache = buildGoogleCachePayload(googleCache, { now });
            if (!validGeoPoint(builtGoogleCache?.geo)) {
              failedPlaces.push({ name: label, reason: 'missing_geo' });
              continue;
            }

            const priority = calculatePriorityFromGoogleCache(builtGoogleCache);

            // Propagate geo from Google to location so geo validation passes
            const locObj = { ...baseLocObj };
            if (builtGoogleCache?.geo && !locObj?.geo?.coordinates?.length) {
              locObj.geo = builtGoogleCache.geo;
              locObj.geoSource = 'google_cache';
              if (builtGoogleCache.formattedAddress && !locObj.address) {
                locObj.address = builtGoogleCache.formattedAddress;
                locObj.addressSource = 'google_cache';
              }
            }

            try {
              if (placeIndex === 0) {
                const coverUrl = String(place?.media?.coverUrl || '').trim() || undefined;
                if (coverUrl) builtGoogleCache.coverUrl = coverUrl;
              }

              doc = await Activity.create({
                // name, slug, description, type left blank — admin fills manually
                // slug stays empty (sparse unique index allows multiple null plugs)
                active: true,
                location: locObj,
                media: { images: [] },
                ranking: {
                  ratingAvg: 0,
                  reviewsCount: 0,
                  priority,
                },
                audit: {
                  isAudited: false,
                  status: 'pending',
                  notes: 'Imported from social share flow.',
                },
                externalRef: { provider: 'social_import', url: url || undefined },
                googleCache: builtGoogleCache,
              });
              doc = doc.toObject ? doc.toObject() : doc;
            } catch (createErr) {
              if (Number(createErr?.code) !== 11000) throw createErr;
              doc = await Activity.findOne({ 'googleCache.placeId': placeId }).lean();
              if (!doc) throw createErr;
            }
          }

          activityId = normalizeObjectIdString(doc?._id);
        }

        if (!activityId) continue;

        // Guardar como favorito (upsert para evitar duplicados)
        await UserFavorite.findOneAndUpdate(
          { userId, type: 'activity', activityId },
          { $setOnInsert: { userId, type: 'activity', activityId } },
          { upsert: true }
        );

        savedActivityIds.push(activityId);
      } catch (err) {
        console.warn('[social-import] Failed to save place', place?.name, err?.message);
        failedPlaces.push({ name: place?.name || '?', reason: err?.message || 'unknown' });
      }
    }

    // Actualizar SocialImportLink con resolvedActivities para cachear
    if (normalizedUrl && savedActivityIds.length) {
      await upsertSocialImportLinkResolution({
        normalizedUrl,
        originalUrl: url,
        source,
        postId,
        labels: [],
        resolvedActivities: savedActivityIds.map((actId, i) => ({
          activityId: actId,
          role: i === 0 ? 'primary' : 'secondary',
          candidateType: 'exact_place',
          confidence: 0.72,
          status: 'pending_review',
        })),
        status: 'resolved',
        userId,
        now,
      });
    }

    return res.status(201).json({
      success: true,
      savedCount: savedActivityIds.length,
      failedCount: failedPlaces.length,
      activityIds: savedActivityIds,
      failed: failedPlaces,
    });
  } catch (err) {
    console.error('Error saving social import favorites:', err);
    return res.status(500).json({ success: false, message: err?.message || 'Failed to save favorites' });
  }
};

/**
 * Runs the googleCache maintenance pass:
 * - Not audited + cache expired → refresh from Google
 * - Audited + cache expired     → wipe all cache fields but keep placeId
 *
 * Called by a scheduled job (e.g. every 24 h) or manually from admin.
 */
exports.runGoogleCacheMaintenance = async (req, res) => {
  try {
    const now = new Date();
    const limit = Math.min(Number(req?.query?.limit) || 100, 500);

    const expiredActivities = await Activity.find({
      'googleCache.placeId': { $type: 'string' },
      'googleCache.expiresAt': { $lte: now },
      'googleCache.status': { $ne: 'refresh_failed' },
    })
      .select('_id googleCache.placeId googleCache.refreshCount audit.isAudited audit.status')
      .lean()
      .limit(limit);

    let refreshed = 0;
    let purged = 0;
    let failed = 0;

    for (const activity of expiredActivities) {
      const placeId = activity?.googleCache?.placeId;
      if (!placeId) continue;

      if (activity?.audit?.isAudited) {
        // Audited — wipe cache fields but preserve placeId for future dedup
        await Activity.updateOne(
          { _id: activity._id },
          {
            $set: { 'googleCache.status': 'expired', 'googleCache.placeId': placeId },
            $unset: {
              'googleCache.name': '',
              'googleCache.formattedAddress': '',
              'googleCache.geo': '',
              'googleCache.ratingAvg': '',
              'googleCache.reviewsCount': '',
              'googleCache.businessStatus': '',
              'googleCache.types': '',
              'googleCache.photoUrl': '',
              'googleCache.googleMapsUri': '',
              'googleCache.openingHours': '',
              'googleCache.timeZone': '',
              'googleCache.fieldMask': '',
              'googleCache.fetchedAt': '',
              'googleCache.expiresAt': '',
              'googleCache.lastError': '',
            },
          }
        );
        purged++;
      } else {
        // Not audited — refresh from Google
        try {
          const refreshed_cache = await refreshGoogleCacheByPlaceId(
            placeId,
            { refreshCount: activity?.googleCache?.refreshCount || 0 }
          );
          if (refreshed_cache) {
            await Activity.updateOne(
              { _id: activity._id },
              { $set: { googleCache: refreshed_cache } }
            );
            refreshed++;
          } else {
            await Activity.updateOne(
              { _id: activity._id },
              { $set: { 'googleCache.status': 'refresh_failed', 'googleCache.lastError': 'place_not_found' } }
            );
            failed++;
          }
        } catch (err) {
          await Activity.updateOne(
            { _id: activity._id },
            { $set: { 'googleCache.status': 'refresh_failed', 'googleCache.lastError': String(err?.message || '').slice(0, 200) } }
          );
          failed++;
        }
      }
    }

    return res.json({
      success: true,
      total: expiredActivities.length,
      refreshed,
      purged,
      failed,
    });
  } catch (err) {
    console.error('[googleCache maintenance]', err?.message);
    return res.status(500).json({ success: false, message: err?.message });
  }
};

exports.previewSocialActivities = async (req, res) => {
  try {
    const payload = req.body || {};
    const url = String(payload?.url || '').trim();
    const source = normalizeSocialImportSource(payload?.source, url);
    const imageBase64 = String(payload?.imageBase64 || '').trim() || null;
    const imageMimeType = String(payload?.imageMimeType || 'image/jpeg').trim();
    const text = await buildSocialImportResolverText(payload, { source, url });
    const aiInput = buildSocialImportAiExtractionInput(payload, text);
    let labels = [];
    let extractionMethod = 'none';
    let aiLocationContext = null;
    try {
      const primaryGeminiResult = await geminiService.extractPlacesFromSocialContent({
        text: aiInput.primaryText,
        imageBase64,
        mimeType: imageMimeType,
      });

      let geminiResult = primaryGeminiResult;
      if (!geminiResult?.places?.length && aiInput.audioText) {
        geminiResult = await geminiService.extractPlacesFromSocialContent({
          text: aiInput.fallbackAudioText,
          imageBase64,
          mimeType: imageMimeType,
        });
        extractionMethod = `ai_${geminiResult.method}_audio_fallback`;
      } else {
        extractionMethod = `ai_${geminiResult?.method || 'none'}`;
      }

      labels = normalizeGeminiPlaceCandidates(geminiResult?.places);
      const locationResult = await geminiService.extractLocationContextFromSocialContent({
        text: geminiResult?.places?.length ? aiInput.primaryText : aiInput.fallbackAudioText,
      });
      aiLocationContext = locationResult?.location || null;
    } catch (err) {
      console.warn('[social-import] Gemini extraction failed in preview', err?.message);
    }
    const normalizedUrl = normalizeSocialImportUrl(url) || buildSyntheticSocialImportUrl(source, text, labels);
    const postId = extractSocialPostId(normalizedUrl || url);
    const bypassCache = payload?.bypassCache === true || payload?.refresh === true;

    const cachedLink = !bypassCache && normalizedUrl
      ? await SocialImportLink.findOne({ normalizedUrl }).lean()
      : null;
    const cachedActivities = await resolveCachedSocialImportActivities(cachedLink);
    if (cachedActivities.length) {
      await recordSocialImportLinkUsage({
        normalizedUrl,
        originalUrl: url,
        source,
        postId,
        now: new Date(),
      });
      return res.status(200).json({
        success: true,
        data: cachedActivities,
        meta: {
          previewOnly: true,
          cached: true,
          linkId: String(cachedLink._id),
          status: 'resolved',
          needsMediaAnalysis: false,
          mediaAnalysisSources: [],
          source,
          receivedCandidates: labels.length,
          resolvedCount: cachedActivities.length,
          candidateMatchesCount: cachedActivities.length,
          unresolved: [],
        },
      });
    }

    if (!labels.length) {
      return res.status(400).json({
        success: false,
        message: 'No place candidates were found in the shared content.',
        meta: { extractionMethod },
      });
    }

    const location = await resolveSocialImportLocation({
      ...payload,
      candidates: labels,
    });
    const locationContext = location?._id
      ? await resolveLocationContextForPreview(location)
      : null;
    const resolvedCandidates = [];
    const unresolved = [];
    const orderedLabels = prioritizeSocialImportLabels(labels);
    const maxCandidates = Math.min(orderedLabels.length, Math.max(1, Math.min(25, Number(payload?.limit || 20))));
    const candidateSlice = orderedLabels.slice(0, maxCandidates);
    const concurrency = Math.min(6, Math.max(2, Number(payload?.concurrency || 4)));
    let pointer = 0;

    const worker = async () => {
      while (pointer < candidateSlice.length) {
        const index = pointer;
        pointer += 1;
        const item = candidateSlice[index];
        const query = String(item?.label || '').trim();
        if (!query) continue;

        try {
          if (!shouldResolveSocialImportLabel(item, labels)) {
            unresolved.push({ label: query, reason: 'superseded_by_explicit_list' });
            continue;
          }

          if (isSocialImportAuthorNoiseLabel(item, text)) {
            unresolved.push({ label: query, reason: 'author_profile_ignored' });
            continue;
          }

          if (isWeakSocialImportDiscoveryLabel(item)) {
            unresolved.push({ label: query, reason: 'weak_discovery_signal_needs_media_analysis' });
            continue;
          }

          if (await isSocialImportContextOnlyLabel(query, location, labels.length)) {
            unresolved.push({ label: query, reason: 'context_only' });
            continue;
          }

          const searchQuery = buildSocialImportGoogleSearchQuery(query, item, locationContext, aiLocationContext);
          const cachePlaces = await googlePlacesService.searchTextForPlaceCache({
            textQuery: searchQuery,
            maxResultCount: 10,
          });
          const match = pickBestGoogleCachePlace(
            cachePlaces,
            query,
            locationContext?.name || text,
            { ...item, aiLocationContext }
          );
          if (!match?.place) {
            unresolved.push({ label: query, reason: 'no_google_place_match' });
            continue;
          }
          const selected = match.place;
          const confidence = match.confidence;
          const googleCache = buildGoogleCachePayload(selected);
          let existingActivity = await Activity.findOne({ 'googleCache.placeId': googleCache.placeId }).lean();
          if (!existingActivity) {
            existingActivity = await findExistingActivityForGoogleCache(googleCache, query, location);
          }
          if (existingActivity?._id) {
            existingActivity = await Activity.findById(existingActivity._id).lean() || existingActivity;
          }
          const sourceClaim = buildGoogleCacheSocialSourceClaim({
            label: query,
            profile: item.profile,
            googleCache: selected,
            confidence,
            evidence: [text, item?.context].filter(Boolean).join('\n'),
          }, {
            source,
            url,
            text,
          });
          resolvedCandidates.push({
            ...(existingActivity || {
              name: selected.name || query,
              nameSource: 'google_cache',
              visibility: 'imported_private',
              type: inferActivityTypeFromGoogleTypes(selected.types),
              ranking: {
                ratingAvg: 0,
                reviewsCount: 0,
                priority: calculatePriorityFromGoogleCache(selected),
                prioritySource: 'google_cache_user_trend',
                priorityFormulaVersion: 'google-cache-v1',
              },
              sourceClaims: [sourceClaim],
            }),
            googleCache: existingActivity?.googleCache?.placeId ? existingActivity.googleCache : googleCache,
            media: existingActivity?.media || buildSocialImportPreviewMedia(selected, req),
            _socialImport: {
              existing: !!existingActivity?._id,
              existingActivityId: existingActivity?._id ? String(existingActivity._id) : undefined,
              confidence,
              resolveScore: match.resolveScore,
              signalSource: item?.source || 'candidate',
              signalQuality: match.signalQuality,
              context: item?.context || undefined,
              sequence: Number.isFinite(Number(item?.sequence)) ? Number(item.sequence) : undefined,
              originalLabel: query,
              previewOnly: true,
            },
          });
        } catch (err) {
          unresolved.push({ label: query, reason: err?.message || 'search_failed' });
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    const previewResults = selectBestSocialImportPreviewResults(resolvedCandidates, {
      hasMultiPlaceSignal: hasMultiPlaceSignalFromAiLabels(labels),
      limit: payload?.limit,
    });
    const needsMediaAnalysis = socialImportNeedsMediaAnalysis(labels, resolvedCandidates, unresolved);

    return res.status(200).json({
      success: true,
      data: previewResults,
      meta: {
        previewOnly: true,
        status: needsMediaAnalysis ? 'needs_media_analysis' : 'resolved',
        needsMediaAnalysis,
        mediaAnalysisSources: needsMediaAnalysis ? ['audio_transcript', 'video_ocr', 'thumbnail_vision'] : [],
        location,
        source,
        extractionMethod,
        receivedCandidates: labels.length,
        resolvedCount: previewResults.length,
        candidateMatchesCount: resolvedCandidates.length,
        unresolved,
      },
    });
  } catch (err) {
    console.error('Error previewing social activities:', err);
    return res.status(500).json({
      success: false,
      message: err?.message || 'Failed to preview social activities',
    });
  }
};

function buildSocialImportAiExtractionInput(payload = {}, metadataText = '') {
  const normalizedMetadata = String(metadataText || '').trim();
  const description = String(
    payload?.description ||
    payload?.caption ||
    payload?.text ||
    ''
  ).trim();
  const title = String(
    payload?.title ||
    payload?.postTitle ||
    payload?.ogTitle ||
    ''
  ).trim();
  const explicitMetadata = typeof payload?.metadata === 'string'
    ? payload.metadata
    : (payload?.metadata && typeof payload.metadata === 'object')
      ? JSON.stringify(payload.metadata)
      : '';
  const audio = String(
    payload?.audioTranscript ||
    payload?.transcript ||
    payload?.audioText ||
    ''
  ).trim();

  const primarySections = [
    description ? `Description:\n${description}` : '',
    title ? `Title:\n${title}` : '',
    normalizedMetadata ? `Metadata:\n${normalizedMetadata}` : '',
    explicitMetadata ? `Metadata (explicit):\n${explicitMetadata}` : '',
  ].filter(Boolean);

  const primaryText = primarySections.join('\n\n').slice(0, 12000);
  const fallbackAudioText = [
    primaryText,
    audio ? `Audio transcript:\n${audio}` : '',
  ].filter(Boolean).join('\n\n').slice(0, 12000);

  return {
    primaryText,
    audioText: audio,
    fallbackAudioText,
  };
}

function socialImportGeminiConfidenceToScore(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'high') return 0.9;
  if (normalized === 'medium') return 0.65;
  return 0.35;
}

function normalizeGeminiPlaceCandidates(places = []) {
  const rows = Array.isArray(places) ? places : [];
  const out = [];
  const seen = new Set();

  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const label = normalizeSocialImportLabel(raw.name || raw.label || '');
    if (!label) continue;

    const confidence = String(raw.confidence || '').trim().toLowerCase();
    const confidenceScore = socialImportGeminiConfidenceToScore(confidence);
    const type = String(raw.type || '').trim().toLowerCase();
    const isPrimary = raw.isPrimary === true;

    if (type === 'context_only') continue;
    if (type === 'area_mentioned' && !isPrimary) continue;
    if (confidenceScore < 0.55 && !isPrimary) continue;

    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      label,
      source: isPrimary ? 'ai_primary' : 'ai',
      confidence: confidence || 'low',
      context: normalizeSocialImportContext(raw.evidence || raw.context || ''),
      type: type || 'exact_place',
    });
  }

  return out.slice(0, 25);
}

async function resolveCachedSocialImportActivities(linkDoc = null) {
  const refs = Array.isArray(linkDoc?.resolvedActivities)
    ? linkDoc.resolvedActivities.filter((ref) => {
        const status = String(ref?.status || '').trim().toLowerCase();
        return ref?.activityId && status !== 'rejected' && status !== 'merged';
      })
    : [];
  if (!refs.length) return [];

  const ids = Array.from(new Set(refs.map((ref) => String(ref.activityId)).filter(Boolean)));
  if (!ids.length) return [];

  const docs = await Activity.find({ _id: { $in: ids } }).lean();
  const byId = new Map(docs.map((doc) => [String(doc._id), doc]));
  const out = [];

  for (const ref of refs) {
    const doc = byId.get(String(ref.activityId));
    if (!doc) continue;
    const refreshed = await refreshImportedActivityCacheIfNeeded(doc);
    out.push({
      ...refreshed,
      _socialImport: {
        cached: true,
        linkId: linkDoc?._id ? String(linkDoc._id) : undefined,
        confidence: Number(ref?.confidence || 0),
        role: ref?.role || 'primary',
      },
    });
  }

  return out;
}

async function refreshImportedActivityCacheIfNeeded(activity = {}) {
  if (!activity?._id || !isGoogleCacheExpired(activity)) return activity;
  if (activityHasCanonicalData(activity)) return activity;

  const placeId = String(activity?.googleCache?.placeId || '').trim();
  if (!placeId) return activity;

  try {
    const refreshed = await refreshGoogleCacheByPlaceId(placeId, activity.googleCache || {});
    if (!refreshed?.placeId) {
      return await Activity.findByIdAndUpdate(
        activity._id,
        {
          $set: {
            'googleCache.status': 'refresh_failed',
            'googleCache.lastError': 'Google Places refresh returned no place.',
          },
        },
        { new: true }
      ).lean() || activity;
    }

    const priority = calculatePriorityFromGoogleCache(refreshed);
    return await Activity.findByIdAndUpdate(
      activity._id,
      {
        $set: {
          googleCache: refreshed,
          'ranking.priority': priority,
          'ranking.prioritySource': 'google_cache_user_trend',
          'ranking.priorityFormulaVersion': 'google-cache-v1',
        },
      },
      { new: true }
    ).lean() || activity;
  } catch (err) {
    return await Activity.findByIdAndUpdate(
      activity._id,
      {
        $set: {
          'googleCache.status': 'refresh_failed',
          'googleCache.lastError': String(err?.message || err || 'Google Places refresh failed').slice(0, 500),
        },
      },
      { new: true }
    ).lean() || activity;
  }
}

async function persistGoogleCacheSocialCandidates(candidates = [], options = {}) {
  const out = [];
  const failed = [];
  const now = options?.now instanceof Date && !Number.isNaN(options.now.getTime())
    ? options.now
    : new Date();
  const baseLocObj = options?.location?._id
    ? await resolveActivityLocationObject(options.location)
    : {};

  for (const candidate of candidates) {
    const label = String(candidate?.label || candidate?.googleCache?.name || '').trim();
    const googleCache = buildGoogleCachePayload(candidate?.googleCache || {}, { now });
    const placeId = String(googleCache?.placeId || '').trim();

    if (!label || !placeId || !validGeoPoint(googleCache?.geo)) {
      failed.push({
        name: label || null,
        placeId: placeId || null,
        message: 'Missing label, Google placeId, or Google coordinates.',
      });
      continue;
    }

    const sourceClaim = buildGoogleCacheSocialSourceClaim(candidate, options);
    const priority = calculatePriorityFromGoogleCache(googleCache);
    const location = {
      ...baseLocObj,
    };

    try {
      let doc = await Activity.findOne({ 'googleCache.placeId': placeId }).lean();
      if (!doc) {
        doc = await findExistingActivityForGoogleCache(googleCache, label, options.location);
      }

      if (!doc) {
        const slug = await ensureUniqueActivitySlug(slugify(label || googleCache.name || placeId));
        const externalRefId = buildSocialImportActivityExternalRefId({
          source: options.source,
          normalizedUrl: options.normalizedUrl || options.url,
          postId: extractSocialPostId(options.normalizedUrl || options.url),
          label,
        });

        try {
          doc = await Activity.create({
            name: label,
            nameSource: 'source_claim',
            slug,
            description: '',
            type: inferActivityTypeFromGoogleTypes(googleCache.types),
            active: true,
            visibility: 'imported_private',
            location,
            media: { images: [] },
            ranking: {
              ratingAvg: 0,
              reviewsCount: 0,
              priority,
              prioritySource: 'google_cache_user_trend',
              priorityFormulaVersion: 'google-cache-v1',
            },
            audit: {
              isAudited: false,
              status: 'pending',
              notes: 'Imported from social share flow. Google fields are temporary cache only.',
            },
            externalRef: {
              provider: 'social_import',
              id: externalRefId,
              url: options.url || undefined,
            },
            sourceClaims: [sourceClaim],
            googleCache,
          });
          doc = doc.toObject ? doc.toObject() : doc;
        } catch (createErr) {
          if (Number(createErr?.code) !== 11000) throw createErr;
          doc = await Activity.findOne({ 'googleCache.placeId': placeId }).lean();
          if (!doc) throw createErr;
        }
      }

      if (doc?._id) {
        const updateOps = {
          $set: {
            googleCache,
            'ranking.priority': priority,
            'ranking.prioritySource': 'google_cache_user_trend',
            'ranking.priorityFormulaVersion': 'google-cache-v1',
          },
        };

        if (!doc.visibility) {
          const isApproved = !!doc?.audit?.isAudited && String(doc?.audit?.status || '').toLowerCase() === 'approved';
          updateOps.$set.visibility = isApproved ? 'public' : 'imported_private';
        }
        if (doc.active === false && String(doc?.visibility || '').toLowerCase() === 'imported_private') {
          updateOps.$set.active = true;
        }
        if (!hasEquivalentSourceClaim(doc, sourceClaim)) {
          updateOps.$push = { sourceClaims: sourceClaim };
        }

        doc = await Activity.findByIdAndUpdate(doc._id, updateOps, { new: true }).lean() || doc;
      }

      out.push({
        ...doc,
        _socialImport: {
          confidence: Number(candidate?.confidence || sourceClaim.confidence || 0.72),
          originalLabel: label,
          googlePlaceId: placeId,
        },
      });
    } catch (err) {
      failed.push({
        name: label || null,
        placeId,
        message: err?.message || 'persist failed',
      });
    }
  }

  return { saved: out, failed };
}

async function upsertSocialImportLinkResolution(options = {}) {
  const normalizedUrl = String(options?.normalizedUrl || '').trim();
  if (!normalizedUrl) return null;

  const now = options?.now instanceof Date && !Number.isNaN(options.now.getTime())
    ? options.now
    : new Date();
  const resolvedActivities = Array.isArray(options?.resolvedActivities)
    ? options.resolvedActivities
        .map((ref) => ({
          activityId: ref.activityId,
          role: ref.role || 'primary',
          candidateType: ref.candidateType || 'exact_place',
          confidence: Number.isFinite(Number(ref.confidence)) ? Number(ref.confidence) : undefined,
          status: ref.status || 'pending_review',
        }))
        .filter((ref) => ref.activityId)
    : [];
  const extractionCandidates = Array.isArray(options?.labels)
    ? options.labels.map((item) => ({
        name: String(item?.label || '').trim(),
        context: '',
        type: 'exact_place',
        confidence: 0.72,
        evidence: String(item?.source || '').trim(),
      })).filter((item) => item.name)
    : [];

  const setPayload = {
    source: options.source || 'social_import',
    resolvedActivities,
    'extraction.status': options.status || (resolvedActivities.length ? 'resolved' : 'failed'),
    'extraction.fetchedAt': now,
    'extraction.method': 'share-link-google-cache-v1',
    'extraction.candidates': extractionCandidates,
    'admin.priorityScore': Math.min(100, Math.round((resolvedActivities.length * 20) + 10)),
  };
  if (options.postId) setPayload.postId = options.postId;
  if (options.error) setPayload['extraction.error'] = options.error;

  const update = {
    $set: {
      ...setPayload,
    },
    $setOnInsert: {
      normalizedUrl,
    },
  };
  if (!options.error) {
    update.$unset = { 'extraction.error': '' };
  }
  if (options.originalUrl) {
    update.$addToSet = { originalUrls: String(options.originalUrl).trim() };
  }

  const doc = await SocialImportLink.findOneAndUpdate(
    { normalizedUrl },
    update,
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();

  await recordSocialImportLinkUsage({
    normalizedUrl,
    originalUrl: options.originalUrl,
    source: options.source,
    postId: options.postId,
    userId: options.userId,
    now,
  });

  return doc;
}

async function recordSocialImportLinkUsage(options = {}) {
  const normalizedUrl = String(options?.normalizedUrl || '').trim();
  if (!normalizedUrl) return null;

  const now = options?.now instanceof Date && !Number.isNaN(options.now.getTime())
    ? options.now
    : new Date();
  const userId = normalizeObjectIdString(options?.userId);
  const baseSet = {
    source: options.source || 'social_import',
    'usage.lastSharedAt': now,
  };
  if (options.postId) baseSet.postId = options.postId;
  const addToSet = options.originalUrl
    ? { originalUrls: String(options.originalUrl).trim() }
    : undefined;

  if (userId) {
    const existingUser = await SocialImportLink.findOne({
      normalizedUrl,
      'usage.users.userId': userId,
    }).select('_id').lean();

    if (existingUser?._id) {
      return SocialImportLink.updateOne(
        { normalizedUrl, 'usage.users.userId': userId },
        {
          $set: {
            ...baseSet,
            'usage.users.$.lastSharedAt': now,
          },
          $inc: {
            'usage.shareCount': 1,
            'usage.users.$.count': 1,
          },
          ...(addToSet ? { $addToSet: addToSet } : {}),
        }
      );
    }

    return SocialImportLink.updateOne(
      { normalizedUrl },
      {
        $set: baseSet,
        $inc: {
          'usage.shareCount': 1,
          'usage.uniqueUserCount': 1,
        },
        $push: {
          'usage.users': {
            userId,
            firstSharedAt: now,
            lastSharedAt: now,
            count: 1,
          },
        },
        ...(addToSet ? { $addToSet: addToSet } : {}),
      },
      { upsert: true }
    );
  }

  return SocialImportLink.updateOne(
    { normalizedUrl },
    {
      $set: baseSet,
      $inc: { 'usage.shareCount': 1 },
      ...(addToSet ? { $addToSet: addToSet } : {}),
      $setOnInsert: { normalizedUrl },
    },
    { upsert: true }
  );
}

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

async function persistOpenCandidatesForLocation(candidates = [], location = null, options = {}) {
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
      const shouldAttachSourceClaim = !!options?.sourceClaim;
      const buildSourceClaim = (status = 'pending') => shouldAttachSourceClaim
        ? buildSocialSourceClaim(c, externalRef, {
            ...options,
            sourceClaim: {
              ...(options.sourceClaim || {}),
              status,
            },
          })
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
            active: typeof options.active === 'boolean' ? options.active : true,
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
            ...(shouldAttachSourceClaim ? { sourceClaims: [buildSourceClaim(options?.sourceClaim?.status || 'pending')] } : {}),
            ...(options.audit
              ? {
                  audit: {
                    isAudited: !!options.audit.isAudited,
                    status: options.audit.status || 'pending',
                    notes: options.audit.notes || undefined,
                  },
                }
              : {}),
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
        const existingIsApproved = !!doc?.active && !!doc?.audit?.isAudited && String(doc?.audit?.status || '').toLowerCase() === 'approved';
        const sourceClaim = buildSourceClaim(existingIsApproved ? 'accepted' : (options?.sourceClaim?.status || 'pending'));
        const updateOps = {};
        if (Object.keys(update).length) {
          updateOps.$set = update;
        }
        if (sourceClaim && !hasEquivalentSourceClaim(doc, sourceClaim)) {
          updateOps.$push = { sourceClaims: sourceClaim };
        }
        if (Object.keys(updateOps).length) {
          doc = await Activity.findByIdAndUpdate(doc._id, updateOps, { new: true, runValidators: true }).lean();
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

function extractLocalizedDescriptionsFromWikidataEntity(entity = {}) {
  const descriptions = entity && typeof entity === 'object' && entity.descriptions && typeof entity.descriptions === 'object'
    ? entity.descriptions
    : {};
  const out = {};
  for (const [localeRaw, payload] of Object.entries(descriptions)) {
    const locale = normalizeLocaleKey(localeRaw);
    const value = String(payload?.value || '').trim();
    if (!locale || !value) continue;
    out[locale] = value;
  }
  return out;
}

function wikidataEntityClaimValues(entity = {}, property = '') {
  const claims = entity?.claims?.[property];
  return Array.isArray(claims)
    ? claims.map((claim) => claim?.mainsnak?.datavalue?.value).filter(Boolean)
    : [];
}

function wikidataEntityClaimIds(entity = {}, property = '') {
  return wikidataEntityClaimValues(entity, property)
    .map((value) => String(value?.id || '').trim().toUpperCase())
    .filter((id) => /^Q\d+$/.test(id));
}

function wikidataEntityCoordinate(entity = {}) {
  const value = wikidataEntityClaimValues(entity, 'P625')[0];
  const lat = Number(value?.latitude);
  const lng = Number(value?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function commonsFileUrl(fileName = '') {
  const name = String(fileName || '').trim();
  return name ? `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(name)}` : '';
}

function wikidataEntityMedia(entity = {}) {
  const imageNames = wikidataEntityClaimValues(entity, 'P18')
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim());
  const images = imageNames
    .map((fileName, index) => ({
      url: commonsFileUrl(fileName),
      type: 'image',
      caption: 'Wikimedia Commons',
      order: index,
    }))
    .filter((image) => !!image.url);
  return {
    cover: images[0]?.url || undefined,
    images,
  };
}

function wikidataEntityStringClaim(entity = {}, property = '') {
  const value = wikidataEntityClaimValues(entity, property)[0];
  if (typeof value === 'string') return value.trim();
  if (value && typeof value.text === 'string') return value.text.trim();
  return '';
}

async function buildActivityDraftFromWikidataQid(qid) {
  const entityMap = await wikidataGetEntitiesRaw([qid], {
    languages: ['en', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'ko', 'zh', 'ar'],
  });
  const entity = entityMap?.[qid];
  if (!entity || entity.missing) {
    return { errorStatus: 404, errorMessage: `No Wikidata entity found for ${qid}` };
  }

  const names = extractLocalizedLabelsFromWikidataEntity(entity);
  const descriptions = extractLocalizedDescriptionsFromWikidataEntity(entity);
  const name = String(names.en || Object.values(names)[0] || qid).trim();
  const slug = slugify(name);
  const slugs = {};
  for (const [locale, value] of Object.entries(names)) {
    const localizedSlug = slugify(value || '');
    if (localizedSlug) slugs[locale] = localizedSlug;
  }
  if (!slugs.en && slug) slugs.en = slug;

  const coordinate = wikidataEntityCoordinate(entity);
  const location = {};
  if (coordinate) {
    location.geo = { type: 'Point', coordinates: [coordinate.lng, coordinate.lat] };
    location.geoSource = 'wikidata';
    location.geoConfidence = 'high';
  }

  const address = wikidataEntityStringClaim(entity, 'P6375') || wikidataEntityStringClaim(entity, 'P969');
  if (address) {
    location.address = address;
    location.addressSource = 'wikidata';
  }

  const adminParentQid = wikidataEntityClaimIds(entity, 'P131')[0];
  if (adminParentQid) {
    try {
      const syncResult = await syncZoneHierarchyByQid(adminParentQid);
      const leafZoneId = normalizeObjectIdString(syncResult?.leafZoneId);
      if (leafZoneId) {
        const loc = await resolveActivityLocationObject({ _id: leafZoneId, type: 'locality' });
        Object.assign(location, loc);
      }
    } catch (err) {
      console.warn('[wikidataDraft] unable to resolve admin zone', { qid, adminParentQid, message: err?.message });
    }
  }

  const classIds = wikidataEntityClaimIds(entity, 'P31');
  const activityCategoryIds = await resolveActivityCategoryIdsFromWikidataClassIds(classIds);
  const media = wikidataEntityMedia(entity);
  const website = wikidataEntityStringClaim(entity, 'P856');

  const sourceClaim = {
    source: 'wikidata',
    url: `https://www.wikidata.org/wiki/${qid}`,
    externalId: qid,
    extractedName: name,
    confidence: 0.9,
    status: 'accepted',
    importedAt: new Date(),
  };

  return {
    data: {
      name,
      nameSource: 'open_data',
      names,
      slug,
      slugs,
      description: descriptions.en || Object.values(descriptions)[0] || '',
      type: 'experience',
      activityCategoryIds,
      location,
      media,
      externalRef: {
        provider: 'wikidata',
        id: qid,
        url: `https://www.wikidata.org/wiki/${qid}`,
      },
      sourceClaims: [sourceClaim],
      accessHint: {
        requirement: 'unknown',
        confidence: 'low',
        source: 'wikidata',
        ...(website ? { message: `Official website: ${website}` } : {}),
      },
    },
    meta: {
      qid,
      classIds,
      namesAdded: Object.keys(names).length,
      slugsAdded: Object.keys(slugs).length,
      hasCoordinates: !!coordinate,
      hasMedia: !!media.images.length,
      resolvedZone: !!location.primaryZoneId,
    },
  };
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
const SOCIAL_SOURCE_CLAIM_VALUES = ['instagram', 'tiktok', 'social_import'];

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

function hasSocialSourceClaim(activityDoc = {}) {
  const claims = Array.isArray(activityDoc?.sourceClaims) ? activityDoc.sourceClaims : [];
  return claims.some((claim) => SOCIAL_SOURCE_CLAIM_VALUES.includes(String(claim?.source || '').trim().toLowerCase()));
}

function escapeRegExp(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function shortHash(value = '') {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}

function normalizeSocialImportUrl(rawUrl = '') {
  const input = String(rawUrl || '').trim();
  if (!input) return '';

  try {
    const parsed = new URL(input);
    const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    const path = parsed.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/g, '');

    if (host.includes('instagram.com')) {
      const match = path.match(/^\/(reel|p|tv)\/([^/]+)/i);
      if (match) {
        return `https://www.instagram.com/${match[1].toLowerCase()}/${match[2]}/`;
      }
    }

    if (host.includes('tiktok.com')) {
      const match = path.match(/^\/@([^/]+)\/video\/([^/]+)/i);
      if (match) {
        return `https://www.tiktok.com/@${match[1]}/video/${match[2]}`;
      }
    }

    return `https://${host}${path || '/'}`;
  } catch (err) {
    return input.replace(/[?#].*$/g, '').replace(/\/+$/g, '');
  }
}

function buildSyntheticSocialImportUrl(source = 'social_import', text = '', labels = []) {
  const seed = JSON.stringify({
    source: normalizeSocialImportSource(source, ''),
    text: String(text || '').slice(0, 1000),
    labels: labels.map((item) => String(item?.label || item || '').trim()).filter(Boolean),
  });
  return `social-import://${shortHash(seed)}`;
}

function extractSocialPostId(rawUrl = '') {
  const normalized = normalizeSocialImportUrl(rawUrl);
  if (!normalized) return '';

  try {
    const parsed = new URL(normalized);
    const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    if (host.includes('instagram.com')) {
      const match = parsed.pathname.match(/^\/(?:reel|p|tv)\/([^/]+)/i);
      return match?.[1] ? String(match[1]).trim() : '';
    }
    if (host.includes('tiktok.com')) {
      const match = parsed.pathname.match(/\/video\/([^/]+)/i);
      return match?.[1] ? String(match[1]).trim() : '';
    }
  } catch (err) {
    // Fall through to stable hash fallback.
  }

  return shortHash(normalized);
}

function normalizeSocialImportSource(source = '', url = '') {
  const raw = String(source || '').trim().toLowerCase();
  if (SOCIAL_SOURCE_CLAIM_VALUES.includes(raw)) return raw;
  const rawUrl = String(url || '').toLowerCase();
  if (rawUrl.includes('instagram.com')) return 'instagram';
  if (rawUrl.includes('tiktok.com')) return 'tiktok';
  return 'social_import';
}

function normalizeComparableText(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const SOCIAL_IMPORT_GENERIC_TERMS = new Set([
  'activity',
  'all',
  'bar',
  'beef',
  'best',
  'bio',
  'bite',
  'bread',
  'cafe',
  'cafes',
  'coffee',
  'combo',
  'crepe',
  'crispy',
  'culinary',
  'cuisine',
  'dessert',
  'dining',
  'experience',
  'fish',
  'food',
  'foodie',
  'foods',
  'full',
  'guide',
  'hotel',
  'icecream',
  'info',
  'japanese',
  'jam',
  'latte',
  'lemon',
  'link',
  'matcha',
  'market',
  'markets',
  'milk',
  'museum',
  'park',
  'place',
  'ramen',
  'restaurant',
  'restaurants',
  'spot',
  'spots',
  'street',
  'sushi',
  'tea',
  'tiramisu',
  'tuna',
  'travel',
  'trip',
  'video',
  'wagyu',
  'youtube',
]);

const SOCIAL_IMPORT_LOCATION_TERMS = new Set([
  'aoyama',
  'asakusa',
  'chuo',
  'gifu',
  'ginza',
  'ikebukuro',
  'japan',
  'japon',
  'kamakura',
  'kanagawa',
  'sangenjaya',
  'shibuya',
  'tarui',
  'tsukiji',
  'tokio',
  'tokyo',
  '三軒茶屋',
  '垂井',
  '岐阜',
  '東京',
  '池袋',
  '浅草',
  '渋谷',
  '築地',
  '銀座',
  '鎌倉',
  '青山',
]);

const SOCIAL_IMPORT_SIGNAL_SOURCE_WEIGHTS = {
  list_item: 0.36,
  recommendation: 0.34,
  explicit_name: 0.33,
  video_ocr: 0.31,
  visible_text: 0.31,
  ocr: 0.31,
  audio_transcript: 0.3,
  transcript: 0.3,
  mention_profile: 0.25,
  business_profile: 0.25,
  mention: 0.18,
  handle: 0.18,
  account: 0.16,
  profile: 0.14,
  hashtag: 0.13,
  place: 0.14,
  pin: 0.14,
  caption: 0.09,
  text: 0.08,
  metadata: 0.03,
  keyword: 0.03,
  location: 0.02,
  url: 0.02,
  candidate: 0.08,
};

const SOCIAL_IMPORT_EXPLICIT_LIST_SOURCES = new Set([
  'explicit_name',
  'list_item',
  'recommendation',
]);

const SOCIAL_IMPORT_WEAK_DISCOVERY_SOURCES = new Set([
  'caption',
  'hashtag',
  'keyword',
  'metadata',
  'text',
  'url',
]);

const SOCIAL_IMPORT_PROFILE_FETCH_TIMEOUT_MS = 2500;
const SOCIAL_IMPORT_PROFILE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const SOCIAL_IMPORT_PROFILE_CACHE = new Map();
const SOCIAL_IMPORT_URL_METADATA_FETCH_TIMEOUT_MS = 3500;
const SOCIAL_IMPORT_URL_METADATA_CACHE_TTL_MS = 30 * 60 * 1000;
const SOCIAL_IMPORT_URL_METADATA_CACHE = new Map();

const SOCIAL_IMPORT_BUSINESS_TERMS = new Set([
  'bakery',
  'bar',
  'boutique',
  'brewery',
  'cafe',
  'coffee',
  'gallery',
  'hotel',
  'izakaya',
  'lounge',
  'matcha',
  'museum',
  'official',
  'omakase',
  'restaurant',
  'roastery',
  'shop',
  'spa',
  'store',
  'studio',
  'sushi',
  'tea',
]);

function expandedComparableTokens(value = '') {
  const normalized = normalizeComparableText(value);
  if (!normalized) return [];

  const tokens = normalized.split(' ').filter((token) => token.length > 2);
  const compact = normalized.replace(/\s+/g, '');

  for (const generic of SOCIAL_IMPORT_GENERIC_TERMS) {
    if (compact.length <= generic.length + 2) continue;
    if (compact.endsWith(generic)) tokens.push(compact.slice(0, -generic.length));
    if (compact.startsWith(generic)) tokens.push(compact.slice(generic.length));
  }

  return Array.from(new Set(tokens.filter((token) => token.length > 2)));
}

function getSocialImportSignalSourceWeight(source = '') {
  const normalized = String(source || '').trim().toLowerCase();
  return SOCIAL_IMPORT_SIGNAL_SOURCE_WEIGHTS[normalized] ?? 0.06;
}

function getSpecificSocialImportTokens(label = '') {
  return expandedComparableTokens(label)
    .filter((token) => (
      !SOCIAL_IMPORT_GENERIC_TERMS.has(token) &&
      !SOCIAL_IMPORT_LOCATION_TERMS.has(token)
    ));
}

function compactTokenExplainedByWeakTerms(token = '') {
  let rest = normalizeComparableText(token).replace(/\s+/g, '');
  if (!rest) return true;

  const weakTerms = Array.from(new Set([
    ...SOCIAL_IMPORT_GENERIC_TERMS,
    ...SOCIAL_IMPORT_LOCATION_TERMS,
  ]))
    .filter((term) => term.length >= 3)
    .sort((a, b) => b.length - a.length);

  let changed = true;
  while (rest && changed) {
    changed = false;
    for (const term of weakTerms) {
      if (!rest.includes(term)) continue;
      rest = rest.replace(new RegExp(escapeRegExp(term), 'g'), '');
      changed = true;
    }
  }

  return rest.length <= 2;
}

// Detecta si un label es una dirección de calle en lugar de un nombre de lugar.
// Ej: "21 donggyo-ro 34-gil, Mapo-gu, Seoul" → true
// Ej: "Ramen Long Season" → false
function isStreetAddressLabel(label = '') {
  const s = String(label || '').trim();
  if (!s) return false;
  // Patrón: empieza con número seguido de texto tipo calle
  if (/^\d+[\s-]/.test(s) && /[,-]/.test(s)) return true;
  // Contiene abreviaturas de vía comunes (ro, gil, street, ave, blvd, etc.) precedidas de número
  if (/\b\d+\s*(?:ro|gil|dong|gu|si|do|street|st|ave|blvd|rd|dr|ln|way|court|ct|place|pl)\b/i.test(s)) return true;
  return false;
}

function isWeakSocialImportDiscoveryLabel(item = {}) {
  const source = String(item?.source || '').trim().toLowerCase();
  if (!SOCIAL_IMPORT_WEAK_DISCOVERY_SOURCES.has(source)) return false;

  const normalized = normalizeComparableText(item?.label || '');
  if (!normalized) return true;

  const tokens = normalized.split(' ').filter(Boolean);
  if (!tokens.length) return true;

  const weakTokens = tokens.every((token) => (
    SOCIAL_IMPORT_GENERIC_TERMS.has(token) ||
    SOCIAL_IMPORT_LOCATION_TERMS.has(token) ||
    compactTokenExplainedByWeakTerms(token)
  ));
  if (weakTokens) return true;

  const specificTokens = getSpecificSocialImportTokens(normalized);
  return !specificTokens.length;
}

function extractSocialImportAuthorSignals(text = '') {
  const out = [];
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (!/^(?:twitter:title|og:title|title)\s*:/i.test(line)) continue;
    const rawTitle = line.replace(/^(?:twitter:title|og:title|title)\s*:/i, '').trim();
    const beforeQuote = rawTitle.split('"')[0] || rawTitle;
    const authorPart = beforeQuote
      .replace(/\s+on Instagram.*$/i, '')
      .replace(/\s+•\s+Instagram.*$/i, '')
      .trim();
    if (authorPart) {
      out.push(authorPart);
      for (const part of authorPart.split(/\s*[|•]\s*/).map((entry) => entry.trim()).filter(Boolean)) {
        out.push(part);
      }
    }

    const handles = rawTitle.match(/@[\p{L}\p{N}_.-]{3,}/gu) || [];
    for (const handle of handles) {
      out.push(handle.replace(/^@/, ''));
      out.push(handle.replace(/^@/, '').replace(/[_.-]+/g, ' '));
    }
  }

  return Array.from(new Set(out.map((value) => normalizeComparableText(value)).filter(Boolean)));
}

function isSocialImportAuthorNoiseLabel(item = {}, text = '') {
  const source = String(item?.source || '').trim().toLowerCase();
  if (!['account', 'caption', 'handle', 'mention', 'mention_profile', 'profile', 'text'].includes(source)) {
    return false;
  }

  const label = normalizeComparableText(item?.label || '');
  if (!label) return false;

  const authorSignals = extractSocialImportAuthorSignals(text);
  if (!authorSignals.length) return false;

  return authorSignals.some((signal) => (
    signal === label ||
    signal.includes(label) ||
    label.includes(signal)
  ));
}

function scoreSocialImportSignalQuality(label = '', source = '') {
  const normalized = normalizeComparableText(label);
  if (!normalized) return 0;

  const tokens = expandedComparableTokens(label);
  const specificTokens = getSpecificSocialImportTokens(label);
  const sourceWeight = getSocialImportSignalSourceWeight(source);

  let score = 0.18 + sourceWeight;
  if (specificTokens.length) score += Math.min(0.26, specificTokens.length * 0.13);
  if (normalized.includes(' ')) score += 0.05;
  if (!normalized.includes(' ') && normalized.length >= 8) score += 0.05;
  if (tokens.length === 1 && SOCIAL_IMPORT_GENERIC_TERMS.has(tokens[0])) score -= 0.28;
  if (tokens.length && tokens.every((token) => SOCIAL_IMPORT_GENERIC_TERMS.has(token) || SOCIAL_IMPORT_LOCATION_TERMS.has(token))) score -= 0.22;

  return Math.max(0, Math.min(0.45, Number(score.toFixed(2))));
}

function extractSocialImportAddressNumberKeys(value = '') {
  const raw = String(value || '');
  const matches = raw.match(/\b\d{1,5}(?:[-\s]\d{1,5}){1,3}\b/g) || [];
  if (/\b(?:address|prefecture|city|cho|gun|chome)\b|住所|所在地|県|市|町|郡|丁目/iu.test(raw)) {
    matches.push(...(raw.match(/(?<!\d)\d{3,5}(?!\d)/g) || []));
  }
  return Array.from(new Set(matches.map((match) => (
    normalizeComparableText(match).replace(/\s+/g, ' ').trim()
  )).filter(Boolean)));
}

function socialImportAddressNumberMatches(address = '', keys = []) {
  const normalizedAddress = normalizeComparableText(address);
  if (!normalizedAddress || !Array.isArray(keys) || !keys.length) return false;
  const addressNumbers = normalizedAddress.match(/\d+/g) || [];

  return keys.some((key) => {
    const normalizedKey = normalizeComparableText(key);
    if (!normalizedKey) return false;
    const compactKey = normalizedKey.replace(/\s+/g, '');
    const compactAddress = normalizedAddress.replace(/\s+/g, '');
    if (normalizedAddress.includes(normalizedKey) || compactAddress.includes(compactKey)) return true;

    const keyNumbers = normalizedKey.match(/\d+/g) || [];
    if (!keyNumbers.length || keyNumbers.length > addressNumbers.length) return false;
    for (let index = 0; index <= addressNumbers.length - keyNumbers.length; index += 1) {
      const slice = addressNumbers.slice(index, index + keyNumbers.length);
      if (slice.every((number, offset) => number === keyNumbers[offset])) return true;
    }
    return false;
  });
}

function scoreGoogleCachePlaceMatch(place = {}, label = '', context = '', signal = {}) {
  const placeName = normalizeComparableText(place?.name || '');
  const target = normalizeComparableText(label || '');
  const formattedAddress = normalizeComparableText(place?.formattedAddress || '');
  const ctx = normalizeComparableText([
    context,
    signal?.context,
  ].filter(Boolean).join(' '));
  if (!placeName || !target) return 0;

  let score = 0.35;
  if (placeName === target) score += 0.5;
  else if (placeName.includes(target) || target.includes(placeName)) score += 0.35;
  else {
    const specificTargetTokens = getSpecificSocialImportTokens(target);
    const targetTokens = new Set(specificTargetTokens.length
      ? specificTargetTokens
      : expandedComparableTokens(target)
    );
    const nameTokens = new Set(expandedComparableTokens(placeName));
    const hits = Array.from(targetTokens).filter((token) => nameTokens.has(token)).length;
    if (targetTokens.size) score += Math.min(0.28, (hits / targetTokens.size) * 0.28);
  }

  if (ctx && formattedAddress) {
    const contextTokens = ctx.split(' ').filter((token) => token.length > 3);
    if (contextTokens.some((token) => formattedAddress.includes(token))) score += 0.12;
  }

  const geoBias = scoreSocialImportAiGeoBias(signal?.aiLocationContext, formattedAddress);
  score += geoBias;

  const addressNumberKeys = extractSocialImportAddressNumberKeys([context, signal?.context].filter(Boolean).join(' '));
  if (addressNumberKeys.length && formattedAddress) {
    if (socialImportAddressNumberMatches(place?.formattedAddress || '', addressNumberKeys)) {
      score += 0.16;
    } else {
      score -= 0.2;
    }
  }

  if (validGeoPoint(place?.geo)) score += 0.08;
  if (place?.ratingAvg || place?.reviewsCount) score += 0.05;

  const targetTokens = getSpecificSocialImportTokens(target);
  const nameTokens = new Set(expandedComparableTokens(placeName));
  const hasSpecificNameHit = targetTokens.some((token) => nameTokens.has(token));
  if (!hasSpecificNameHit && targetTokens.length && !placeName.includes(target) && !target.includes(placeName)) {
    score -= 0.12;
  }

  const signalQuality = scoreSocialImportSignalQuality(label, signal?.source);
  score += signalQuality;

  return Math.max(0, Math.min(0.98, Number(score.toFixed(2))));
}

function buildAiLocationTerms(aiLocationContext = null) {
  if (!aiLocationContext || typeof aiLocationContext !== 'object') return '';
  return [
    String(aiLocationContext.country || '').trim(),
    String(aiLocationContext.city || '').trim(),
    ...(Array.isArray(aiLocationContext.areas) ? aiLocationContext.areas.map((value) => String(value || '').trim()) : []),
  ].filter(Boolean).join(' ');
}

function scoreSocialImportAiGeoBias(aiLocationContext = null, formattedAddress = '') {
  if (!aiLocationContext || typeof aiLocationContext !== 'object') return 0;
  const expectedTerms = [
    String(aiLocationContext.country || '').trim(),
    String(aiLocationContext.city || '').trim(),
    ...(Array.isArray(aiLocationContext.areas) ? aiLocationContext.areas.map((value) => String(value || '').trim()) : []),
  ]
    .map((term) => normalizeComparableText(term))
    .filter((term) => term.length >= 3);

  if (!expectedTerms.length) return 0;

  const address = normalizeComparableText(formattedAddress);
  if (!address) return 0;

  const hits = expectedTerms.filter((term) => address.includes(term)).length;
  if (hits >= 2) return 0.24;
  if (hits === 1) return 0.1;
  return -0.2;
}

function pickBestGoogleCachePlace(places = [], label = '', context = '', signal = {}) {
  if (!Array.isArray(places) || !places.length) return null;
  const addressNumberKeys = extractSocialImportAddressNumberKeys([
    context,
    signal?.context,
  ].filter(Boolean).join(' '));
  const ranked = places
    .map((place) => ({
      place,
      confidence: scoreGoogleCachePlaceMatch(place, label, context, signal),
      signalQuality: scoreSocialImportSignalQuality(label, signal?.source),
    }))
    .filter((entry) => (
      entry?.place?.placeId &&
      validGeoPoint(entry.place.geo) &&
      isResolvableGoogleActivityPlace(entry.place) &&
      (
        !addressNumberKeys.length ||
        socialImportAddressNumberMatches(entry.place?.formattedAddress || '', addressNumberKeys)
      )
    ))
    .map((entry) => ({
      ...entry,
      resolveScore: Number((
        entry.confidence +
        getSocialImportSignalSourceWeight(signal?.source) +
        (Number(entry.place?.reviewsCount || 0) > 0 ? 0.02 : 0)
      ).toFixed(2)),
    }))
    .sort((a, b) => b.resolveScore - a.resolveScore);

  const best = ranked[0];
  if (!best || best.confidence < 0.5 || best.resolveScore < 0.6) return null;
  return best;
}

function normalizeSocialImportHandle(value = '') {
  return String(value || '')
    .trim()
    .replace(/^@/, '')
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, '')
    .slice(0, 60);
}

function socialImportProfileUrlForHandle(handle = '', source = '') {
  const safeHandle = normalizeSocialImportHandle(handle);
  if (!safeHandle) return '';
  const platform = String(source || '').trim().toLowerCase();
  if (platform === 'tiktok') return `https://www.tiktok.com/@${safeHandle}`;
  return `https://www.instagram.com/${safeHandle}/`;
}

function decodeHtmlEntities(value = '') {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code) => {
      const parsed = String(code || '').toLowerCase().startsWith('x')
        ? Number.parseInt(String(code).slice(1), 16)
        : Number.parseInt(String(code), 10);
      if (!Number.isFinite(parsed)) return '';
      try {
        return String.fromCodePoint(parsed);
      } catch (err) {
        return '';
      }
    })
    .replace(/\r\n/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractHtmlAttribute(tag = '', attribute = '') {
  const regex = new RegExp(`\\b${escapeRegExp(attribute)}\\s*=\\s*(['"])([\\s\\S]*?)\\1`, 'i');
  const match = String(tag || '').match(regex);
  return match?.[2] ? decodeHtmlEntities(match[2]) : '';
}

function extractMetaContent(html = '', keys = []) {
  const wanted = new Set(keys.map((key) => String(key || '').trim().toLowerCase()).filter(Boolean));
  const out = {};
  const tags = String(html || '').match(/<meta\s+[^>]*>/gi) || [];
  for (const tag of tags) {
    const key = (
      extractHtmlAttribute(tag, 'property') ||
      extractHtmlAttribute(tag, 'name')
    ).toLowerCase();
    if (!key || !wanted.has(key)) continue;
    const content = extractHtmlAttribute(tag, 'content');
    if (content) out[key] = content;
  }
  return out;
}

function extractJsonStringField(html = '', field = '') {
  const escapedField = escapeRegExp(field);
  const patterns = [
    new RegExp(`"${escapedField}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, 'i'),
    new RegExp(`\\\\?"${escapedField}\\\\?"\\s*:\\s*\\\\?"((?:\\\\.|[^"\\\\])*)\\\\?"`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = String(html || '').match(pattern);
    if (!match?.[1]) continue;
    try {
      return decodeHtmlEntities(JSON.parse(`"${match[1].replace(/"/g, '\\"')}"`));
    } catch (err) {
      return decodeHtmlEntities(match[1].replace(/\\u([0-9a-f]{4})/gi, (_, hex) => (
        String.fromCharCode(Number.parseInt(hex, 16))
      )).replace(/\\\//g, '/').replace(/\\"/g, '"'));
    }
  }
  return '';
}

function extractJsonBooleanField(html = '', field = '') {
  const pattern = new RegExp(`"${escapeRegExp(field)}"\\s*:\\s*(true|false)`, 'i');
  const match = String(html || '').match(pattern);
  return match?.[1] ? match[1].toLowerCase() === 'true' : null;
}

function scoreSocialImportProfileBusinessLike(profile = {}) {
  const haystack = normalizeComparableText([
    profile.handle,
    profile.displayName,
    profile.biography,
    profile.category,
    profile.externalUrl,
  ].filter(Boolean).join(' '));
  if (!haystack) return 0;

  let score = 0;
  const tokens = new Set(haystack.split(' ').filter(Boolean));
  for (const term of SOCIAL_IMPORT_BUSINESS_TERMS) {
    if (tokens.has(term) || haystack.includes(term)) score += 0.12;
  }
  if (profile.isBusinessAccount === true) score += 0.32;
  if (profile.category) score += 0.14;
  if (profile.externalUrl) score += 0.08;
  if (normalizeComparableText(profile.displayName || '') !== normalizeComparableText(profile.handle || '')) score += 0.06;

  return Math.max(0, Math.min(1, Number(score.toFixed(2))));
}

function parseInstagramProfileMetadata(html = '', handle = '') {
  const metas = extractMetaContent(html, [
    'description',
    'og:description',
    'og:title',
    'twitter:title',
  ]);
  const title = metas['og:title'] || metas['twitter:title'] || '';
  const description = metas['og:description'] || metas.description || '';

  let displayName = '';
  const titleMatch = title.match(/^(.+?)(?:\s+\(@[^)]+\))?\s+(?:on Instagram|• Instagram)/i);
  if (titleMatch?.[1]) displayName = titleMatch[1].trim();
  if (!displayName && title) displayName = title.replace(/\s*•\s*Instagram.*$/i, '').trim();

  const biography = extractJsonStringField(html, 'biography');
  const category = extractJsonStringField(html, 'category_name') || extractJsonStringField(html, 'category');
  const externalUrl = extractJsonStringField(html, 'external_url') || extractJsonStringField(html, 'external_url_linkshimmed');
  const isBusinessAccount = extractJsonBooleanField(html, 'is_business_account');

  const profile = {
    platform: 'instagram',
    handle: normalizeSocialImportHandle(handle),
    url: socialImportProfileUrlForHandle(handle, 'instagram'),
    displayName: normalizeSocialImportLabel(displayName) || normalizeSocialImportLabel(handle),
    biography: String(biography || description || '').slice(0, 500).trim(),
    category: normalizeSocialImportLabel(category),
    externalUrl: String(externalUrl || '').trim(),
    isBusinessAccount,
    fetchedAt: new Date(),
  };
  profile.businessScore = scoreSocialImportProfileBusinessLike(profile);
  profile.isBusinessLike = profile.businessScore >= 0.26;
  return profile;
}

function shouldFetchSocialImportUrlMetadata(url = '', source = '') {
  const normalizedSource = normalizeSocialImportSource(source, url);
  if (!['instagram', 'tiktok'].includes(normalizedSource)) return false;
  try {
    const parsed = new URL(String(url || '').trim());
    const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    return host === 'instagram.com' ||
      host.endsWith('.instagram.com') ||
      host === 'tiktok.com' ||
      host.endsWith('.tiktok.com');
  } catch (err) {
    return false;
  }
}

function extractSocialImportMetadataTextFromHtml(html = '') {
  const metas = extractMetaContent(html, [
    'description',
    'og:description',
    'og:title',
    'twitter:title',
    'keywords',
  ]);
  const ordered = [
    ['description', metas.description],
    ['og:description', metas['og:description']],
    ['og:title', metas['og:title']],
    ['twitter:title', metas['twitter:title']],
    ['keywords', metas.keywords],
  ];

  return ordered
    .map(([key, value]) => {
      const normalized = String(value || '').trim();
      return normalized ? `${key}: ${normalized}` : '';
    })
    .filter(Boolean)
    .join('\n');
}

async function fetchSocialImportUrlMetadataText(url = '', source = '') {
  const normalizedUrl = normalizeSocialImportUrl(url) || String(url || '').trim();
  if (!shouldFetchSocialImportUrlMetadata(normalizedUrl, source)) return '';

  const cached = SOCIAL_IMPORT_URL_METADATA_CACHE.get(normalizedUrl);
  if (cached && Date.now() - cached.cachedAt < SOCIAL_IMPORT_URL_METADATA_CACHE_TTL_MS) {
    return cached.text || '';
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SOCIAL_IMPORT_URL_METADATA_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(normalizedUrl, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      },
    });
    if (!response.ok) return '';
    const html = await response.text();
    const text = extractSocialImportMetadataTextFromHtml(html).slice(0, 5000);
    SOCIAL_IMPORT_URL_METADATA_CACHE.set(normalizedUrl, {
      text,
      cachedAt: Date.now(),
    });
    return text;
  } catch (err) {
    return '';
  } finally {
    clearTimeout(timeout);
  }
}

async function buildSocialImportResolverText(payload = {}, options = {}) {
  const rawText = String(payload?.text || '').trim();
  const url = String(options?.url || payload?.url || '').trim();
  const source = normalizeSocialImportSource(options?.source || payload?.source, url);
  const fetchedText = await fetchSocialImportUrlMetadataText(url, source);
  const parts = [fetchedText, rawText].filter(Boolean);
  if (!parts.length) return '';

  const seen = new Set();
  return parts
    .join('\n')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      const key = line.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join('\n')
    .slice(0, 7000);
}

async function fetchSocialImportProfile(handle = '', options = {}) {
  const source = normalizeSocialImportSource(options?.source, options?.url);
  const normalizedHandle = normalizeSocialImportHandle(handle);
  const profileUrl = socialImportProfileUrlForHandle(normalizedHandle, source);
  if (!normalizedHandle || !profileUrl || source !== 'instagram') return null;

  const cacheKey = `${source}:${normalizedHandle}`;
  const cached = SOCIAL_IMPORT_PROFILE_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < SOCIAL_IMPORT_PROFILE_CACHE_TTL_MS) {
    return cached.profile;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SOCIAL_IMPORT_PROFILE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(profileUrl, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      },
    });
    if (!response.ok) return null;
    const html = await response.text();
    const profile = parseInstagramProfileMetadata(html, normalizedHandle);
    SOCIAL_IMPORT_PROFILE_CACHE.set(cacheKey, {
      profile,
      cachedAt: Date.now(),
    });
    return profile;
  } catch (err) {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function sanitizeSocialImportProfileForStorage(profile = null) {
  if (!profile || typeof profile !== 'object') return undefined;
  return {
    platform: String(profile.platform || '').trim() || undefined,
    handle: normalizeSocialImportHandle(profile.handle),
    url: String(profile.url || '').trim() || undefined,
    displayName: String(profile.displayName || '').trim().slice(0, 120) || undefined,
    biography: String(profile.biography || '').trim().slice(0, 500) || undefined,
    category: String(profile.category || '').trim().slice(0, 120) || undefined,
    externalUrl: String(profile.externalUrl || '').trim().slice(0, 300) || undefined,
    isBusinessLike: !!profile.isBusinessLike,
    fetchedAt: profile.fetchedAt || new Date(),
  };
}

async function enrichSocialImportMentionLabels(labels = [], options = {}) {
  const out = Array.isArray(labels) ? labels.map((item) => ({ ...item })) : [];
  const mentionIndexes = out
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => ['mention', 'handle', 'account'].includes(String(item?.source || '').trim().toLowerCase()))
    .slice(0, 5);

  await Promise.all(mentionIndexes.map(async ({ item, index }) => {
    const handle = normalizeSocialImportHandle(item?.handle || item?.label);
    if (!handle) return;
    const profile = await fetchSocialImportProfile(handle, options);
    if (!profile) return;

    const storedProfile = sanitizeSocialImportProfileForStorage(profile);
    const displayName = normalizeSocialImportLabel(profile.displayName || '');
    const context = [
      item.context,
      profile.category,
      profile.biography,
    ].filter(Boolean).join(' ');

    out[index] = {
      ...item,
      label: profile.isBusinessLike && displayName ? displayName : item.label,
      source: profile.isBusinessLike ? 'mention_profile' : item.source,
      context: normalizeSocialImportLabel(context) || item.context,
      profile: storedProfile,
      handle,
    };
  }));

  return out;
}

function isExplicitSocialImportListSource(source = '') {
  return SOCIAL_IMPORT_EXPLICIT_LIST_SOURCES.has(String(source || '').trim().toLowerCase());
}

function isHighPrioritySocialImportMediaSource(source = '') {
  return ['audio_transcript', 'ocr', 'transcript', 'video_ocr', 'visible_text']
    .includes(String(source || '').trim().toLowerCase());
}

function shouldResolveSocialImportLabel(item = {}, labels = []) {
  void item;
  void labels;
  return true;
}

function prioritizeSocialImportLabels(labels = []) {
  return (Array.isArray(labels) ? labels : [])
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const sourceDiff = getSocialImportSignalSourceWeight(b.item?.source) -
        getSocialImportSignalSourceWeight(a.item?.source);
      if (sourceDiff) return sourceDiff;

      const contextDiff = Number(!!b.item?.context) - Number(!!a.item?.context);
      if (contextDiff) return contextDiff;

      return a.index - b.index;
    })
    .map((entry) => entry.item);
}

function buildSocialImportGoogleSearchQuery(label = '', item = {}, locationContext = null, aiLocationContext = null) {
  const expandedLabel = expandCompactSocialImportSearchLabel(label);
  const aiLocationTerms = buildAiLocationTerms(aiLocationContext);
  return [
    label,
    expandedLabel && expandedLabel !== label ? expandedLabel : '',
    item?.context || '',
    item?.profile?.displayName || '',
    item?.profile?.category || '',
    locationContext?.name || '',
    aiLocationTerms,
  ].filter(Boolean).join(' ').slice(0, 240);
}

function expandCompactSocialImportSearchLabel(label = '') {
  const raw = String(label || '').trim();
  if (/[^\x00-\x7F]/.test(raw)) return raw;

  const normalized = normalizeComparableText(label);
  if (!normalized || normalized.includes(' ')) return normalized;

  const terms = Array.from(new Set([
    ...SOCIAL_IMPORT_GENERIC_TERMS,
    ...SOCIAL_IMPORT_LOCATION_TERMS,
  ]))
    .filter((term) => term.length >= 4)
    .sort((a, b) => b.length - a.length);

  let expanded = normalized;
  for (const term of terms) {
    expanded = expanded.replace(new RegExp(`(${escapeRegExp(term)})`, 'g'), ' $1 ');
  }

  return expanded
    .replace(/\s+/g, ' ')
    .trim();
}

function isResolvableGoogleActivityPlace(place = {}) {
  const types = new Set(
    (Array.isArray(place?.types) ? place.types : [])
      .map((type) => String(type || '').trim().toLowerCase())
      .filter(Boolean)
  );
  if (!types.size) return true;

  const areaTypes = [
    'locality',
    'sublocality',
    'neighborhood',
    'administrative_area_level_1',
    'administrative_area_level_2',
    'administrative_area_level_3',
    'country',
    'political',
  ];
  const concreteTypes = [
    'establishment',
    'point_of_interest',
    'tourist_attraction',
    'restaurant',
    'cafe',
    'bar',
    'museum',
    'park',
    'lodging',
    'store',
    'shopping_mall',
    'place_of_worship',
    'transit_station',
  ];

  const isArea = areaTypes.some((type) => types.has(type));
  const isConcrete = concreteTypes.some((type) => types.has(type));
  return !isArea || isConcrete;
}

function isGenericSocialImportLabel(label = '') {
  const normalized = normalizeComparableText(label);
  if (!normalized || normalized.includes(' ')) return false;
  return SOCIAL_IMPORT_GENERIC_TERMS.has(normalized);
}

function isGenericLocationCompoundSocialImportLabel(label = '', location = null) {
  const normalized = normalizeComparableText(label);
  if (!normalized || !normalized.includes(' ')) return false;

  const locationTokens = new Set(
    normalizeComparableText(location?.label || location?.name || '')
      .split(' ')
      .filter(Boolean)
  );
  const tokens = normalized.split(' ').filter(Boolean);
  if (tokens.length < 2) return false;

  return tokens.every((token) => (
    SOCIAL_IMPORT_GENERIC_TERMS.has(token) ||
    SOCIAL_IMPORT_LOCATION_TERMS.has(token) ||
    locationTokens.has(token)
  ));
}

async function isSocialImportContextOnlyLabel(label = '', location = null, labelsCount = 0) {
  const normalized = normalizeComparableText(label);
  if (!normalized) return true;

  const locationLabel = normalizeComparableText(location?.label || location?.name || '');
  if (locationLabel && normalized === locationLabel) return true;

  if (isGenericSocialImportLabel(label)) return true;
  if (isGenericLocationCompoundSocialImportLabel(label, location)) return true;
  if (Number(labelsCount) > 1 && SOCIAL_IMPORT_LOCATION_TERMS.has(normalized)) return true;

  const zone = await findBestZoneForSocialImportTerm(label);
  return !!zone?._id;
}

function absoluteRequestUrl(req, path = '') {
  const rawPath = String(path || '').trim();
  if (!rawPath) return '';
  if (/^https?:\/\//i.test(rawPath)) return rawPath;

  const host = req.get('x-forwarded-host') || req.get('host');
  if (!host) return rawPath;
  const proto = String(req.get('x-forwarded-proto') || req.protocol || 'https')
    .split(',')[0]
    .trim() || 'https';
  return `${proto}://${host}${rawPath.startsWith('/') ? rawPath : `/${rawPath}`}`;
}

function buildSocialImportPreviewMedia(place = {}, req) {
  const coverPath = String(place?.photoUrl || place?.photos?.[0]?.url || '').trim();
  if (!coverPath) return undefined;
  return {
    coverUrl: absoluteRequestUrl(req, coverPath),
    source: 'google_places_photo',
  };
}

function socialImportNeedsMediaAnalysis(labels = [], resolvedCandidates = [], unresolved = []) {
  if (Array.isArray(resolvedCandidates) && resolvedCandidates.length) return false;
  const hasExplicitTextSignal = Array.isArray(labels) && labels.some((item) => (
    isExplicitSocialImportListSource(item?.source) ||
    ['mention_profile', 'business_profile', 'place', 'pin', 'recommendation'].includes(String(item?.source || '').trim().toLowerCase())
  ));
  if (hasExplicitTextSignal) return false;

  const reasons = new Set((Array.isArray(unresolved) ? unresolved : [])
    .map((item) => String(item?.reason || '').trim())
    .filter(Boolean));
  return reasons.has('weak_discovery_signal_needs_media_analysis') ||
    !Array.isArray(labels) ||
    labels.length === 0;
}

function selectBestSocialImportPreviewResults(rows = [], options = {}) {
  const byPlaceId = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const placeId = String(row?.googleCache?.placeId || '').trim();
    if (!placeId) continue;

    const existing = byPlaceId.get(placeId);
    if (!existing || Number(row?._socialImport?.resolveScore || 0) > Number(existing?._socialImport?.resolveScore || 0)) {
      byPlaceId.set(placeId, row);
    }
  }

  let filtered = Array.from(byPlaceId.values())
    .filter((row) => (
      Number(row?._socialImport?.confidence || 0) >= 0.62 &&
      Number(row?._socialImport?.resolveScore || 0) >= 0.72
    ));

  const maxResults = options?.hasMultiPlaceSignal
    ? Math.min(25, Math.max(1, Number(options?.limit || 20)))
    : Math.min(10, Math.max(1, Number(options?.limit || 5)));

  return filtered
    .sort((a, b) => {
      if (options?.hasMultiPlaceSignal) {
        const aSequence = Number(a?._socialImport?.sequence);
        const bSequence = Number(b?._socialImport?.sequence);
        const aHasSequence = Number.isFinite(aSequence);
        const bHasSequence = Number.isFinite(bSequence);
        if (aHasSequence && bHasSequence && aSequence !== bSequence) return aSequence - bSequence;
        if (aHasSequence !== bHasSequence) return aHasSequence ? -1 : 1;
      }

      const resolveDiff = Number(b?._socialImport?.resolveScore || 0) - Number(a?._socialImport?.resolveScore || 0);
      if (resolveDiff) return resolveDiff;
      const confidenceDiff = Number(b?._socialImport?.confidence || 0) - Number(a?._socialImport?.confidence || 0);
      if (confidenceDiff) return confidenceDiff;
      return Number(b?.ranking?.priority || 0) - Number(a?.ranking?.priority || 0);
    })
    .slice(0, maxResults);
}

function hasMultiPlaceSignalFromAiLabels(labels = []) {
  const rows = Array.isArray(labels) ? labels : [];
  if (!rows.length) return false;

  const exactOrPrimary = rows.filter((row) => (
    String(row?.type || '').trim().toLowerCase() === 'exact_place' ||
    String(row?.source || '').trim().toLowerCase() === 'ai_primary'
  ));

  const confident = exactOrPrimary.filter((row) => {
    const c = String(row?.confidence || '').trim().toLowerCase();
    return c === 'high' || c === 'medium';
  });

  return confident.length >= 2;
}

function socialImportNameTokenOverlapScore(left = '', right = '') {
  const leftTokens = new Set(getSpecificSocialImportTokens(left));
  const rightTokens = getSpecificSocialImportTokens(right);
  if (!leftTokens.size || !rightTokens.length) return 0;

  const hits = rightTokens.filter((token) => leftTokens.has(token)).length;
  return hits / Math.max(1, Math.min(leftTokens.size, rightTokens.length));
}

function hasMeaningfulSocialImportNameMatch(candidateName = '', targetNames = []) {
  const candidate = normalizeComparableText(candidateName);
  if (!candidate) return false;

  for (const rawTarget of Array.isArray(targetNames) ? targetNames : [targetNames]) {
    const target = normalizeComparableText(rawTarget);
    if (!target) continue;

    if (candidate === target) return true;
    if (
      candidate.length >= 4 &&
      target.length >= 4 &&
      (candidate.includes(target) || target.includes(candidate))
    ) {
      return true;
    }

    if (socialImportNameTokenOverlapScore(candidate, target) >= 0.5) {
      return true;
    }
  }

  return false;
}

async function findExistingActivityForGoogleCache(googleCache = {}, label = '', location = null) {
  const candidates = [];
  const geo = googleCache?.geo;

  if (validGeoPoint(geo)) {
    try {
      const nearby = await Activity.find({
        'location.geo': {
          $near: {
            $geometry: geo,
            $maxDistance: 120,
          },
        },
      })
        .select('_id name nameSource slug location audit active visibility sourceClaims googleCache ranking')
        .limit(12)
        .lean();
      candidates.push(...nearby);
    } catch (err) {
      console.warn('[socialImport] nearby dedupe failed', err?.message || err);
    }
  }

  const labelSlug = slugify(label || googleCache?.name || '');
  if (labelSlug) {
    const slugQuery = { slug: labelSlug };
    const zoneId = normalizeObjectIdString(location?._id);
    if (zoneId) {
      slugQuery.$or = [
        { 'location.primaryZoneId': zoneId },
        { 'location.zonePathIds': zoneId },
      ];
    }
    const bySlug = await Activity.find(slugQuery)
      .select('_id name nameSource slug location audit active visibility sourceClaims googleCache ranking')
      .limit(5)
      .lean();
    candidates.push(...bySlug);
  }

  const seen = new Set();
  const uniqueCandidates = candidates.filter((candidate) => {
    const id = String(candidate?._id || '');
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  const target = label || googleCache?.name || '';
  const googlePlaceId = String(googleCache?.placeId || '').trim();
  const targetNames = Array.from(new Set([
    target,
    googleCache?.name,
  ].map((value) => String(value || '').trim()).filter(Boolean)));
  const googleNameSlug = slugify(googleCache?.name || '');
  let best = null;
  let bestScore = 0;
  for (const candidate of uniqueCandidates) {
    const candidatePlaceId = String(candidate?.googleCache?.placeId || '').trim();
    if (googlePlaceId && candidatePlaceId && candidatePlaceId === googlePlaceId) {
      return candidate;
    }

    const slugMatches = !!candidate?.slug && (
      candidate.slug === labelSlug ||
      (googleNameSlug && candidate.slug === googleNameSlug)
    );
    const nameMatches = [
      candidate?.name,
      candidate?.googleCache?.name,
    ].some((candidateName) => hasMeaningfulSocialImportNameMatch(candidateName, targetNames));

    // Nearby coordinates alone are not enough. Dense buildings can contain many
    // activities, so the name or Google place id must also line up.
    if (!slugMatches && !nameMatches) continue;

    const score = scoreGoogleCachePlaceMatch(
      {
        name: candidate?.name,
        formattedAddress: candidate?.location?.address || '',
        geo: candidate?.location?.geo,
      },
      target,
      googleCache?.formattedAddress || ''
    );
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return bestScore >= 0.62 ? best : null;
}

function inferActivityTypeFromGoogleTypes(types = []) {
  const set = new Set(
    (Array.isArray(types) ? types : [])
      .map((type) => String(type || '').trim().toLowerCase())
      .filter(Boolean)
  );

  if (['lodging', 'hotel', 'hostel', 'campground', 'rv_park'].some((type) => set.has(type))) {
    return 'accommodation';
  }
  if ([
    'restaurant',
    'cafe',
    'bar',
    'bakery',
    'meal_delivery',
    'meal_takeaway',
    'night_club',
    'food',
  ].some((type) => set.has(type))) {
    return 'food_drinks';
  }
  if ([
    'airport',
    'bus_station',
    'train_station',
    'subway_station',
    'transit_station',
    'taxi_stand',
    'car_rental',
  ].some((type) => set.has(type))) {
    return 'transport';
  }
  if ([
    'atm',
    'bank',
    'pharmacy',
    'hospital',
    'laundry',
    'supermarket',
    'convenience_store',
    'travel_agency',
  ].some((type) => set.has(type))) {
    return 'practical_services';
  }
  if ([
    'tourist_attraction',
    'museum',
    'art_gallery',
    'park',
    'amusement_park',
    'aquarium',
    'zoo',
    'place_of_worship',
  ].some((type) => set.has(type))) {
    return 'experience';
  }
  return 'place';
}

function buildGoogleCacheSocialSourceClaim(candidate = {}, options = {}) {
  const source = normalizeSocialImportSource(options.source, options.url);
  const label = String(candidate?.label || candidate?.googleCache?.name || '').trim();
  const text = String(options?.text || '').trim();
  const evidence = String(candidate?.evidence || text || '').trim();
  const confidence = Number.isFinite(Number(candidate?.confidence))
    ? Math.max(0, Math.min(1, Number(candidate.confidence)))
    : 0.72;

  return {
    source,
    url: String(options.url || '').trim() || undefined,
    extractedName: label || undefined,
    extractedContext: text ? text.slice(0, 500) : undefined,
    evidenceText: evidence ? evidence.slice(0, 500) : undefined,
    confidence,
    status: 'pending',
    importedAt: new Date(),
    socialProfile: sanitizeSocialImportProfileForStorage(candidate?.profile),
  };
}

function buildSocialImportActivityExternalRefId(options = {}) {
  const source = normalizeSocialImportSource(options.source, options.normalizedUrl || '');
  const postId = String(options.postId || '').trim() || shortHash(options.normalizedUrl || '');
  const labelSlug = slugify(options.label || 'activity').slice(0, 64);
  return `${source}:${postId}:${labelSlug || shortHash(options.label || '')}`;
}

function normalizeSocialImportLabel(value = '') {
  const label = String(value || '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/[@#]/g, '')
    .replace(/[_]+/g, ' ')
    .replace(/[\\/]+/g, ' ')
    .replace(/([a-z0-9])\.([a-z0-9])/gi, '$1 $2')
    .replace(/[|•·]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[,.:;\-\s]+|[,.:;\-\s]+$/g, '');

  if (label.length < 3 || label.length > 80) return '';

  const blocked = new Set([
    'instagram',
    'tiktok',
    'reels',
    'reel',
    'video',
    'photo',
    'share',
    'travel',
    'vacation',
    'fyp',
    'viral',
    'explore',
    'ibeento',
  ]);
  if (blocked.has(label.toLowerCase())) return '';
  return label;
}

function normalizeSocialImportContext(value = '') {
  return String(value || '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/[@#]/g, '')
    .replace(/[_]+/g, ' ')
    .replace(/[\\/]+/g, ' ')
    .replace(/[|•·]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[,.:;\-\s]+|[,.:;\-\s]+$/g, '')
    .slice(0, 240);
}

function extractSocialImportLabels(payload = {}) {
  const out = [];
  const seen = new Map();
  const add = (label, source = 'text', extra = {}) => {
    const cleaned = normalizeSocialImportLabel(label);
    if (!cleaned) return;
    const key = cleaned.toLowerCase();
    const context = normalizeSocialImportContext(extra?.context || '');
    const sequence = Number(extra?.sequence);
    const profile = sanitizeSocialImportProfileForStorage(extra?.profile);
    const handle = normalizeSocialImportHandle(extra?.handle || '');
    const existingIndex = seen.get(key);
    if (existingIndex !== undefined) {
      const existing = out[existingIndex];
      const incomingWeight = getSocialImportSignalSourceWeight(source);
      const existingWeight = getSocialImportSignalSourceWeight(existing?.source);
      if (context && !existing.context) existing.context = context;
      if (Number.isFinite(sequence) && !Number.isFinite(Number(existing.sequence))) existing.sequence = sequence;
      if (profile && !existing.profile) existing.profile = profile;
      if (handle && !existing.handle) existing.handle = handle;
      if (incomingWeight > existingWeight) existing.source = source;
      return;
    }

    seen.set(key, out.length);
    out.push({
      label: cleaned,
      source,
      ...(context ? { context } : {}),
      ...(Number.isFinite(sequence) ? { sequence } : {}),
      ...(profile ? { profile } : {}),
      ...(handle ? { handle } : {}),
    });
  };

  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      add(candidate, 'candidate');
    } else if (candidate && typeof candidate === 'object') {
      add(candidate.label || candidate.name || candidate.extractedName || '', candidate.source || 'candidate', {
        context: candidate.context,
        sequence: candidate.sequence,
        profile: candidate.profile,
        handle: candidate.handle,
      });
    }
  }

  return out.slice(0, 24);
}

function zoneTypePriority(zone = {}) {
  const type = String(zone?.taxonomySnapshot?.canonicalType || zone?.type || '').trim().toLowerCase();
  if (type === 'city') return 100;
  if (type === 'town') return 94;
  if (type === 'village') return 88;
  if (type === 'locality') return 82;
  if (type === 'district') return 76;
  if (type === 'neighborhood' || type === 'subdistrict') return 70;
  if (type === 'region' || type === 'province' || type === 'state') return 64;
  if (type === 'country') return 58;
  return 40;
}

async function findBestZoneForSocialImportTerm(term = '') {
  const label = normalizeSocialImportLabel(term);
  if (!label) return null;
  const slug = slugify(label);
  const exactName = new RegExp(`^${escapeRegExp(label)}$`, 'i');
  const query = {
    active: { $ne: false },
    $or: [
      { name: exactName },
      { officialName: exactName },
      ...(slug ? [{ slug }] : []),
    ],
  };

  const rows = await Zone.find(query)
    .select('_id name externalId taxonomySnapshot priority')
    .limit(10)
    .lean();
  if (!rows.length) return null;

  return rows
    .slice()
    .sort((a, b) => {
      const typeDiff = zoneTypePriority(b) - zoneTypePriority(a);
      if (typeDiff) return typeDiff;
      return Number(b?.priority || 0) - Number(a?.priority || 0);
    })[0] || null;
}

async function resolveSocialImportLocation(payload = {}) {
  const explicitLocation = payload?.location || null;
  const explicitId = normalizeObjectIdString(explicitLocation?._id || explicitLocation?.id);
  if (explicitId) {
    const zone = await Zone.findById(explicitId)
      .select('_id name externalId taxonomySnapshot priority')
      .lean();
    if (zone?._id) {
      return {
        _id: String(zone._id),
        type: String(zone?.taxonomySnapshot?.canonicalType || explicitLocation?.type || 'city'),
        label: zone.name,
      };
    }
  }

  const labels = Array.isArray(payload?.candidates)
    ? payload.candidates
        .map((candidate) => {
          if (!candidate || typeof candidate !== 'object') return null;
          const label = normalizeSocialImportLabel(candidate.label || candidate.name || '');
          if (!label) return null;
          return { label };
        })
        .filter(Boolean)
    : [];
  const matches = [];
  for (const item of labels) {
    const zone = await findBestZoneForSocialImportTerm(item.label);
    if (!zone?._id) continue;
    matches.push(zone);
  }

  if (!matches.length) return null;
  const selected = matches
    .slice()
    .sort((a, b) => {
      const typeDiff = zoneTypePriority(b) - zoneTypePriority(a);
      if (typeDiff) return typeDiff;
      return Number(b?.priority || 0) - Number(a?.priority || 0);
    })[0];

  return {
    _id: String(selected._id),
    type: String(selected?.taxonomySnapshot?.canonicalType || 'city'),
    label: selected.name,
  };
}

function buildSocialSourceClaim(candidate = {}, externalRef = null, options = {}) {
  const importOptions = options?.sourceClaim || {};
  const source = normalizeSocialImportSource(importOptions.source, importOptions.url);
  const externalId = String(candidate?.externalId || candidate?._preview?.placeId || '').trim();
  const extractedName = String(candidate?._socialImport?.originalLabel || candidate?.name || '').trim();
  const context = String(importOptions.text || '').trim();
  const classMatched = !!candidate?._preview?.classMatched;
  const confidence = externalRef?.provider === 'wikidata'
    ? (classMatched ? 0.86 : 0.72)
    : 0.55;

  return {
    source,
    url: String(importOptions.url || '').trim() || undefined,
    externalId: externalId || undefined,
    extractedName: extractedName || undefined,
    extractedContext: context ? context.slice(0, 500) : undefined,
    evidenceText: String(candidate?.description || '').trim() || undefined,
    confidence,
    status: importOptions.status || 'pending',
    importedAt: new Date(),
  };
}

function hasEquivalentSourceClaim(activityDoc = {}, claim = {}) {
  const claims = Array.isArray(activityDoc?.sourceClaims) ? activityDoc.sourceClaims : [];
  const source = String(claim?.source || '').trim().toLowerCase();
  const url = String(claim?.url || '').trim();
  const externalId = String(claim?.externalId || '').trim();
  const extractedName = String(claim?.extractedName || '').trim().toLowerCase();

  return claims.some((existing) => {
    const existingSource = String(existing?.source || '').trim().toLowerCase();
    if (source && existingSource !== source) return false;
    const existingUrl = String(existing?.url || '').trim();
    const existingExternalId = String(existing?.externalId || '').trim();
    const existingName = String(existing?.extractedName || '').trim().toLowerCase();
    if (url && existingUrl && url === existingUrl && externalId && existingExternalId === externalId) return true;
    if (url && existingUrl && url === existingUrl && extractedName && existingName === extractedName) return true;
    if (!url && externalId && existingExternalId === externalId) return true;
    return false;
  });
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
      accessRequirement,
      mediaStatus,
      sourceClaims,
      limit = 50,
      offset = 0,
      sort // e.g. "priority:asc,ratingAvg:desc"
    } = req.query;

    const filter = {};
    const andFilters = [];
    const addAndFilter = (condition) => {
      if (condition && typeof condition === 'object') andFilters.push(condition);
    };

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

    if (accessRequirement) {
      const allowedRequirements = new Set([
        'unknown',
        'free',
        'ticket_required',
        'reservation_required',
        'reservation_recommended',
        'pay_on_site',
        'guided_service_available',
        'not_accessible',
      ]);
      const requirements = String(accessRequirement)
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => allowedRequirements.has(entry));
      if (requirements.length) {
        filter['accessHint.requirement'] = requirements.length === 1
          ? requirements[0]
          : { $in: Array.from(new Set(requirements)) };
      }
    }

    if (mediaStatus) {
      const normalizedMediaStatus = String(mediaStatus).trim();
      if (normalizedMediaStatus === 'missing_images') {
        addAndFilter({
          $expr: {
            $lt: [{ $size: { $ifNull: ['$media.images', []] } }, 10],
          },
        });
      } else if (normalizedMediaStatus === 'has_images') {
        addAndFilter({
          $expr: {
            $gt: [{ $size: { $ifNull: ['$media.images', []] } }, 0],
          },
        });
      } else if (normalizedMediaStatus === 'no_cover') {
        addAndFilter({
          $or: [
            { 'media.cover': { $exists: false } },
            { 'media.cover': null },
            { 'media.cover': '' },
          ],
        });
      } else if (normalizedMediaStatus === 'has_cover') {
        filter['media.cover'] = { $exists: true, $nin: [null, ''] };
      }
    }

    if (sourceClaims) {
      const normalizedSourceClaims = String(sourceClaims).trim().toLowerCase();
      if (normalizedSourceClaims === 'social') {
        addAndFilter({
          'sourceClaims.source': { $in: SOCIAL_SOURCE_CLAIM_VALUES },
        });
      } else if (normalizedSourceClaims === 'none') {
        addAndFilter({
          $or: [
            { sourceClaims: { $exists: false } },
            { sourceClaims: { $size: 0 } },
          ],
        });
      }
    }

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
    if (Object.keys(priceFilter).length) filter['accessHint.priceIndication.priceFrom'] = priceFilter;
    if (andFilters.length) filter.$and = andFilters;

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
          updatedAt: 'updatedAt',
          active: 'active',
          audit: 'audit.isAudited',
          name: 'name',
          priceFrom: 'accessHint.priceIndication.priceFrom'
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
    let socialImportStatsByActivityId = new Map();
    if (activityObjectIds.length) {
      const [counts, socialImportStats] = await Promise.all([
        Service.aggregate([
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
        ]),
        SocialImportLink.aggregate([
          { $unwind: '$resolvedActivities' },
          {
            $match: {
              'resolvedActivities.activityId': { $in: activityObjectIds },
            },
          },
          {
            $group: {
              _id: '$resolvedActivities.activityId',
              linkCount: { $sum: 1 },
              shareCount: { $sum: '$usage.shareCount' },
              uniqueUserCount: { $sum: '$usage.uniqueUserCount' },
              lastSharedAt: { $max: '$usage.lastSharedAt' },
            },
          },
        ]),
      ]);
      serviceCountByActivityId = new Map(
        (Array.isArray(counts) ? counts : []).map((row) => [
          String(row?._id || '').trim(),
          Number(row?.total || 0),
        ])
      );
      socialImportStatsByActivityId = new Map(
        (Array.isArray(socialImportStats) ? socialImportStats : []).map((row) => [
          String(row?._id || '').trim(),
          {
            linkCount: Number(row?.linkCount || 0),
            shareCount: Number(row?.shareCount || 0),
            uniqueUserCount: Number(row?.uniqueUserCount || 0),
            lastSharedAt: row?.lastSharedAt || null,
          },
        ])
      );
    }

    const enrichedResults = (Array.isArray(results) ? results : []).map((row) => ({
      ...row,
      serviceCount: serviceCountByActivityId.get(String(row?._id || '').trim()) || 0,
      socialImportStats: socialImportStatsByActivityId.get(String(row?._id || '').trim()) || undefined,
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
    const current = await Activity.findById(id).select('ownership externalRef').lean();
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

exports.acceptImportedActivity = async (req, res) => {
  try {
    const activityId = normalizeObjectIdString(req?.params?.id);
    if (!activityId) {
      return res.status(400).json({ success: false, message: 'Invalid activity id' });
    }

    const current = await Activity.findById(activityId).select('_id ownership sourceClaims name nameSource location googleCache').lean();
    if (!current?._id) {
      return res.status(404).json({ success: false, message: 'Activity not found' });
    }

    const writeAccess = await resolveActivityWriteAccess(current, req);
    if (!writeAccess.allowed) {
      return res.status(403).json({ success: false, message: writeAccess.reason || 'Forbidden' });
    }

    if (!hasSocialSourceClaim(current)) {
      return res.status(400).json({
        success: false,
        message: 'This activity does not have a social import source claim.',
      });
    }

    if (!activityHasCanonicalData(current)) {
      return res.status(400).json({
        success: false,
        message: 'Complete the canonical name, address, and coordinates before accepting this imported activity.',
      });
    }

    const now = new Date();
    const reviewerId = normalizeObjectIdString(req?.user?._id || req?.user?.id);
    const update = {
      $set: {
        active: true,
        visibility: 'public',
        'audit.isAudited': true,
        'audit.status': 'approved',
        'audit.auditedAt': now,
      },
    };
    if (reviewerId) {
      update.$set['audit.auditedBy'] = reviewerId;
    }

    const updated = await Activity.findOneAndUpdate(
      { _id: activityId, 'sourceClaims.source': { $in: SOCIAL_SOURCE_CLAIM_VALUES } },
      {
        ...update,
        $set: {
          ...update.$set,
          'sourceClaims.$[claim].status': 'accepted',
          'sourceClaims.$[claim].reviewedAt': now,
          ...(reviewerId ? { 'sourceClaims.$[claim].reviewedBy': reviewerId } : {}),
        },
      },
      {
        new: true,
        runValidators: true,
        arrayFilters: [{ 'claim.source': { $in: SOCIAL_SOURCE_CLAIM_VALUES } }],
      }
    );

    if (!updated) {
      return res.status(404).json({ success: false, message: 'Activity not found' });
    }

    return res.status(200).json({ success: true, data: updated });
  } catch (error) {
    console.error('Error accepting imported Activity:', error);
    const message = String(error?.message || '').trim() || 'Failed to accept imported Activity';
    return res.status(500).json({ success: false, message, error });
  }
};

exports.upsertNamesSlugsFromWikidata = async (req, res) => {
  try {
    const activityId = normalizeObjectIdString(req?.params?.id);
    if (!activityId) {
      return res.status(400).json({ success: false, message: 'Invalid activity id' });
    }

    const current = await Activity.findById(activityId)
      .select('_id name slug names slugs description location media activityCategoryIds externalRef sourceClaims accessHint ownership')
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

    const draftResult = await buildActivityDraftFromWikidataQid(qid);
    if (draftResult.errorStatus) {
      return res.status(draftResult.errorStatus).json({
        success: false,
        message: draftResult.errorMessage,
      });
    }
    const draft = draftResult.data || {};

    const fetchedNames = sanitizeLocaleMap(draft.names, { slug: false });
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

    const setOps = { names, slugs };
    const unsetOps = {};
    let fieldsFilled = 0;

    const setIfEmpty = (path, currentValue, nextValue) => {
      const hasCurrent = Array.isArray(currentValue)
        ? currentValue.length > 0
        : currentValue !== undefined && currentValue !== null && String(currentValue).trim() !== '';
      const hasNext = Array.isArray(nextValue)
        ? nextValue.length > 0
        : nextValue !== undefined && nextValue !== null && String(nextValue).trim() !== '';
      if (hasCurrent || !hasNext) return;
      setOps[path] = nextValue;
      fieldsFilled += 1;
    };

    setIfEmpty('description', current.description, draft.description);
    setIfEmpty('externalRef.provider', current?.externalRef?.provider, draft?.externalRef?.provider);
    setIfEmpty('externalRef.id', current?.externalRef?.id, draft?.externalRef?.id);
    setIfEmpty('externalRef.url', current?.externalRef?.url, draft?.externalRef?.url);
    setIfEmpty('location.primaryZoneId', current?.location?.primaryZoneId, draft?.location?.primaryZoneId);
    setIfEmpty('location.zonePathIds', current?.location?.zonePathIds, draft?.location?.zonePathIds);
    setIfEmpty('location.timeZone', current?.location?.timeZone, draft?.location?.timeZone);
    setIfEmpty('location.address', current?.location?.address, draft?.location?.address);
    setIfEmpty('location.addressSource', current?.location?.addressSource, draft?.location?.addressSource);
    setIfEmpty('location.geo', current?.location?.geo?.coordinates?.length ? current.location.geo : null, draft?.location?.geo);
    setIfEmpty('location.geoSource', current?.location?.geoSource, draft?.location?.geoSource);
    setIfEmpty('location.geoConfidence', current?.location?.geoConfidence, draft?.location?.geoConfidence);
    setIfEmpty('media.cover', current?.media?.cover, draft?.media?.cover);
    setIfEmpty('media.images', current?.media?.images, draft?.media?.images);
    setIfEmpty('activityCategoryIds', current?.activityCategoryIds, draft?.activityCategoryIds);
    setIfEmpty('accessHint.source', current?.accessHint?.source, draft?.accessHint?.source);

    if ((!Array.isArray(current?.sourceClaims) || !current.sourceClaims.length) && Array.isArray(draft.sourceClaims) && draft.sourceClaims.length) {
      setOps.sourceClaims = draft.sourceClaims;
      fieldsFilled += 1;
    }

    const update = { $set: setOps };
    if (Object.keys(unsetOps).length) update.$unset = unsetOps;

    const updated = await Activity.findByIdAndUpdate(activityId, update, { new: true, runValidators: true });
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
        fieldsFilled,
      },
    });
  } catch (error) {
    console.error('Error upserting activity localized names/slugs from Wikidata:', error);
    const message = String(error?.message || '').trim() || 'Failed to upsert names/slugs from Wikidata';
    return res.status(500).json({ success: false, message, error });
  }
};

exports.previewWikidataActivityDraft = async (req, res) => {
  try {
    const qid = normalizeQid(req?.body?.qid);
    if (!qid) {
      return res.status(400).json({
        success: false,
        message: 'Wikidata QID is required.',
      });
    }

    if (!isAdminUser(req)) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    const result = await buildActivityDraftFromWikidataQid(qid);
    if (result.errorStatus) {
      return res.status(result.errorStatus).json({
        success: false,
        message: result.errorMessage,
      });
    }

    return res.status(200).json({
      success: true,
      data: result.data,
      meta: result.meta,
    });
  } catch (error) {
    console.error('Error building Wikidata activity draft:', error);
    const message = String(error?.message || '').trim() || 'Failed to build Wikidata activity draft';
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

exports.startDiscoverPreviewPersistentWorker = startDiscoverPreviewPersistentWorker;
