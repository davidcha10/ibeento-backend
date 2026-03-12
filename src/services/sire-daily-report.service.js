const BusinessUnit = require('../models/BusinessUnit');
const ProviderGuestLink = require('../models/ProviderGuestLink');
const { Service } = require('../models/Service');
const { sendEmail } = require('./email.service');
const { SIRE_COLOMBIA_COUNTRY_CODE, resolveSireCountryCode } = require('../utils/sire-country-catalog');

const SIRE_CODES = ['SIRE'];
const DEFAULT_TIMEZONE = process.env.SIRE_REPORT_TIMEZONE || 'America/Bogota';
const DEFAULT_TICK_INTERVAL_MINUTES = Number(process.env.SIRE_REPORT_TICK_MINUTES || 10);

let started = false;
let timer = null;
let interval = null;
let lastRunKey = '';

function parseBool(value, fallback = false) {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

function parsePositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n <= 0) return fallback;
  return Math.floor(n);
}

function safeText(value) {
  return String(value == null ? '' : value).replace(/[\t\r\n]+/g, ' ').trim();
}

function formatDateOnly(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const day = String(d.getUTCDate()).padStart(2, '0');
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const year = String(d.getUTCFullYear());
  return `${day}/${month}/${year}`;
}

function formatDateTime(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString();
}

function getTzParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });

  const byType = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') byType[part.type] = part.value;
  }

  return {
    year: Number(byType.year),
    month: Number(byType.month),
    day: Number(byType.day),
    hour: Number(byType.hour),
    minute: Number(byType.minute),
    second: Number(byType.second),
  };
}

