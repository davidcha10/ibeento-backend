require('dotenv').config();

const mongoose = require('mongoose');
const Activity = require('../src/models/Activity');
const {
  activityHasCanonicalData,
  buildGoogleCachePurgeUpdate,
  calculatePriorityFromGoogleCache,
  refreshGoogleCacheByPlaceId,
} = require('../src/services/activity/google-cache-maintenance.service');

function mongoUri() {
  return process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/travelplanner';
}

function parseLimit() {
  const limit = Number(process.env.LIMIT || process.env.GOOGLE_CACHE_REFRESH_LIMIT || 200);
  return Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 1000) : 200;
}

async function run() {
  await mongoose.connect(mongoUri());

  const now = new Date();
  const dryRun = String(process.env.DRY_RUN || '').trim() === '1';
  const limit = parseLimit();
  const rows = await Activity.find({
    'googleCache.placeId': { $exists: true, $ne: '' },
    'googleCache.expiresAt': { $lte: now },
  })
    .select('_id name nameSource location googleCache ranking')
    .limit(limit)
    .lean();

  let purged = 0;
  let refreshed = 0;
  let failed = 0;

  for (const activity of rows) {
    const id = activity._id;
    const placeId = String(activity?.googleCache?.placeId || '').trim();
    if (!placeId) continue;

    try {
      if (activityHasCanonicalData(activity)) {
        purged += 1;
        if (!dryRun) {
          await Activity.updateOne({ _id: id }, buildGoogleCachePurgeUpdate(now));
        }
        continue;
      }

      const googleCache = await refreshGoogleCacheByPlaceId(placeId, activity.googleCache || {});
      if (!googleCache?.placeId) {
        failed += 1;
        if (!dryRun) {
          await Activity.updateOne(
            { _id: id },
            {
              $set: {
                'googleCache.status': 'refresh_failed',
                'googleCache.lastError': 'Google Places refresh returned no place.',
              },
            }
          );
        }
        continue;
      }

      refreshed += 1;
      if (!dryRun) {
        await Activity.updateOne(
          { _id: id },
          {
            $set: {
              googleCache,
              'ranking.priority': calculatePriorityFromGoogleCache(googleCache),
              'ranking.prioritySource': 'google_cache_user_trend',
              'ranking.priorityFormulaVersion': 'google-cache-v1',
            },
          }
        );
      }
    } catch (err) {
      failed += 1;
      if (!dryRun) {
        await Activity.updateOne(
          { _id: id },
          {
            $set: {
              'googleCache.status': 'refresh_failed',
              'googleCache.lastError': String(err?.message || err || 'Google cache refresh failed').slice(0, 500),
            },
          }
        );
      }
    }
  }

  console.log(JSON.stringify({
    dryRun,
    scanned: rows.length,
    purged,
    refreshed,
    failed,
  }, null, 2));

  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch (_) {
    // ignore disconnect errors while exiting
  }
  process.exit(1);
});
