#!/usr/bin/env node
/* eslint-disable no-console */
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeQid(value) {
  const qid = String(value || '').trim().toUpperCase();
  return /^Q\d+$/.test(qid) ? qid : null;
}

function parseArgs(argv) {
  const out = {
    qid: null,
    apiBase: process.env.DISCOVER_SCRIPT_API_BASE || process.env.API_BASE || 'http://localhost:4000/api',
    timeoutMs: 10 * 60 * 1000,
    pollMs: 1200,
    heartbeatMs: 20000,
    networkRetryAttempts: 8,
    networkRetryDelayMs: 1500,
    minActivities: 50,
    minSitelinks: null,
    force: false,
    skipIfZoneExists: true,
  };

  const args = Array.isArray(argv) ? [...argv] : [];
  while (args.length) {
    const token = args.shift();
    if (!token) continue;

    if (!out.qid && !token.startsWith('--')) {
      out.qid = token;
      continue;
    }

    if (token === '--api') {
      out.apiBase = String(args.shift() || '').trim() || out.apiBase;
      continue;
    }
    if (token === '--timeout-ms') {
      const raw = Number(args.shift());
      if (Number.isFinite(raw) && raw > 0) out.timeoutMs = Math.floor(raw);
      continue;
    }
    if (token === '--no-timeout') {
      out.timeoutMs = null;
      continue;
    }
    if (token === '--poll-ms') {
      const raw = Number(args.shift());
      if (Number.isFinite(raw) && raw > 0) out.pollMs = Math.floor(raw);
      continue;
    }
    if (token === '--heartbeat-ms') {
      const raw = Number(args.shift());
      if (Number.isFinite(raw) && raw > 0) out.heartbeatMs = Math.floor(raw);
      continue;
    }
    if (token === '--network-retry-attempts') {
      const raw = Number(args.shift());
      if (Number.isFinite(raw) && raw >= 1) out.networkRetryAttempts = Math.floor(raw);
      continue;
    }
    if (token === '--network-retry-delay-ms') {
      const raw = Number(args.shift());
      if (Number.isFinite(raw) && raw >= 100) out.networkRetryDelayMs = Math.floor(raw);
      continue;
    }
    if (token === '--min-activities') {
      const raw = Number(args.shift());
      if (Number.isFinite(raw) && raw >= 0) out.minActivities = Math.floor(raw);
      continue;
    }
    if (token === '--min-sitelinks') {
      const raw = Number(args.shift());
      if (Number.isFinite(raw) && raw >= 0) out.minSitelinks = Math.floor(raw);
      continue;
    }
    if (token === '--force') {
      out.force = true;
      continue;
    }
    if (token === '--continue-if-exists') {
      out.skipIfZoneExists = false;
      continue;
    }
    if (token === '--help' || token === '-h') {
      out.help = true;
      continue;
    }
  }

  return out;
}

function normalizeApiBase(input) {
  const raw = String(input || '').trim().replace(/\/+$/, '');
  if (!raw) return 'http://localhost:4000/api';
  return /\/api$/i.test(raw) ? raw : `${raw}/api`;
}

function extractErrorCode(err) {
  const code =
    err?.cause?.code ||
    err?.code ||
    err?.cause?.name ||
    null;
  return code ? String(code) : null;
}

function isRetryableFetchError(err) {
  const code = extractErrorCode(err);
  if (code) {
    const retryableCodes = new Set([
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      'EAI_AGAIN',
      'ENOTFOUND',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_SOCKET',
      'UND_ERR_ABORTED',
      'UND_ERR_DESTROYED',
    ]);
    if (retryableCodes.has(code)) return true;
  }
  const msg = String(err?.message || '').toLowerCase();
  return msg.includes('fetch failed') || msg.includes('network error');
}

async function fetchJson(url, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const headers = {
    Accept: 'application/json',
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers || {}),
  };

  const res = await fetch(url, {
    method,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await res.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch (_) {
      json = null;
    }
  }

  if (!res.ok) {
    const msgFromJson =
      (json && (json.message || json.error || json?.job?.error?.message)) || '';
    const err = new Error(
      `${method} ${url} failed (${res.status})${msgFromJson ? `: ${msgFromJson}` : ''}`
    );
    err.status = res.status;
    err.payload = json || text || null;
    throw err;
  }

  return json;
}

