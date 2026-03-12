'use strict';

const Activity = require('../models/Activity');
const BusinessUnit = require('../models/BusinessUnit');
const { Service } = require('../models/Service');

const ALERT_CODE_PENDING = 'ORPHAN_ACTIVITY_PENDING_DELETE';
const ALERT_CODE_DELETED = 'ORPHAN_ACTIVITY_DELETED';

let schedulerTimer = null;
let lastTickKey = null;

function toObjectIdString(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'object' && value !== null) {
    if (value._id) return String(value._id).trim();
    if (value.id) return String(value.id).trim();
  }
  return String(value || '').trim();
}

function toPositiveInt(raw, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.floor(n));
}

function getGraceDays() {
  return toPositiveInt(process.env.ORPHAN_ACTIVITY_GRACE_DAYS, 14);
}

function getTickMinutes() {
  // Force daily cadence for both scheduler tick and cleanup execution.
  // If env is provided with a lower value, clamp it to 1440 minutes (24h).
  return Math.max(1440, toPositiveInt(process.env.ORPHAN_ACTIVITY_CLEANUP_TICK_MINUTES, 1440));
}

function addDays(baseDate, days) {
  const out = new Date(baseDate);
  out.setDate(out.getDate() + days);
  return out;
}

function formatDateForMessage(rawDate) {
  try {
    const date = new Date(rawDate);
    if (Number.isNaN(date.getTime())) return '';
    return date.toISOString().slice(0, 10);
  } catch (_err) {
    return '';
  }
}

async function hasUnreadAlert(businessUnitId, code, activityId, replacementActivityId) {
  const bu = await BusinessUnit.findById(businessUnitId).select('systemAlerts').lean();
  const alerts = Array.isArray(bu?.systemAlerts) ? bu.systemAlerts : [];
  const activityKey = toObjectIdString(activityId);
  const replacementKey = toObjectIdString(replacementActivityId);
  return alerts.some((alert) => {
    if (String(alert?.code || '').trim() !== code) return false;
    if (alert?.readAt) return false;
    const alertActivity = toObjectIdString(alert?.activityId);
    const alertReplacement = toObjectIdString(alert?.replacementActivityId);
    return alertActivity === activityKey && alertReplacement === replacementKey;
  });
}

async function appendBusinessUnitAlert({
  businessUnitId,
  code,
  title,
  message,
  serviceId = null,
  serviceName = null,
  activityId = null,
  sourceActivityName = null,
  replacementActivityId = null,
  replacementActivityName = null,
  deleteAfterAt = null,
}) {
  const normalizedBuId = toObjectIdString(businessUnitId);
  if (!normalizedBuId) return;
  const normalizedCode = String(code || '').trim();
  const normalizedTitle = String(title || '').trim();
  const normalizedMessage = String(message || '').trim();
  if (!normalizedCode || !normalizedTitle || !normalizedMessage) return;

  const duplicated = await hasUnreadAlert(
    normalizedBuId,
    normalizedCode,
    activityId,
    replacementActivityId
  );
  if (duplicated) return;

  await BusinessUnit.findByIdAndUpdate(
    normalizedBuId,
    {
      $push: {
        systemAlerts: {
          $each: [{
            code: normalizedCode,
            title: normalizedTitle,
            message: normalizedMessage,
            serviceId: serviceId || null,
            serviceName: String(serviceName || '').trim() || null,
            activityId: activityId || null,
            sourceActivityName: String(sourceActivityName || '').trim() || null,
            replacementActivityId: replacementActivityId || null,
            replacementActivityName: String(replacementActivityName || '').trim() || null,
            deleteAfterAt: deleteAfterAt || null,
            createdAt: new Date(),
          }],
          $position: 0,
          $slice: 40,
        },
      },
    },
    { new: false }
  );
}

async function countLinkedActiveServices(activityId) {
  const normalizedActivityId = toObjectIdString(activityId);
  if (!normalizedActivityId) return 0;
  return Service.countDocuments({
    activityId: normalizedActivityId,
    isActive: { $ne: false },
  });
}