function toUtcFromTzLocal({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone) {
  let guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const target = Date.UTC(year, month - 1, day, hour, minute, second);

  for (let i = 0; i < 4; i += 1) {
    const parts = getTzParts(new Date(guess), timeZone);
    const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const diff = asUtc - target;
    if (diff === 0) break;
    guess -= diff;
  }

  return new Date(guess);
}

function shiftDate({ year, month, day }, deltaDays) {
  const d = new Date(Date.UTC(year, month - 1, day + deltaDays));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function getDailyWindowUtc(now = new Date(), timeZone = DEFAULT_TIMEZONE) {
  const local = getTzParts(now, timeZone);
  const todayLocal = { year: local.year, month: local.month, day: local.day };
  const yesterdayLocal = shiftDate(todayLocal, -1);

  const from = toUtcFromTzLocal({ ...yesterdayLocal, hour: 0, minute: 0, second: 0 }, timeZone);
  const to = toUtcFromTzLocal({ ...todayLocal, hour: 0, minute: 0, second: 0 }, timeZone);
  const reportDate = `${yesterdayLocal.year}-${String(yesterdayLocal.month).padStart(2, '0')}-${String(yesterdayLocal.day).padStart(2, '0')}`;

  return { from, to, reportDate, triggerKey: `${todayLocal.year}-${todayLocal.month}-${todayLocal.day}` };
}

function parseReportDateParts(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;

  const probe = new Date(Date.UTC(year, month - 1, day));
  const valid =
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() + 1 === month &&
    probe.getUTCDate() === day;
  if (!valid) return null;

  return { year, month, day, reportDate: raw };
}

function getWindowUtcForReportDate(reportDate, timeZone = DEFAULT_TIMEZONE) {
  const parsed = parseReportDateParts(reportDate);
  if (!parsed) return null;

  const from = toUtcFromTzLocal(
    { year: parsed.year, month: parsed.month, day: parsed.day, hour: 0, minute: 0, second: 0 },
    timeZone
  );
  const nextDay = shiftDate({ year: parsed.year, month: parsed.month, day: parsed.day }, 1);
  const to = toUtcFromTzLocal(
    { year: nextDay.year, month: nextDay.month, day: nextDay.day, hour: 0, minute: 0, second: 0 },
    timeZone
  );

  return { from, to, reportDate: parsed.reportDate };
}

function isSireEnabled(codes = []) {
  const normalized = (Array.isArray(codes) ? codes : [])
    .map((code) => String(code || '').trim().toUpperCase())
    .filter(Boolean);
  return normalized.some((code) => SIRE_CODES.some((needle) => code.includes(needle)));
}

function getGuestValue(regulationNode = {}) {
  if (!regulationNode || typeof regulationNode !== 'object') return '';
  return (
    regulationNode.cityName ||
    regulationNode.value ||
    regulationNode.countryName ||
    ''
  );
}

function getCountryValue(regulationNode = {}) {
  if (!regulationNode || typeof regulationNode !== 'object') return '';
  return (
    regulationNode.countryName ||
    regulationNode.countryCode ||
    regulationNode.value ||
    ''
  );
}

function normalizeText(value) {
  return String(value == null ? '' : value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function isColombianNationality(value) {
  const sireCountryCode = resolveSireCountryCode(value);
  if (sireCountryCode === SIRE_COLOMBIA_COUNTRY_CODE) return true;

  const normalized = normalizeText(value);
  if (!normalized) return false;
  return (
    normalized === SIRE_COLOMBIA_COUNTRY_CODE ||
    normalized === 'co' ||
    normalized === 'colombia' ||
    normalized === 'colombiano' ||
    normalized === 'colombiana' ||
    normalized === 'colombian'
  );
}

function isForeignGuest(guest = {}) {
  const nationality = String(guest?.nationality || '').trim();
  if (!nationality) return false;
  return !isColombianNationality(nationality);
}

function movementTypeLabel(type) {
  return String(type || '').trim().toLowerCase() === 'salida' ? 'S' : 'E';
}

function toSireDocumentType(rawType) {
  const raw = String(rawType || '').trim();
  if (!raw) return '';
  if (/^\d+$/.test(raw)) return raw;

  const normalized = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .trim();

  const map = {
    passport: '3',
    pasaporte: '3',
    foreign_id: '5',
    cedula_extranjeria: '5',
    cedula_de_extranjeria: '5',
    diplomatic_card: '46',
    carne_diplomatico: '46',
    carnet_diplomatico: '46',
    foreign_document: '10',
    documento_extranjero: '10',
    documento_mercosur_can: '10',
    ppt: '52',
    permiso_por_proteccion_temporal: '52',
    permiso_proteccion_temporal: '52',
  };
  return map[normalized] || '';
}

function isWithinWindow(dateValue, from, to) {
  if (!dateValue) return false;
  const d = new Date(dateValue);
  if (Number.isNaN(d.getTime())) return false;
  return d >= from && d < to;
}

function buildRows({ links = [], from, to, sireCode = '', sireCityCode = '' }) {
  const rows = [];
  let incompleteRows = 0;
  for (const link of links) {
    const guests = Array.isArray(link?.checkIn?.guests) ? link.checkIn.guests : [];

    if (!guests.length) continue;

    const movementEvents = [];
    if (isWithinWindow(link?.checkInDate, from, to)) {
      movementEvents.push({ movementType: 'INGRESO', movementDate: link?.checkInDate });
    }
    if (isWithinWindow(link?.checkOutDate, from, to)) {
      movementEvents.push({ movementType: 'SALIDA', movementDate: link?.checkOutDate });
    }
    if (!movementEvents.length) continue;

    for (const guest of guests) {
      if (!isForeignGuest(guest)) continue;
      const regulation = guest?.regulation || {};
      const nationalityCode = resolveSireCountryCode(guest?.nationality);

      for (const event of movementEvents) {
        const row = [
          safeText(sireCode),
          safeText(sireCityCode),
          safeText(toSireDocumentType(guest?.IdType)),
          safeText(guest?.Id),
          safeText(nationalityCode),
          safeText(guest?.firstLastName),
          safeText(guest?.secondLastName),
          safeText(`${guest?.firstName || ''} ${guest?.secondName || ''}`),
          movementTypeLabel(event.movementType),
          formatDateOnly(event.movementDate),
          safeText(getGuestValue(regulation?.origin)),
          safeText(getGuestValue(regulation?.destination)),
          formatDateOnly(guest?.dateOfBirth),
        ];

        const isComplete = row.every((value) => safeText(value).length > 0);
        if (!isComplete) {
          incompleteRows += 1;
          continue;
        }
        rows.push(row);
      }
    }
  }
  return { rows, incompleteRows };
}

function buildTxtReport(rows = []) {
  return rows
    .map((row) => row.map((value) => safeText(value)).join('\t'))
    .join('\n');
}

function getRecipients(businessUnit) {
  const recipients = [];
  const contactEmail = String(businessUnit?.contact?.email || '').trim().toLowerCase();
  if (contactEmail) recipients.push(contactEmail);

  const ownerEmail = String(
    (businessUnit?.user && typeof businessUnit.user === 'object' ? businessUnit.user?.email : '') || ''
  ).trim().toLowerCase();
  if (ownerEmail) recipients.push(ownerEmail);

  return Array.from(new Set(recipients)).filter(Boolean);
}

function getBusinessUnitCredentialsMap(businessUnit = {}) {
  const raw = businessUnit?.compliance?.credentials || {};
  if (raw instanceof Map) return raw;
  if (raw && typeof raw === 'object') return new Map(Object.entries(raw));
  return new Map();
}

function readCredentialValue(entry) {
  if (!entry || typeof entry !== 'object') return '';
  return safeText(entry?.value || '');
}

function normalizeSireCityCode(value) {
  const raw = safeText(value);
  if (!raw) return '';
  if (/^\d+$/.test(raw)) return raw;
  const leadingDigits = raw.match(/^(\d+)/)?.[1] || '';
  return leadingDigits || '';
}

function getSireCodeFromBusinessUnit(businessUnit = {}) {
  const credentials = getBusinessUnitCredentialsMap(businessUnit);
  if (!credentials.size) return '';

  const directKeys = ['SIRE_secureCode', 'SIRE.secureCode'];
  for (const key of directKeys) {
    if (!credentials.has(key)) continue;
    const value = readCredentialValue(credentials.get(key));
    if (value) return value;
  }

  for (const [, entry] of credentials.entries()) {
    const provider = safeText(entry?.provider || '').toUpperCase();
    const label = safeText(entry?.label || '').toUpperCase();
    if (provider === 'SIRE' && label.includes('SECURE') && label.includes('CODE')) {
      const value = readCredentialValue(entry);
      if (value) return value;
    }
  }

  return '';
}

function getSireCityCodeFromBusinessUnit(businessUnit = {}) {
  const credentials = getBusinessUnitCredentialsMap(businessUnit);
  if (!credentials.size) return '';

  const directKeys = ['SIRE_cityCode', 'SIRE.cityCode'];
  for (const key of directKeys) {
    if (!credentials.has(key)) continue;
    const value = normalizeSireCityCode(readCredentialValue(credentials.get(key)));
    if (value) return value;
  }

  for (const [, entry] of credentials.entries()) {
    const provider = safeText(entry?.provider || '').toUpperCase();
    const label = safeText(entry?.label || '').toUpperCase();
    if (provider === 'SIRE' && label.includes('CITY') && label.includes('CODE')) {
      const value = normalizeSireCityCode(readCredentialValue(entry));
      if (value) return value;
    }
  }

  return '';
}

async function generateSireTxtForBusinessUnit({ businessUnitId, reportDate, timeZone = DEFAULT_TIMEZONE } = {}) {
  const unitId = safeText(businessUnitId);
  if (!unitId) {
    return { ok: false, code: 'missing_business_unit', message: 'Business unit id is required.' };
  }

  const window = getWindowUtcForReportDate(reportDate, timeZone);
  if (!window) {
    return { ok: false, code: 'invalid_date', message: 'Invalid report date. Use YYYY-MM-DD.' };
  }

  const businessUnit = await BusinessUnit.findById(unitId)
    .select('_id businessName name compliance.enabledPackCodes compliance.credentials')
    .lean();
  if (!businessUnit) {
    return { ok: false, code: 'business_unit_not_found', message: 'Business unit not found.' };
  }

  if (!isSireEnabled(businessUnit?.compliance?.enabledPackCodes || [])) {
    return { ok: false, code: 'sire_not_enabled', message: 'SIRE is not enabled for this business unit.' };
  }

  const sireCode = getSireCodeFromBusinessUnit(businessUnit);
  if (!sireCode) {
    return { ok: false, code: 'missing_sire_code', message: 'SIRE secure code is missing.' };
  }

  const sireCityCode = getSireCityCodeFromBusinessUnit(businessUnit);
  if (!sireCityCode) {
    return { ok: false, code: 'missing_sire_city_code', message: 'SIRE apartment city code is missing.' };
  }

  const services = await Service.find({ BusinessUnitId: businessUnit._id })
    .select('_id')
    .lean();
  const serviceIds = services.map((service) => service?._id).filter(Boolean);
  if (!serviceIds.length) {
    return { ok: false, code: 'no_services', message: 'No services found for this business unit.' };
  }

  const links = await ProviderGuestLink.find({
    serviceId: { $in: serviceIds },
    status: 'completed',
    $or: [
      { checkInDate: { $gte: window.from, $lt: window.to } },
      { checkOutDate: { $gte: window.from, $lt: window.to } },
    ],
  })
    .select('_id serviceId checkInDate checkOutDate checkIn')
    .lean();

  const { rows, incompleteRows } = buildRows({
    links,
    from: window.from,
    to: window.to,
    sireCode,
    sireCityCode,
  });

  if (incompleteRows > 0) {
    return {
      ok: false,
      code: 'incomplete_rows',
      message: 'Some rows are incomplete. Complete required guest data before generating the file.',
      meta: {
        reportDate: window.reportDate,
        from: window.from,
        to: window.to,
        incompleteRows,
        rows: rows.length,
      },
    };
  }

  if (!rows.length) {
    return {
      ok: false,
      code: 'no_rows',
      message: 'No completed foreign guest movements found for the selected date.',
      meta: {
        reportDate: window.reportDate,
        from: window.from,
        to: window.to,
        incompleteRows,
        rows: rows.length,
      },
    };
  }

  const businessName = safeText(
    businessUnit?.businessName || businessUnit?.name || `business-unit-${String(businessUnit?._id || '').slice(-6)}`
  );
  const filenameSafeBusinessName = businessName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const filename = `sire-${filenameSafeBusinessName || 'report'}-${window.reportDate}.txt`;
  const content = buildTxtReport(rows);

  return {
    ok: true,
    code: 'ok',
    filename,
    content,
    meta: {
      reportDate: window.reportDate,
      from: window.from,
      to: window.to,
      rows: rows.length,
      incompleteRows,
      businessName,
    },
  };
}

async function runSireDailyReport() {
  const { from, to, reportDate } = getDailyWindowUtc(new Date(), DEFAULT_TIMEZONE);

  const businessUnits = await BusinessUnit.find({
    status: { $in: ['active', 'draft'] },
    'compliance.enabledPackCodes.0': { $exists: true },
  })
    .populate('user', 'email name')
    .select('_id businessName name contact.email user compliance.enabledPackCodes compliance.credentials')
    .lean();

  let reportsSent = 0;
  let skippedNoData = 0;
  let skippedNoRecipient = 0;
  let skippedNoSireCode = 0;
  let skippedNoSireCityCode = 0;
  let skippedIncompleteRows = 0;

  for (const bu of businessUnits) {
    if (!isSireEnabled(bu?.compliance?.enabledPackCodes || [])) continue;
    const sireCode = getSireCodeFromBusinessUnit(bu);
    if (!sireCode) {
      skippedNoSireCode += 1;
      continue;
    }
    const sireCityCode = getSireCityCodeFromBusinessUnit(bu);
    if (!sireCityCode) {
      skippedNoSireCityCode += 1;
      continue;
    }

    const services = await Service.find({ BusinessUnitId: bu._id })
      .select('_id title serviceName internalName')
      .lean();
    const serviceIds = services.map((service) => service?._id).filter(Boolean);
    if (!serviceIds.length) {
      skippedNoData += 1;
      continue;
    }

    const links = await ProviderGuestLink.find({
      serviceId: { $in: serviceIds },
      status: 'completed',
      $or: [
        { checkInDate: { $gte: from, $lt: to } },
        { checkOutDate: { $gte: from, $lt: to } },
      ],
    })
      .select('_id serviceId checkInDate checkOutDate checkIn')
      .lean();

    const { rows, incompleteRows } = buildRows({ links, from, to, sireCode, sireCityCode });
    if (incompleteRows > 0) {
      skippedIncompleteRows += 1;
      continue;
    }
    if (!rows.length) {
      skippedNoData += 1;
      continue;
    }

    const recipients = getRecipients(bu);
    if (!recipients.length) {
      skippedNoRecipient += 1;
      continue;
    }

    const businessName = safeText(bu?.businessName || bu?.name || `business-unit-${String(bu?._id || '').slice(-6)}`);
    const filenameSafeBusinessName = businessName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const content = buildTxtReport(rows);

    await sendEmail({
      to: recipients.join(','),
      subject: `SIRE Daily Report ${reportDate} - ${businessName}`,
      text: `Attached is the SIRE daily report for ${reportDate}.`,
      html: `<p>Attached is the SIRE daily report for <strong>${reportDate}</strong>.</p>`,
      attachments: [
        {
          filename: `sire-${filenameSafeBusinessName || 'report'}-${reportDate}.txt`,
          content,
          contentType: 'text/plain; charset=utf-8',
        },
      ],
    });

    reportsSent += 1;
  }

  return {
    reportsSent,
    skippedNoData,
    skippedNoRecipient,
    skippedNoSireCode,
    skippedNoSireCityCode,
    skippedIncompleteRows,
    from,
    to,
    reportDate,
  };
}

async function runSafe() {
  try {
    const result = await runSireDailyReport();
    console.log(
      `[SIRE][DAILY] done date=${result.reportDate} sent=${result.reportsSent} noData=${result.skippedNoData} noRecipient=${result.skippedNoRecipient} noSireCode=${result.skippedNoSireCode} noSireCityCode=${result.skippedNoSireCityCode} incompleteRows=${result.skippedIncompleteRows}`
    );
  } catch (err) {
    console.error('[SIRE][DAILY] error', err?.message || err);
  }
}

function startSireDailyReportScheduler() {
  if (started) return;
  started = true;

  const enabled = parseBool(process.env.SIRE_DAILY_REPORT_ENABLED, true);
  if (!enabled) {
    console.log('[SIRE][DAILY] scheduler disabled (SIRE_DAILY_REPORT_ENABLED=false)');
    return;
  }

  const tickIntervalMinutes = parsePositiveInt(DEFAULT_TICK_INTERVAL_MINUTES, 10);
  const tickIntervalMs = tickIntervalMinutes * 60 * 1000;

  const tick = () => {
    const now = new Date();
    const parts = getTzParts(now, DEFAULT_TIMEZONE);
    // Run once per local day, on the first tick that happens during 00:xx.
    if (parts.hour !== 0) return;
    const { triggerKey } = getDailyWindowUtc(now, DEFAULT_TIMEZONE);
    if (triggerKey === lastRunKey) return;
    lastRunKey = triggerKey;
    void runSafe();
  };

  timer = setTimeout(() => {
    tick();
    interval = setInterval(tick, tickIntervalMs);
  }, 5 * 1000);

  const runOnStartup = parseBool(process.env.SIRE_REPORT_RUN_ON_STARTUP, false);
  if (runOnStartup) {
    void runSafe();
  }

  console.log(`[SIRE][DAILY] scheduler started tz=${DEFAULT_TIMEZONE} tickEvery=${tickIntervalMinutes}m`);
}

function stopSireDailyReportScheduler() {
  if (timer) clearTimeout(timer);
  if (interval) clearInterval(interval);
  timer = null;
  interval = null;
  started = false;
}

module.exports = {
  startSireDailyReportScheduler,
  stopSireDailyReportScheduler,
  runSireDailyReport,
  buildTxtReport,
  generateSireTxtForBusinessUnit,
};