async function fetchJsonWithRetry(url, options = {}, retry = {}) {
  const attempts = Math.max(1, Number(retry?.attempts || 1));
  const retryHttpStatuses = new Set(
    Array.isArray(retry?.retryHttpStatuses) ? retry.retryHttpStatuses.map((s) => Number(s)) : []
  );
  let waitMs = Math.max(100, Number(retry?.initialDelayMs || 1200));
  const maxDelayMs = Math.max(waitMs, Number(retry?.maxDelayMs || 8000));
  const backoff = Math.max(1, Number(retry?.backoff || 1.4));
  let lastErr = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchJson(url, options);
    } catch (err) {
      lastErr = err;
      const status = Number(err?.status || 0);
      const retryableStatus = status > 0 && retryHttpStatuses.has(status);
      const retryableError = isRetryableFetchError(err);
      const shouldRetry = attempt < attempts && (retryableError || retryableStatus);
      if (!shouldRetry) break;

      if (typeof retry?.onRetry === 'function') {
        retry.onRetry({
          attempt,
          attempts,
          waitMs,
          status: Number.isFinite(status) ? status : null,
          code: extractErrorCode(err),
          message: String(err?.message || err),
        });
      }
      await sleep(waitMs);
      waitMs = Math.min(maxDelayMs, Math.round(waitMs * backoff));
    }
  }

  throw lastErr;
}

function getMongoUri() {
  return (
    process.env.MONGODB_URI ||
    process.env.MONGO_URI ||
    'mongodb://127.0.0.1:27017/travelplanner'
  );
}

async function findExistingZoneByQid(qid) {
  const mongoose = require('mongoose');
  const Zone = require('../src/models/Zone');
  const Activity = require('../src/models/Activity');
  const uri = getMongoUri();

  await mongoose.connect(uri);
  const doc = await Zone.findOne({
    externalId: String(qid || '').toUpperCase(),
  })
    .select('_id name source externalId taxonomySnapshot discoverPreviewSearched')
    .lean();

  let activitiesCount = 0;
  if (doc?._id) {
    activitiesCount = await Activity.countDocuments({
      active: true,
      'location.zonePathIds': doc._id,
    });
  }
  await mongoose.disconnect();

  if (!doc?._id) return null;
  return {
    _id: String(doc._id),
    name: doc.name || null,
    source: doc.source || null,
    externalId: doc.externalId || null,
    canonicalType: doc?.taxonomySnapshot?.canonicalType || null,
    discoverPreviewSearched: !!doc?.discoverPreviewSearched,
    activitiesCount: Number.isFinite(Number(activitiesCount)) ? Number(activitiesCount) : 0,
  };
}

function normalizeDiscoverLocationType(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 'city';
  if (raw === 'country') return 'country';
  if (raw === 'region' || raw === 'province' || raw === 'state' || raw === 'department' || raw === 'emirate') {
    return 'region';
  }
  if (raw === 'district' || raw === 'borough') return 'district';
  if (raw === 'neighborhood' || raw === 'locality' || raw === 'subdistrict' || raw === 'village') {
    return raw;
  }
  if (
    raw === 'city' ||
    raw === 'town' ||
    raw === 'commune' ||
    raw === 'municipality' ||
    raw === 'metropolis'
  ) {
    return 'city';
  }
  return 'city';
}

async function updateZoneDiscoverPreviewSearched(zoneId, value) {
  const mongoose = require('mongoose');
  const Zone = require('../src/models/Zone');

  const uri = getMongoUri();

  await mongoose.connect(uri);
  const current = await Zone.findById(zoneId)
    .select('_id name discoverPreviewSearched')
    .lean();

  await Zone.findByIdAndUpdate(zoneId, {
    $set: { discoverPreviewSearched: !!value },
  }).lean();

  const updated = await Zone.findById(zoneId)
    .select('_id name discoverPreviewSearched')
    .lean();

  await mongoose.disconnect();
  return {
    before: {
      id: current?._id ? String(current._id) : null,
      name: current?.name || null,
      discoverPreviewSearched: !!current?.discoverPreviewSearched,
    },
    after: {
      id: updated?._id ? String(updated._id) : null,
      name: updated?.name || null,
      discoverPreviewSearched: !!updated?.discoverPreviewSearched,
    },
  };
}