async function clearPendingCleanupIfNeeded(activityId) {
  const normalizedActivityId = toObjectIdString(activityId);
  if (!normalizedActivityId) return;
  const linkedCount = await countLinkedActiveServices(normalizedActivityId);
  if (linkedCount <= 0) return;
  await Activity.findByIdAndUpdate(normalizedActivityId, {
    $set: {
      'orphanCleanup.pendingDeletion': false,
      'orphanCleanup.deleteAfterAt': null,
      'orphanCleanup.sourceServiceId': null,
      'orphanCleanup.replacementActivityId': null,
      'orphanCleanup.replacementActivityName': null,
      'orphanCleanup.reason': null,
    },
  });
}

async function markOrphanActivityAfterRelink({
  previousActivityId,
  nextActivityId,
  serviceId,
}) {
  const oldActivityId = toObjectIdString(previousActivityId);
  const newActivityId = toObjectIdString(nextActivityId);
  const normalizedServiceId = toObjectIdString(serviceId);
  if (!oldActivityId || oldActivityId === newActivityId) {
    if (newActivityId) await clearPendingCleanupIfNeeded(newActivityId);
    return;
  }

  const [oldActivity, nextActivity, sourceService] = await Promise.all([
    Activity.findById(oldActivityId)
      .select('_id name ownership.mode ownership.businessUnitId ownership.createdFromServiceId orphanCleanup')
      .lean(),
    newActivityId
      ? Activity.findById(newActivityId).select('_id name').lean()
      : Promise.resolve(null),
    normalizedServiceId
      ? Service.findById(normalizedServiceId).select('_id title serviceName internalName').lean()
      : Promise.resolve(null),
  ]);

  if (!oldActivity?._id) {
    if (newActivityId) await clearPendingCleanupIfNeeded(newActivityId);
    return;
  }

  const ownershipMode = String(oldActivity?.ownership?.mode || '').trim().toLowerCase();
  const ownerBusinessUnitId = toObjectIdString(oldActivity?.ownership?.businessUnitId);
  const createdFromServiceId = toObjectIdString(oldActivity?.ownership?.createdFromServiceId);
  const linkedCount = await countLinkedActiveServices(oldActivityId);

  if (linkedCount > 0) {
    await clearPendingCleanupIfNeeded(oldActivityId);
    if (newActivityId) await clearPendingCleanupIfNeeded(newActivityId);
    return;
  }

  // Only schedule cleanup for non-global activities that were generated from this same service.
  if (ownershipMode === 'global' || !ownerBusinessUnitId) {
    if (newActivityId) await clearPendingCleanupIfNeeded(newActivityId);
    return;
  }
  if (createdFromServiceId && normalizedServiceId && createdFromServiceId !== normalizedServiceId) {
    if (newActivityId) await clearPendingCleanupIfNeeded(newActivityId);
    return;
  }

  const now = new Date();
  const deleteAfterAt = addDays(now, getGraceDays());
  const replacementName = String(nextActivity?.name || '').trim() || null;
  const replacementId = toObjectIdString(nextActivity?._id) || null;

  await Activity.findByIdAndUpdate(oldActivityId, {
    $set: {
      'orphanCleanup.pendingDeletion': true,
      'orphanCleanup.deleteAfterAt': deleteAfterAt,
      'orphanCleanup.sourceServiceId': normalizedServiceId || null,
      'orphanCleanup.replacementActivityId': replacementId,
      'orphanCleanup.replacementActivityName': replacementName,
      'orphanCleanup.lastNotifiedAt': now,
      'orphanCleanup.reason': 'service_relinked',
    },
  });

  const oldName = String(oldActivity?.name || '').trim() || 'Untitled activity';
  const sourceServiceName =
    String(sourceService?.title || '').trim() ||
    String(sourceService?.serviceName || '').trim() ||
    String(sourceService?.internalName || '').trim() ||
    'Service';
  const deleteDateLabel = formatDateForMessage(deleteAfterAt);
  const msg = `Your service "${sourceServiceName}" has been connected to a new place. The place where it was previously located ("${oldName}") no longer has associated services and is scheduled for deactivation on ${deleteDateLabel}.`;

  await appendBusinessUnitAlert({
    businessUnitId: ownerBusinessUnitId,
    code: ALERT_CODE_PENDING,
    title: 'Service connection update',
    message: msg,
    serviceId: normalizedServiceId || null,
    serviceName: sourceServiceName,
    activityId: oldActivity._id,
    sourceActivityName: oldName,
    replacementActivityId: replacementId,
    replacementActivityName: replacementName,
    deleteAfterAt,
  });

  if (newActivityId) {
    await clearPendingCleanupIfNeeded(newActivityId);
  }
}

