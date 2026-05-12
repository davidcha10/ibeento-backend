const UserSubscription = require('../models/UserSubscription');
const User = require('../models/User');
const EmailTemplate = require('../models/EmailTemplate');
const { sendEmail } = require('./email.service');

let schedulerTimer = null;
let isRunning = false;
let lastSweepKey = '';

function parseBool(value, fallback = false) {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

function isSchedulerEnabled() {
  return parseBool(process.env.TRIAL_REMINDER_ENABLED, true);
}

function getTickMinutes() {
  const raw = Number.parseInt(String(process.env.TRIAL_REMINDER_TICK_MINUTES || '60'), 10);
  if (!Number.isFinite(raw) || raw <= 0) return 60;
  return Math.max(10, raw);
}

function getNow() {
  return new Date();
}

function toIsoDateUTC(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

function getTomorrowWindowUTC(baseNow = getNow()) {
  const tomorrow = new Date(Date.UTC(
    baseNow.getUTCFullYear(),
    baseNow.getUTCMonth(),
    baseNow.getUTCDate() + 1,
    0, 0, 0, 0
  ));
  const end = new Date(Date.UTC(
    tomorrow.getUTCFullYear(),
    tomorrow.getUTCMonth(),
    tomorrow.getUTCDate(),
    23, 59, 59, 999
  ));
  return { start: tomorrow, end };
}

function getFirstName(name = '') {
  const normalized = String(name || '').trim();
  if (!normalized) return 'traveler';
  return normalized.split(/\s+/)[0] || 'traveler';
}

function injectTemplateVars(template = '', vars = {}) {
  return String(template || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key) => {
    const value = vars[key];
    return value == null ? '' : String(value);
  });
}

async function loadActiveTemplate() {
  const doc = await EmailTemplate.findOne({
    key: 'subscription_ends_tomorrow',
    isActive: true,
  }).lean();

  const html = String(doc?.code?.template || '').trim();
  if (html) {
    return {
      subject: 'Your IBeento trial ends tomorrow',
      html,
      text: 'Your IBeento trial ends tomorrow. Manage your subscription in the app.',
    };
  }

  return {
    subject: 'Your IBeento trial ends tomorrow',
    html: `
      <p>Hi {{firstName}}, your IBeento trial ends tomorrow.</p>
      <p>Open the app to manage your subscription.</p>
    `.trim(),
    text: 'Your IBeento trial ends tomorrow. Open the app to manage your subscription.',
  };
}

async function sendTrialReminderForSubscription(sub, template) {
  const user = await User.findById(sub.userId).select('email name status').lean();
  if (!user?.email) return { sent: false, reason: 'missing_email' };
  if (String(user.status || 'active') !== 'active') return { sent: false, reason: 'user_inactive' };

  const firstName = getFirstName(user.name);
  const html = injectTemplateVars(template.html, { firstName });
  const text = injectTemplateVars(template.text, { firstName });

  await sendEmail({
    to: user.email,
    subject: template.subject,
    html,
    text,
  });

  return { sent: true };
}

async function runTrialReminderSweep() {
  if (isRunning) return { skipped: true, reason: 'already_running' };
  isRunning = true;

  try {
    const now = getNow();
    const { start, end } = getTomorrowWindowUTC(now);
    const tomorrowKey = toIsoDateUTC(start);

    const candidates = await UserSubscription.find({
      status: 'trialing',
      trialEndsAt: { $gte: start, $lte: end },
    })
      .select('_id userId status trialEndsAt metadata')
      .lean();

    if (!candidates.length) {
      return { ok: true, scanned: 0, sent: 0, skipped: 0, tomorrowKey };
    }

    const template = await loadActiveTemplate();
    let sent = 0;
    let skipped = 0;

    for (const sub of candidates) {
      const metadataObj = sub?.metadata && typeof sub.metadata === 'object' ? sub.metadata : {};
      const sentFor = String(metadataObj.trialReminderSentForDate || '').trim();
      if (sentFor === tomorrowKey) {
        skipped += 1;
        continue;
      }

      try {
        const result = await sendTrialReminderForSubscription(sub, template);
        if (!result.sent) {
          skipped += 1;
          continue;
        }

        await UserSubscription.updateOne(
          { _id: sub._id },
          {
            $set: {
              'metadata.trialReminderSentForDate': tomorrowKey,
              'metadata.trialReminderSentAt': new Date().toISOString(),
            },
          }
        );
        sent += 1;
      } catch (error) {
        skipped += 1;
        console.error(`[TRIAL_REMINDER] failed for subscription=${sub?._id}:`, error?.message || error);
      }
    }

    return { ok: true, scanned: candidates.length, sent, skipped, tomorrowKey };
  } finally {
    isRunning = false;
  }
}

function startTrialReminderScheduler() {
  if (!isSchedulerEnabled()) {
    console.log('[TRIAL_REMINDER] scheduler disabled (TRIAL_REMINDER_ENABLED=false)');
    return;
  }
  if (schedulerTimer) return;

  const tickEveryMs = getTickMinutes() * 60 * 1000;

  const tick = async () => {
    const dayKey = toIsoDateUTC(getNow());
    if (lastSweepKey === dayKey) return;
    const result = await runTrialReminderSweep();
    lastSweepKey = dayKey;
    if (!result?.skipped) {
      console.log('[TRIAL_REMINDER] daily sweep:', result);
    }
  };

  // Initial async tick.
  void tick().catch((error) => {
    console.error('[TRIAL_REMINDER] initial tick failed:', error?.message || error);
  });

  schedulerTimer = setInterval(() => {
    void tick().catch((error) => {
      console.error('[TRIAL_REMINDER] tick failed:', error?.message || error);
    });
  }, tickEveryMs);

  if (typeof schedulerTimer.unref === 'function') schedulerTimer.unref();
  console.log(`[TRIAL_REMINDER] scheduler started tickEvery=${getTickMinutes()}m (UTC daily send guard)`);
}

module.exports = {
  startTrialReminderScheduler,
  runTrialReminderSweep,
};

