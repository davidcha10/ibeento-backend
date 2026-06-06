'use strict';

const axios = require('axios');
const ExchangeRateSnapshot = require('../models/ExchangeRateSnapshot');

const SNAPSHOT_KEY = 'latest';
const DEFAULT_BASE_CURRENCY = 'USD';
const DEFAULT_PROVIDER = 'frankfurter';
const DEFAULT_SYNC_URL = 'https://api.frankfurter.dev/v2/rates';

let schedulerTimer = null;
let isSyncRunning = false;
let lastScheduledRunDayKey = '';

function parseBool(value, fallback = false) {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function getSchedulerEnabled() {
  return parseBool(process.env.EXCHANGE_RATE_SYNC_ENABLED, true);
}

function getTickMinutes() {
  return Math.max(30, parsePositiveInt(process.env.EXCHANGE_RATE_SYNC_TICK_MINUTES, 60));
}

function getSyncHourUtc() {
  const value = parsePositiveInt(process.env.EXCHANGE_RATE_SYNC_HOUR_UTC, 3);
  return Math.min(23, Math.max(0, value));
}

function getSyncMinuteUtc() {
  const value = parsePositiveInt(process.env.EXCHANGE_RATE_SYNC_MINUTE_UTC, 15);
  return Math.min(59, Math.max(0, value));
}

function getBaseCurrency() {
  return String(process.env.EXCHANGE_RATE_BASE_CURRENCY || DEFAULT_BASE_CURRENCY).trim().toUpperCase() || DEFAULT_BASE_CURRENCY;
}

function getSyncUrl() {
  return String(process.env.EXCHANGE_RATE_SYNC_URL || DEFAULT_SYNC_URL).trim() || DEFAULT_SYNC_URL;
}

function getNow() {
  return new Date();
}

function toUtcDayKey(date = getNow()) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

function hasReachedDailyWindow(now = getNow()) {
  const hour = now.getUTCHours();
  const minute = now.getUTCMinutes();
  const targetHour = getSyncHourUtc();
  const targetMinute = getSyncMinuteUtc();
  return hour > targetHour || (hour === targetHour && minute >= targetMinute);
}

function isSnapshotStale(snapshot) {
  const fetchedAt = snapshot?.fetchedAt ? new Date(snapshot.fetchedAt) : null;
  if (!fetchedAt || Number.isNaN(fetchedAt.getTime())) return true;
  const ageMs = getNow().getTime() - fetchedAt.getTime();
  return ageMs > 36 * 60 * 60 * 1000;
}

function normalizeCurrencyCode(value) {
  return String(value || '').trim().toUpperCase();
}

async function fetchLatestRatesFromProvider() {
  const baseCurrency = getBaseCurrency();
  const response = await axios.get(getSyncUrl(), {
    params: { base: baseCurrency },
    timeout: 15000,
  });

  const rows = Array.isArray(response?.data) ? response.data : [];
  if (!rows.length) {
    throw new Error('Exchange rate provider returned no rows');
  }

  const rates = { [baseCurrency]: 1 };
  let effectiveDate = '';

  for (const row of rows) {
    const quote = normalizeCurrencyCode(row?.quote);
    const rate = Number(row?.rate);
    if (!quote || !Number.isFinite(rate) || rate <= 0) continue;
    rates[quote] = rate;
    if (!effectiveDate && typeof row?.date === 'string' && row.date.trim()) {
      effectiveDate = row.date.trim();
    }
  }

  if (!effectiveDate) {
    effectiveDate = toUtcDayKey(getNow());
  }

  const availableCurrencies = Object.keys(rates).sort((a, b) => a.localeCompare(b));

  return {
    provider: DEFAULT_PROVIDER,
    baseCurrency,
    effectiveDate,
    fetchedAt: getNow(),
    availableCurrencies,
    rates,
  };
}

async function getLatestExchangeRateSnapshot() {
  return ExchangeRateSnapshot.findOne({ key: SNAPSHOT_KEY }).lean();
}

async function syncLatestExchangeRates({ trigger = 'manual', scheduledRunDayKey = '' } = {}) {
  if (isSyncRunning) {
    return { skipped: true, reason: 'already_running' };
  }
  isSyncRunning = true;

  try {
    const payload = await fetchLatestRatesFromProvider();
    const set = {
      provider: payload.provider,
      baseCurrency: payload.baseCurrency,
      effectiveDate: payload.effectiveDate,
      fetchedAt: payload.fetchedAt,
      availableCurrencies: payload.availableCurrencies,
      rates: payload.rates,
    };
    if (scheduledRunDayKey) {
      set['scheduler.lastScheduledRunDayKey'] = scheduledRunDayKey;
    }
    const doc = await ExchangeRateSnapshot.findOneAndUpdate(
      { key: SNAPSHOT_KEY },
      {
        $set: set,
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      }
    ).lean();

    return {
      ok: true,
      trigger,
      effectiveDate: doc?.effectiveDate || payload.effectiveDate,
      baseCurrency: doc?.baseCurrency || payload.baseCurrency,
      quoteCount: Array.isArray(doc?.availableCurrencies)
        ? Math.max(0, doc.availableCurrencies.length - 1)
        : Math.max(0, payload.availableCurrencies.length - 1),
      fetchedAt: doc?.fetchedAt || payload.fetchedAt,
    };
  } finally {
    isSyncRunning = false;
  }
}

async function maybeWarmSnapshot() {
  const snapshot = await getLatestExchangeRateSnapshot();
  if (!snapshot || isSnapshotStale(snapshot)) {
    return syncLatestExchangeRates({ trigger: 'bootstrap' });
  }
  return { ok: true, skipped: true, reason: 'fresh_snapshot' };
}

function startExchangeRateSyncScheduler() {
  if (!getSchedulerEnabled()) {
    console.log('[EXCHANGE_RATES] scheduler disabled (EXCHANGE_RATE_SYNC_ENABLED=false)');
    return;
  }
  if (schedulerTimer) return;

  const tickEveryMs = getTickMinutes() * 60 * 1000;

  const tick = async () => {
    const now = getNow();
    const runDayKey = toUtcDayKey(now);
    const reachedDailyWindow = hasReachedDailyWindow(now);

    const snapshot = await getLatestExchangeRateSnapshot();
    if (!snapshot || isSnapshotStale(snapshot)) {
      const warmResult = await syncLatestExchangeRates({
        trigger: reachedDailyWindow ? 'scheduled_recovery' : 'stale_recovery',
        scheduledRunDayKey: reachedDailyWindow ? runDayKey : '',
      });
      if (reachedDailyWindow && warmResult?.ok) {
        lastScheduledRunDayKey = runDayKey;
      }
      if (warmResult?.ok) {
        console.log('[EXCHANGE_RATES] stale recovery sync:', warmResult);
      }
      if (reachedDailyWindow) return;
    }

    if (!reachedDailyWindow) return;
    if (lastScheduledRunDayKey === runDayKey) return;

    const latest = await getLatestExchangeRateSnapshot();
    const persistedRunDayKey = String(latest?.scheduler?.lastScheduledRunDayKey || '').trim();
    if (persistedRunDayKey === runDayKey) {
      lastScheduledRunDayKey = runDayKey;
      return;
    }

    const result = await syncLatestExchangeRates({
      trigger: 'scheduled',
      scheduledRunDayKey: runDayKey,
    });
    lastScheduledRunDayKey = runDayKey;
    if (!result?.skipped) {
      console.log('[EXCHANGE_RATES] scheduled sync:', result);
    }
  };

  void tick().catch((error) => {
    console.error('[EXCHANGE_RATES] initial tick failed:', error?.message || error);
  });

  schedulerTimer = setInterval(() => {
    void tick().catch((error) => {
      console.error('[EXCHANGE_RATES] tick failed:', error?.message || error);
    });
  }, tickEveryMs);

  if (typeof schedulerTimer.unref === 'function') schedulerTimer.unref();
  console.log(
    `[EXCHANGE_RATES] scheduler started tickEvery=${getTickMinutes()}m window=${String(getSyncHourUtc()).padStart(2, '0')}:${String(getSyncMinuteUtc()).padStart(2, '0')} UTC base=${getBaseCurrency()}`
  );
}

module.exports = {
  getLatestExchangeRateSnapshot,
  maybeWarmSnapshot,
  startExchangeRateSyncScheduler,
  syncLatestExchangeRates,
};