async function runOrphanActivityCleanupOnce() {
  const now = new Date();
  const due = await Activity.find({
    'orphanCleanup.pendingDeletion': true,
    'orphanCleanup.deleteAfterAt': { $ne: null, $lte: now },
  })
    .select('_id name ownership.mode ownership.businessUnitId orphanCleanup')
    .lean();

  if (!due.length) return { scanned: 0, deleted: 0, skipped: 0 };

  let deleted = 0;
  let skipped = 0;

  for (const activity of due) {
    const activityId = toObjectIdString(activity?._id);
    if (!activityId) {
      skipped += 1;
      continue;
    }

    const ownershipMode = String(activity?.ownership?.mode || '').trim().toLowerCase();
    if (ownershipMode === 'global') {
      await Activity.findByIdAndUpdate(activityId, {
        $set: {
          'orphanCleanup.pendingDeletion': false,
          'orphanCleanup.deleteAfterAt': null,
          'orphanCleanup.reason': null,
        },
      });
      skipped += 1;
      continue;
    }

    const linkedCount = await countLinkedActiveServices(activityId);
    if (linkedCount > 0) {
      await clearPendingCleanupIfNeeded(activityId);
      skipped += 1;
      continue;
    }

    const deletedDoc = await Activity.findByIdAndDelete(activityId);
    if (!deletedDoc?._id) {
      skipped += 1;
      continue;
    }
    deleted += 1;

    const ownerBusinessUnitId = toObjectIdString(activity?.ownership?.businessUnitId);
    const replacementName = String(activity?.orphanCleanup?.replacementActivityName || '').trim() || null;
    const replacementId = toObjectIdString(activity?.orphanCleanup?.replacementActivityId) || null;
    const oldName = String(activity?.name || '').trim() || 'Untitled activity';
    const destination = replacementName ? ` Linked replacement: ${replacementName}.` : '';
    const msg = `Activity "${oldName}" was removed because it remained without linked services.${destination}`;

    await appendBusinessUnitAlert({
      businessUnitId: ownerBusinessUnitId,
      code: ALERT_CODE_DELETED,
      title: 'Activity removed',
      message: msg,
      activityId: activity._id,
      sourceActivityName: oldName,
      replacementActivityId: replacementId,
      replacementActivityName: replacementName,
      deleteAfterAt: null,
    });
  }

  return { scanned: due.length, deleted, skipped };
}

function shouldRunNow(now = new Date()) {
  const key = `${now.getUTCFullYear()}-${now.getUTCMonth() + 1}-${now.getUTCDate()}`;
  if (lastTickKey === key) return false;
  lastTickKey = key;
  return true;
}

function startOrphanActivityCleanupScheduler() {
  const enabled = String(process.env.ORPHAN_ACTIVITY_CLEANUP_ENABLED || 'true').trim().toLowerCase() !== 'false';
  if (!enabled) {
    console.log('[ACTIVITY][ORPHAN_CLEANUP] scheduler disabled (ORPHAN_ACTIVITY_CLEANUP_ENABLED=false)');
    return;
  }

  if (schedulerTimer) return;

  const tick = async () => {
    if (!shouldRunNow()) return;
    try {
      const result = await runOrphanActivityCleanupOnce();
      if (result.deleted > 0 || result.scanned > 0) {
        console.log(`[ACTIVITY][ORPHAN_CLEANUP] scanned=${result.scanned} deleted=${result.deleted} skipped=${result.skipped}`);
      }
    } catch (err) {
      console.error('[ACTIVITY][ORPHAN_CLEANUP] tick error', err?.message || err);
    }
  };

  const tickEveryMs = getTickMinutes() * 60 * 1000;
  schedulerTimer = setInterval(tick, tickEveryMs);
  if (typeof schedulerTimer.unref === 'function') schedulerTimer.unref();
  void tick();
  console.log(`[ACTIVITY][ORPHAN_CLEANUP] scheduler started tickEvery=${getTickMinutes()}m graceDays=${getGraceDays()}`);
}

module.exports = {
  markOrphanActivityAfterRelink,
  runOrphanActivityCleanupOnce,
  startOrphanActivityCleanupScheduler,
};