async function clearDiscoverPreviewFlagIfRequested(zoneId) {
  return updateZoneDiscoverPreviewSearched(zoneId, false);
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage:');
    console.log('  node scripts/run-discover-from-qid.js <QID> [options]');
    console.log('');
    console.log('Options:');
    console.log('  --api <url>           API base URL (default: http://localhost:4000/api)');
    console.log('  --timeout-ms <n>      Max wait for job result (default: 600000)');
    console.log('  --no-timeout          Wait indefinitely for job completion');
    console.log('  --poll-ms <n>         Job status poll interval (default: 1200)');
    console.log('  --heartbeat-ms <n>    Heartbeat interval while polling (default: 20000)');
    console.log('  --network-retry-attempts <n>  Retries for transient network errors (default: 8)');
    console.log('  --network-retry-delay-ms <n>  Initial retry delay in ms (default: 1500)');
    console.log('  --min-activities <n>  Minimum activities to skip discover (default: 50)');
    console.log('  --min-sitelinks <n>   Optional discoverControl.minSitelinks');
    console.log('  --force               Reset discoverPreviewSearched=false before discover');
    console.log('  --continue-if-exists  Continue even if zone with this QID already exists');
    process.exit(0);
  }

  const qid = normalizeQid(args.qid);
  if (!qid) {
    throw new Error('Missing/invalid QID. Example: Q5926838');
  }

  const apiBase = normalizeApiBase(args.apiBase);
  const startedAt = new Date().toISOString();

  console.log('[discover:qid] Starting', {
    qid,
    apiBase,
    startedAt,
    minActivities: args.minActivities,
  });

  const existingZone = await findExistingZoneByQid(qid);
  const existingActivitiesCount = Number(existingZone?.activitiesCount || 0);
  const hasEnoughActivities = existingActivitiesCount >= Number(args.minActivities || 50);
  let autoResetSummary = null;

  if (existingZone && args.skipIfZoneExists && hasEnoughActivities) {
    const finishedAt = new Date().toISOString();
    const summary = {
      ok: true,
      skipped: true,
      reason: 'zone_exists_with_enough_activities',
      startedAt,
      finishedAt,
      qid,
      apiBase,
      minActivities: args.minActivities,
      existingZone,
    };
    console.log('[discover:qid] Zone already exists and meets minimum activities threshold, stopping for this zone.');
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  if (existingZone && args.skipIfZoneExists && !hasEnoughActivities) {
    console.log(
      '[discover:qid] Zone exists but is below minimum activities threshold. Continuing to populate.',
      {
        ...existingZone,
        minActivities: args.minActivities,
      }
    );
    if (existingZone.discoverPreviewSearched) {
      console.log(
        '[discover:qid] Zone has discoverPreviewSearched=true while below threshold; resetting to false to force new search.'
      );
      autoResetSummary = await updateZoneDiscoverPreviewSearched(existingZone._id, false);
      console.log('[discover:qid] Auto reset summary', autoResetSummary);
    }
  }
  if (existingZone && !args.skipIfZoneExists) {
    console.log('[discover:qid] Zone already exists, but continuing by explicit flag.', existingZone);
  }

  let locationId = null;
  let locationType = null;
  let locationLabel = null;
  let resolveSource = 'api';
  if (existingZone?._id) {
    locationId = String(existingZone._id).trim();
    locationType = normalizeDiscoverLocationType(existingZone.canonicalType || 'city');
    locationLabel = String(existingZone.name || qid).trim();
    resolveSource = 'existing-zone';
    console.log('[discover:qid] Using existing zone as discover location', {
      id: locationId,
      type: locationType,
      label: locationLabel,
      canonicalType: existingZone.canonicalType || null,
    });
  } else {
    const resolveUrl = `${apiBase}/locations/resolve`;
    const resolved = await fetchJsonWithRetry(resolveUrl, {
      method: 'POST',
      body: {
        placeId: qid,
        source: 'wikidata',
      },
    }, {
      attempts: Math.max(1, Math.min(6, args.networkRetryAttempts)),
      initialDelayMs: args.networkRetryDelayMs,
      maxDelayMs: 6000,
      onRetry: ({ attempt, attempts, waitMs, code, message }) => {
        console.warn('[discover:qid] Retry resolve request', {
          attempt,
          attempts,
          waitMs,
          code,
          message,
        });
      },
    });

    locationId = String(resolved?._id || '').trim();
    locationType = String(resolved?.type || '').trim().toLowerCase();
    locationLabel = String(resolved?.label || '').trim();

    if (!locationId || !locationType || !locationLabel) {
      throw new Error(
        'Location resolve returned incomplete data. Expected _id, type and label.'
      );
    }

    console.log('[discover:qid] Resolved location from API', {
      id: locationId,
      type: locationType,
      label: locationLabel,
    });
  }

  let forceResetSummary = null;
  if (args.force) {
    console.log('[discover:qid] --force enabled, resetting discoverPreviewSearched=false');
    forceResetSummary = await clearDiscoverPreviewFlagIfRequested(locationId);
    console.log('[discover:qid] Zone flag updated', forceResetSummary);
  }

  const discoverPayload = {
    locations: [
      {
        _id: locationId,
        type: locationType,
        label: locationLabel,
      },
    ],
    ...(Number.isFinite(args.minSitelinks)
      ? { discoverControl: { minSitelinks: args.minSitelinks } }
      : {}),
  };

  const jobsStartUrl = `${apiBase}/activities/discover-preview/jobs`;
  const fallbackUrl = `${apiBase}/activities/discover-preview`;
  const timeoutAt =
    args.timeoutMs == null
      ? Number.POSITIVE_INFINITY
      : Date.now() + Number(args.timeoutMs);

  let mode = 'job';
  let resultData = [];
  let resultMeta = {};
  let jobSummary = null;

  try {
    const start = await fetchJsonWithRetry(jobsStartUrl, {
      method: 'POST',
      body: discoverPayload,
    }, {
      attempts: Math.max(1, Math.min(6, args.networkRetryAttempts)),
      initialDelayMs: args.networkRetryDelayMs,
      maxDelayMs: 6000,
      retryHttpStatuses: [502, 503, 504],
      onRetry: ({ attempt, attempts, waitMs, status, code, message }) => {
        console.warn('[discover:qid] Retry start job request', {
          attempt,
          attempts,
          waitMs,
          status,
          code,
          message,
        });
      },
    });

    const jobId = String(start?.job?.jobId || '').trim();
    if (!jobId) {
      throw new Error('Job start did not return jobId');
    }

    console.log('[discover:qid] Discover job started', { jobId });

    const statusUrl = `${apiBase}/activities/discover-preview/jobs/${encodeURIComponent(jobId)}`;
    const resultUrl = `${apiBase}/activities/discover-preview/jobs/${encodeURIComponent(jobId)}/result`;

    let lastStage = null;
    let lastPercent = null;
    let lastHeartbeatAt = 0;
    const discoverStartedAtMs = Date.now();
    while (Date.now() < timeoutAt) {
      const status = await fetchJsonWithRetry(statusUrl, { method: 'GET' }, {
        attempts: args.networkRetryAttempts,
        initialDelayMs: args.networkRetryDelayMs,
        maxDelayMs: 12000,
        retryHttpStatuses: [502, 503, 504],
        onRetry: ({ attempt, attempts, waitMs, status: httpStatus, code, message }) => {
          console.warn('[discover:qid] Poll retry (job status)', {
            attempt,
            attempts,
            waitMs,
            status: httpStatus,
            code,
            message,
          });
        },
      });
      const job = status?.job || {};
      const stage = String(job?.stage || '').trim();
      const percent = Number(job?.progress?.percent || 0);
      const statusText = String(job?.status || '').trim();
      const destinationsCompleted = Number(job?.progress?.destinationsCompleted || 0);
      const destinationsTotal = Number(job?.progress?.destinationsTotal || 0);
      const currentDestinationId = job?.progress?.currentDestinationId || null;
      const currentDestinationLabel = job?.progress?.currentDestinationLabel || null;
      const currentDestinationIndex = Number(job?.progress?.currentDestinationIndex || 0) || null;
      const currentStep = job?.progress?.currentStep || null;
      const elapsedSec = Math.floor((Date.now() - discoverStartedAtMs) / 1000);

      if (stage !== lastStage || percent !== lastPercent) {
        console.log('[discover:qid] Job progress', {
          status: statusText || null,
          stage: stage || null,
          percent: Number.isFinite(percent) ? percent : null,
          destinationsCompleted: Number.isFinite(destinationsCompleted) ? destinationsCompleted : null,
          destinationsTotal: Number.isFinite(destinationsTotal) ? destinationsTotal : null,
          currentDestinationIndex,
          currentDestinationId,
          currentDestinationLabel,
          currentStep,
          elapsedSec,
          message: job?.message || null,
        });
        lastStage = stage;
        lastPercent = percent;
        lastHeartbeatAt = Date.now();
      } else if (Date.now() - lastHeartbeatAt >= args.heartbeatMs) {
        console.log('[discover:qid] Job heartbeat', {
          status: statusText || null,
          stage: stage || null,
          percent: Number.isFinite(percent) ? percent : null,
          destinationsCompleted: Number.isFinite(destinationsCompleted) ? destinationsCompleted : null,
          destinationsTotal: Number.isFinite(destinationsTotal) ? destinationsTotal : null,
          currentDestinationIndex,
          currentDestinationId,
          currentDestinationLabel,
          currentStep,
          elapsedSec,
          message: job?.message || null,
        });
        lastHeartbeatAt = Date.now();
      }

      if (statusText === 'done') {
        const result = await fetchJsonWithRetry(resultUrl, { method: 'GET' }, {
          attempts: args.networkRetryAttempts,
          initialDelayMs: args.networkRetryDelayMs,
          maxDelayMs: 12000,
          retryHttpStatuses: [502, 503, 504],
          onRetry: ({ attempt, attempts, waitMs, status: httpStatus, code, message }) => {
            console.warn('[discover:qid] Poll retry (job result)', {
              attempt,
              attempts,
              waitMs,
              status: httpStatus,
              code,
              message,
            });
          },
        });
        resultData = Array.isArray(result?.data) ? result.data : [];
        resultMeta = result?.meta || {};
        jobSummary = result?.job || job;
        break;
      }

      if (statusText === 'failed') {
        throw new Error(job?.error?.message || 'Discover job failed');
      }

      await sleep(args.pollMs);
    }

    if (!Array.isArray(resultData)) {
      throw new Error('Job completed without valid data');
    }
  } catch (err) {
    if (Number(err?.status) !== 404) {
      throw err;
    }
    mode = 'fallback';
    console.warn('[discover:qid] Jobs endpoint unavailable (404). Falling back to direct discover-preview.');
    const fallback = await fetchJsonWithRetry(fallbackUrl, {
      method: 'POST',
      body: discoverPayload,
    }, {
      attempts: Math.max(1, Math.min(6, args.networkRetryAttempts)),
      initialDelayMs: args.networkRetryDelayMs,
      maxDelayMs: 6000,
      retryHttpStatuses: [502, 503, 504],
      onRetry: ({ attempt, attempts, waitMs, status, code, message }) => {
        console.warn('[discover:qid] Retry fallback discover request', {
          attempt,
          attempts,
          waitMs,
          status,
          code,
          message,
        });
      },
    });
    resultData = Array.isArray(fallback?.data) ? fallback.data : [];
    resultMeta = fallback?.meta || {};
  }

  const finishedAt = new Date().toISOString();
  const finalZone = await findExistingZoneByQid(qid);
  const activitiesAfter = Number(finalZone?.activitiesCount || 0);
  const activitiesDelta = activitiesAfter - existingActivitiesCount;
  const persistedAddedCount = Number(resultMeta?.persistedAddedCount || 0);
  const zonesToMarkSearched = Array.from(
    new Set(
      [locationId, existingZone?._id]
        .map((v) => String(v || '').trim())
        .filter(Boolean)
    )
  );
  const ensuredSearchedSummary = [];
  if (persistedAddedCount > 0) {
    for (const zoneId of zonesToMarkSearched) {
      try {
        const markResult = await updateZoneDiscoverPreviewSearched(zoneId, true);
        ensuredSearchedSummary.push(markResult);
      } catch (markErr) {
        ensuredSearchedSummary.push({
          zoneId,
          error: String(markErr?.message || markErr),
        });
      }
    }
  } else {
    ensuredSearchedSummary.push({
      skipped: true,
      reason: 'no_new_activities_added',
      zones: zonesToMarkSearched,
    });
  }
  const summary = {
    ok: true,
    startedAt,
    finishedAt,
    qid,
    apiBase,
    minActivities: args.minActivities,
    activityCounts: {
      before: existingActivitiesCount,
      after: activitiesAfter,
      delta: activitiesDelta,
    },
    mode,
    location: {
      _id: locationId,
      type: locationType,
      label: locationLabel,
      source: resolveSource,
    },
    autoResetSummary,
    forceResetSummary,
    ensuredSearchedSummary,
    result: {
      activitiesReturned: resultData.length,
      persistedAddedCount,
      meta: resultMeta,
    },
    job: jobSummary,
  };

  console.log('[discover:qid] Completed successfully');
  console.log(JSON.stringify(summary, null, 2));
}

run().catch((err) => {
  console.error('[discover:qid] Error:', err?.message || err);
  const errorCode = extractErrorCode(err);
  if (errorCode) {
    console.error('[discover:qid] Error code:', errorCode);
  }
  if (err?.cause) {
    console.error('[discover:qid] Error cause:', err.cause);
  }
  if (err?.payload) {
    console.error('[discover:qid] Error payload:', JSON.stringify(err.payload, null, 2));
  }
  process.exit(1);
});
