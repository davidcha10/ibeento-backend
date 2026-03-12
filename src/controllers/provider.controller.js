// controllers/provider.controller.js
const crypto = require('crypto');
const Provider = require('../models/Provider');
const User = require('../models/User'); // opcional si quieres validar existencia del usuario
const ProviderGuestLink = require('../models/ProviderGuestLink');
const ItineraryItem = require('../models/ItineraryItem');
const Itinerary = require('../models/Itinerary');
const { Service } = require('../models/Service');
const Zone = require('../models/Zone');
const BusinessUnit = require('../models/BusinessUnit');
const mongoose = require('mongoose');
const { sendEmail } = require('../services/email.service');
const { buildWebAppUrl } = require('../utils/web-app-url');

/** ===== Helpers ===== */
function toBool(v, fallback = false) {
  if (v === true || v === false) return v;
  if (v == null) return fallback;
  const normalized = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function parsePositiveInt(v, fallback, min = 1, max = 200) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function normalizeEmail(v) {
  const email = String(v || '').trim().toLowerCase();
  return email || null;
}

function randomToken() {
  return crypto.randomBytes(24).toString('hex');
}

function parseDateSafe(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isDateOnlyInput(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim());
}

function parseDateOnlyParts(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  const probe = new Date(Date.UTC(year, month - 1, day));
  const isSame =
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() + 1 === month &&
    probe.getUTCDate() === day;
  if (!isSame) return null;
  return { year, month, day };
}

function parseHourMinute(raw, fallbackHour = 0, fallbackMinute = 0) {
  const txt = String(raw || '').trim();
  const match = txt.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) return { hour: fallbackHour, minute: fallbackMinute };
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function resolveServiceBoundaryTime(serviceDoc = null, isCheckout = false) {
  const acc = serviceDoc?.accommodation || {};
  const direct = isCheckout ? acc?.checkOut : acc?.checkIn;
  const txt = String(direct || '').trim();
  if (/^([01]\d|2[0-3]):([0-5]\d)$/.test(txt)) return txt;
  return null;
}

function isIanaRegionTimeZone(value) {
  const s = String(value || '').trim();
  if (!s) return false;
  if (s.startsWith('Etc/')) return false;
  return /^[A-Za-z_]+(?:\/[A-Za-z0-9_\-+]+)+$/.test(s);
}

function extractIanaFromText(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (isIanaRegionTimeZone(text)) return text;
  const match = text.match(/([A-Za-z_]+\/[A-Za-z0-9_\-+]+)/);
  if (match && isIanaRegionTimeZone(match[1])) return match[1];
  return null;
}

function parseFixedOffsetMinutes(rawValue) {
  const raw = String(rawValue || '').trim().toUpperCase();
  if (!raw) return null;

  const compact = raw.replace(/\s+/g, '');
  const patterns = [
    /^UTC([+-])(\d{1,2})(?::?(\d{2}))?$/,
    /^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/,
    /^([+-])(\d{1,2})(?::?(\d{2}))$/,
  ];

  for (const pattern of patterns) {
    const match = compact.match(pattern);
    if (!match) continue;
    const sign = match[1] === '-' ? -1 : 1;
    const hours = Number(match[2] || 0);
    const minutes = Number(match[3] || 0);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) continue;
    if (hours > 14 || minutes > 59) continue;
    return sign * (hours * 60 + minutes);
  }

  return null;
}

function normalizeTimeZoneDescriptor(rawValue) {
  const iana = extractIanaFromText(rawValue);
  if (iana) return { kind: 'iana', value: iana };
  const offsetMinutes = parseFixedOffsetMinutes(rawValue);
  if (Number.isFinite(offsetMinutes)) return { kind: 'fixed_offset', value: offsetMinutes };
  return null;
}

async function resolveReservationTimeZoneDescriptor(serviceDoc = null, providerDoc = null) {
  const directCandidates = [
    serviceDoc?.startingPoint?.timeZone,
    serviceDoc?.location?.timeZone,
    providerDoc?.baseLocation?.timezone,
  ];

  for (const candidate of directCandidates) {
    const descriptor = normalizeTimeZoneDescriptor(candidate);
    if (descriptor) return descriptor;
  }

  const zoneIdCandidates = [
    serviceDoc?.location?.cityId,
    serviceDoc?.location?.regionId,
    serviceDoc?.location?.countryId,
  ]
    .map((id) => String(id || '').trim())
    .filter((id) => !!id && mongoose.Types.ObjectId.isValid(id));

  for (const zoneId of zoneIdCandidates) {
    const zoneDoc = await Zone.findById(zoneId).select('_id timeZone').lean();
    const descriptor = normalizeTimeZoneDescriptor(zoneDoc?.timeZone);
    if (descriptor) return descriptor;
  }

  return { kind: 'iana', value: 'UTC' };
}

function getTimeZoneOffsetMilliseconds(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = dtf.formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return asUTC - date.getTime();
}

function zonedLocalDateTimeToUtc({ year, month, day, hour, minute, timeZone }) {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let offset = getTimeZoneOffsetMilliseconds(new Date(utcGuess), timeZone);
  let utcMillis = utcGuess - offset;
  const offset2 = getTimeZoneOffsetMilliseconds(new Date(utcMillis), timeZone);
  if (offset2 !== offset) {
    utcMillis = utcGuess - offset2;
  }
  return new Date(utcMillis);
}

function fixedOffsetLocalDateTimeToUtc({ year, month, day, hour, minute, offsetMinutes }) {
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const utcMillis = localAsUtc - (Number(offsetMinutes || 0) * 60 * 1000);
  return new Date(utcMillis);
}

async function parseReservationBoundaryDate(rawDate, { serviceDoc = null, providerDoc = null, isCheckout = false } = {}) {
  const raw = String(rawDate || '').trim();
  if (!raw) return null;

  if (!isDateOnlyInput(raw)) {
    return parseDateSafe(raw);
  }

  const parts = parseDateOnlyParts(raw);
  if (!parts) return null;

  const boundaryTime = resolveServiceBoundaryTime(serviceDoc, isCheckout);
  const defaults = isCheckout ? { h: 11, m: 0 } : { h: 15, m: 0 };
  const { hour, minute } = parseHourMinute(boundaryTime, defaults.h, defaults.m);
  const tzDescriptor = await resolveReservationTimeZoneDescriptor(serviceDoc, providerDoc);

  try {
    if (tzDescriptor?.kind === 'fixed_offset') {
      return fixedOffsetLocalDateTimeToUtc({
        year: parts.year,
        month: parts.month,
        day: parts.day,
        hour,
        minute,
        offsetMinutes: tzDescriptor.value,
      });
    }

    return zonedLocalDateTimeToUtc({
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour,
      minute,
      timeZone: tzDescriptor?.value || 'UTC',
    });
  } catch (_) {
    // If timezone resolution fails, keep previous behavior (UTC midnight date-only parse).
    return parseDateSafe(raw);
  }
}

function hashSha256(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function roundTo(value, decimals = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** Math.max(0, Number(decimals || 0));
  return Math.round(n * factor) / factor;
}

function normalizeSignaturePoint(rawPoint = null) {
  if (!Array.isArray(rawPoint) || rawPoint.length < 2) return null;
  const x = roundTo(rawPoint[0], 5);
  const y = roundTo(rawPoint[1], 5);
  const tRaw = Number(rawPoint[2]);
  const t = Number.isFinite(tRaw) ? Math.max(0, Math.floor(tRaw)) : 0;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return [x, y, t];
}

function normalizeSignaturePayload(raw = null) {
  if (!raw || typeof raw !== 'object') return null;

  const format = String(raw?.format || '').trim().toLowerCase();
  if (format !== 'stroke-v1') return null;

  const signedAt = parseDateSafe(raw?.signedAt) || new Date();
  const signerRole = 'Main guest';
  const signerName = cleanText(raw?.signerName) || null;
  const canvasWidth = Number(raw?.canvas?.w);
  const canvasHeight = Number(raw?.canvas?.h);
  if (!Number.isFinite(canvasWidth) || !Number.isFinite(canvasHeight) || canvasWidth <= 0 || canvasHeight <= 0) {
    return null;
  }

  const strokesRaw = Array.isArray(raw?.strokes) ? raw.strokes : [];
  if (!strokesRaw.length) return null;

  const MAX_STROKES = 256;
  const MAX_TOTAL_POINTS = 12000;
  const MIN_TOTAL_POINTS = 8;
  const strokes = [];
  let totalPoints = 0;

  for (const strokeRaw of strokesRaw.slice(0, MAX_STROKES)) {
    if (!Array.isArray(strokeRaw) || strokeRaw.length < 2) continue;
    const stroke = [];
    for (const rawPoint of strokeRaw) {
      const point = normalizeSignaturePoint(rawPoint);
      if (!point) continue;
      stroke.push(point);
      totalPoints += 1;
      if (totalPoints >= MAX_TOTAL_POINTS) break;
    }
    if (stroke.length >= 2) {
      strokes.push(stroke);
    }
    if (totalPoints >= MAX_TOTAL_POINTS) break;
  }

  if (!strokes.length || totalPoints < MIN_TOTAL_POINTS) return null;

  return {
    format: 'stroke-v1',
    signedAt,
    signerRole,
    signerName,
    canvas: {
      w: Math.round(canvasWidth),
      h: Math.round(canvasHeight),
    },
    strokes,
  };
}

function getAgeInYears(dateValue, asOf = new Date()) {
  const birthDate = parseDateSafe(dateValue);
  const referenceDate = parseDateSafe(asOf) || new Date();
  if (!birthDate) return null;

  let age = referenceDate.getUTCFullYear() - birthDate.getUTCFullYear();
  const hasHadBirthdayThisYear =
    referenceDate.getUTCMonth() > birthDate.getUTCMonth() ||
    (
      referenceDate.getUTCMonth() === birthDate.getUTCMonth() &&
      referenceDate.getUTCDate() >= birthDate.getUTCDate()
    );
  if (!hasHadBirthdayThisYear) age -= 1;
  return age;
}

function isAtLeastAge(dateValue, minAge = 18, asOf = new Date()) {
  const age = getAgeInYears(dateValue, asOf);
  return Number.isFinite(age) && age >= Number(minAge || 18);
}

function toDateOnlyUtc(value) {
  const d = parseDateSafe(value);
  if (!d) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

function normalizeGeoPoint(raw) {
  const coords = Array.isArray(raw)
    ? raw
    : (Array.isArray(raw?.coordinates) ? raw.coordinates : null);
  if (!coords || coords.length < 2) return undefined;
  const lng = Number(coords[0]);
  const lat = Number(coords[1]);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return undefined;
  return { type: 'Point', coordinates: [lng, lat] };
}

function buildServiceSnapshot(serviceDoc) {
  if (!serviceDoc) return undefined;
  return {
    providerId: serviceDoc.providerId || undefined,
    serviceType: serviceDoc.serviceType || undefined,
    title: serviceDoc.title || serviceDoc.serviceName || undefined,
    pricing: serviceDoc.pricing || undefined,
    duration: serviceDoc.duration || undefined,
    location: {
      countryId: serviceDoc?.location?.countryId || undefined,
      regionId: serviceDoc?.location?.regionId || undefined,
      cityId: serviceDoc?.location?.cityId || undefined,
      timeZone: serviceDoc?.location?.timeZone || undefined,
      address: serviceDoc?.location?.address || undefined,
      geo: normalizeGeoPoint(serviceDoc?.location?.geo),
    },
    startingPoint: {
      address: serviceDoc?.startingPoint?.address || undefined,
      details: serviceDoc?.startingPoint?.details || undefined,
      timeZone: serviceDoc?.startingPoint?.timeZone || undefined,
      geo: normalizeGeoPoint(serviceDoc?.startingPoint?.geo),
    },
    capturedAt: new Date(),
  };
}

async function ensureUserItinerary(userId, guestLinkDoc = null) {
  const existing = await Itinerary.findOne({ userId }).sort({ updatedAt: -1, createdAt: -1 });
  if (existing) return existing;

  const checkInDate = toDateOnlyUtc(guestLinkDoc?.checkInDate) || undefined;
  const checkOutDate = toDateOnlyUtc(guestLinkDoc?.checkOutDate) || checkInDate || undefined;
  const totalGuests = Math.max(1, Number(guestLinkDoc?.guestsCount || 1));

  return Itinerary.create({
    userId,
    name: 'New itinerary',
    status: 'draft',
    tripStartDate: checkInDate,
    tripEndDate: checkOutDate,
    guests: {
      adults: totalGuests,
      children: 0,
      babies: 0,
      total: totalGuests,
    },
  });
}

function cleanText(value) {
  const v = String(value || '').trim();
  return v || null;
}

function cleanEmail(value) {
  const v = String(value || '').trim().toLowerCase();
  return v || null;
}

function buildSubmittedByActor(userId, userDoc = null) {
  const fallbackId = String(userId || '').trim();
  const rawId = String(userDoc?._id || fallbackId || '').trim();
  const email = cleanEmail(userDoc?.email);
  const name = cleanText(userDoc?.name);
  const actor = {
    userId: rawId && mongoose.Types.ObjectId.isValid(rawId) ? rawId : null,
    email: email || null,
    name: name || null,
  };
  if (!actor.userId && !actor.email && !actor.name) return null;
  return actor;
}

async function resolveCountryNameFromService(serviceDoc) {
  const fromLocation = serviceDoc?.location || {};
  const zoneId = String(
    fromLocation.primaryZoneId ||
    (Array.isArray(fromLocation.zonePathIds) ? fromLocation.zonePathIds[0] : '') ||
    fromLocation.countryId || fromLocation.regionId || fromLocation.cityId || ''
  ).trim();
  if (!zoneId || !mongoose.Types.ObjectId.isValid(zoneId)) return null;

  const baseZone = await Zone.findById(zoneId)
    .select('_id name parentZoneId parentCountryId ancestry')
    .lean();
  if (!baseZone) return null;

  const directCountryId = baseZone.parentCountryId
    ? String(baseZone.parentCountryId)
    : null;
  if (directCountryId) {
    if (!mongoose.Types.ObjectId.isValid(directCountryId)) return cleanText(baseZone.name) || null;
    const countryZone = await Zone.findById(directCountryId).select('_id name').lean();
    return cleanText(countryZone?.name) || null;
  }

  if (!baseZone.parentZoneId) {
    return cleanText(baseZone.name) || null;
  }

  const ancestry = Array.isArray(baseZone.ancestry)
    ? baseZone.ancestry.map((id) => String(id || '').trim()).filter(Boolean)
    : [];
  if (!ancestry.length) return cleanText(baseZone.name) || null;

  if (!mongoose.Types.ObjectId.isValid(ancestry[0])) return cleanText(baseZone.name) || null;
  const countryZone = await Zone.findById(ancestry[0]).select('_id name').lean();
  return cleanText(countryZone?.name) || cleanText(baseZone.name) || null;
}

function normalizeAppliesTo(value, fallback = 'all_guests') {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'main_guest' || normalized === 'all_guests' || normalized === 'not_needed') return normalized;
  return fallback;
}

function defaultAppliesToForPath(path = '') {
  const key = String(path || '').trim();
  if (key.startsWith('invoiceInformation.')) return 'main_guest';
  if (key.startsWith('checkIn.')) return 'main_guest';
  return 'all_guests';
}

function maxAppliesTo(a, b) {
  const priority = { not_needed: 0, main_guest: 1, all_guests: 2 };
  const left = normalizeAppliesTo(a, 'main_guest');
  const right = normalizeAppliesTo(b, 'main_guest');
  return priority[left] >= priority[right] ? left : right;
}

function getBusinessUnitFieldApplicability(businessUnit) {
  const fieldsRaw = businessUnit?.compliance?.fields;
  if (Array.isArray(fieldsRaw) && fieldsRaw.length) {
    const out = {};
    for (const item of fieldsRaw) {
      const key = String(item?.path || '').trim();
      if (!key) continue;
      const fromField = normalizeAppliesTo(item?.appliesTo, defaultAppliesToForPath(key));
      const current = out[key];
      out[key] = current ? maxAppliesTo(current, fromField) : fromField;
    }
    return out;
  }

  const raw = businessUnit?.compliance?.fieldApplicability || {};
  if (Array.isArray(raw)) {
    const out = {};
    for (const item of raw) {
      const key = String(item?.path || '').trim();
      if (!key) continue;
      out[key] = normalizeAppliesTo(item?.appliesTo, defaultAppliesToForPath(key));
    }
    return out;
  }
  if (raw instanceof Map) {
    const out = {};
    for (const [path, appliesTo] of raw.entries()) {
      const key = String(path || '').trim();
      if (!key) continue;
      out[key] = normalizeAppliesTo(appliesTo, defaultAppliesToForPath(key));
    }
    return out;
  }
  return Object.entries(raw || {}).reduce((acc, [path, appliesTo]) => {
    const key = String(path || '').trim();
    if (!key) return acc;
    acc[key] = normalizeAppliesTo(appliesTo, defaultAppliesToForPath(key));
    return acc;
  }, {});
}

async function buildEffectiveFieldApplicabilityForService(serviceDoc) {
  const businessUnitId = extractBusinessUnitIdFromService(serviceDoc);
  if (!businessUnitId || !mongoose.Types.ObjectId.isValid(businessUnitId)) return {};

  const businessUnit = await BusinessUnit.findById(businessUnitId)
    .select('locationData.primaryZoneId compliance.enabledPackCodes compliance.fieldApplicability compliance.fields')
    .lean();
  if (!businessUnit) return {};

  // Product decision: guest-link should request exactly what provider selected
  // in Business Unit Detail (no extra enforcement from compliance packs here).
  return getBusinessUnitFieldApplicability(businessUnit);
}

function extractBusinessUnitIdFromService(serviceDoc) {
  const rawBusinessUnitId = serviceDoc?.BusinessUnitId && typeof serviceDoc.BusinessUnitId === 'object'
    ? serviceDoc.BusinessUnitId?._id
    : (serviceDoc?.BusinessUnitId || serviceDoc?.businessUnitId);
  return String(rawBusinessUnitId || '').trim();
}

async function buildDataTreatmentConfigForService(serviceDoc) {
  const businessUnitId = extractBusinessUnitIdFromService(serviceDoc);
  if (!businessUnitId || !mongoose.Types.ObjectId.isValid(businessUnitId)) {
    return { enabled: false, policyUrl: null, customText: null, consentRequired: false };
  }

  const businessUnit = await BusinessUnit.findById(businessUnitId)
    .select('compliance.dataTreatment.enabled compliance.dataTreatment.policyUrl compliance.dataTreatment.customText')
    .lean();
  const enabled = businessUnit?.compliance?.dataTreatment?.enabled !== false;
  const policyUrl = enabled ? cleanText(businessUnit?.compliance?.dataTreatment?.policyUrl) : null;
  const customText = enabled ? cleanText(businessUnit?.compliance?.dataTreatment?.customText) : null;
  return {
    enabled,
    policyUrl: policyUrl || null,
    customText: customText || null,
    consentRequired: enabled,
  };
}

async function buildApartmentRulesConfigForService(serviceDoc) {
  const businessUnitId = extractBusinessUnitIdFromService(serviceDoc);
  if (!businessUnitId || !mongoose.Types.ObjectId.isValid(businessUnitId)) {
    return { enabled: false, policyUrl: null, customText: null, consentRequired: false };
  }

  const businessUnit = await BusinessUnit.findById(businessUnitId)
    .select('compliance.apartmentRules.enabled compliance.apartmentRules.policyUrl compliance.apartmentRules.customText')
    .lean();
  const enabled = businessUnit?.compliance?.apartmentRules?.enabled !== false;
  const policyUrl = enabled ? cleanText(businessUnit?.compliance?.apartmentRules?.policyUrl) : null;
  const customText = enabled ? cleanText(businessUnit?.compliance?.apartmentRules?.customText) : null;
  return {
    enabled,
    policyUrl: policyUrl || null,
    customText: customText || null,
    consentRequired: enabled,
  };
}

function normalizeDataTreatmentConsentPayload(raw = null) {
  if (!raw || typeof raw !== 'object') return null;
  const accepted = toBool(raw.accepted, false);
  return {
    accepted,
    acceptedAt: accepted ? parseDateSafe(raw.acceptedAt) : null,
    policyUrl: cleanText(raw.policyUrl),
    policyText: cleanText(raw.policyText),
  };
}

function normalizeApartmentRulesConsentPayload(raw = null) {
  if (!raw || typeof raw !== 'object') return null;
  const accepted = toBool(raw.accepted, false);
  return {
    accepted,
    acceptedAt: accepted ? parseDateSafe(raw.acceptedAt) : null,
    policyUrl: cleanText(raw.policyUrl),
    policyText: cleanText(raw.policyText),
  };
}

function normalizeInvoiceInformationPayload(raw = {}) {
  return {
    email: cleanEmail(raw?.email),
    cellphone: cleanText(raw?.cellphone),
    address: cleanText(raw?.address),
  };
}

function normalizeVisitorsPayload(rawVisitors = []) {
  return (Array.isArray(rawVisitors) ? rawVisitors : [])
    .map((entry) => ({
      name: cleanText(entry?.name),
      document: cleanText(entry?.document),
    }))
    .filter((entry) => entry.name || entry.document);
}

function normalizeCheckInVisitorsPayload(rawVisitors = []) {
  return (Array.isArray(rawVisitors) ? rawVisitors : [])
    .map((entry) => {
      const ownerRoleRaw = String(entry?.ownerRole || entry?.guestRole || '').trim();
      const ownerRole = ownerRoleRaw === 'Guest' ? 'Guest' : 'Main guest';
      const ownerIndexRaw = Number(
        entry?.ownerIndex !== undefined && entry?.ownerIndex !== null
          ? entry.ownerIndex
          : entry?.guestIndex
      );
      const ownerIndex = Number.isFinite(ownerIndexRaw) && ownerIndexRaw >= 0
        ? Math.floor(ownerIndexRaw)
        : 0;
      return {
        name: cleanText(entry?.name),
        document: cleanText(entry?.document),
        role: 'Visitor',
        ownerRole,
        ownerIndex,
      };
    })
    .filter((entry) => entry.name || entry.document);
}

function buildCheckInVisitorsFromGuests(guests = []) {
  return (Array.isArray(guests) ? guests : [])
    .flatMap((guest, index) => {
      const role = String(guest?.role || '').trim() === 'Guest' ? 'Guest' : 'Main guest';
      const visitors = normalizeVisitorsPayload(guest?.visitors || []);
      return visitors.map((visitor) => ({
        name: visitor.name,
        document: visitor.document,
        role: 'Visitor',
        ownerRole: role,
        ownerIndex: Math.max(0, Number(index) || 0),
      }));
    });
}

function normalizeRegulationPayload(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const normalizeScope = (scopeRaw = {}, legacy = {}) => {
    const countryCode = cleanText(scopeRaw?.countryCode || legacy?.countryCode);
    const countryName = cleanText(scopeRaw?.countryName || legacy?.countryName);
    const cityCode = cleanText(scopeRaw?.cityCode || legacy?.cityCode);
    const cityName = cleanText(scopeRaw?.cityName || legacy?.cityName);
    const value = cleanText(
      scopeRaw?.value ||
      scopeRaw?.city ||
      scopeRaw?.name ||
      legacy?.value ||
      legacy?.city ||
      legacy?.name ||
      cityName ||
      countryName
    );
    return {
      value: value || null,
      countryCode: countryCode || null,
      countryName: countryName || null,
      cityCode: cityCode || null,
      cityName: cityName || null,
    };
  };

  return {
    residence: normalizeScope(source?.residence || {}, {
      value: source?.residenceCity || source?.cityOfResidence,
      countryCode: source?.residenceCountryCode,
      countryName: source?.residenceCountryName,
      cityCode: source?.residenceCityCode,
      cityName: source?.residenceCityName,
    }),
    origin: normalizeScope(source?.origin || {}, {
      value: source?.originCity,
      countryCode: source?.originCountryCode,
      countryName: source?.originCountryName,
      cityCode: source?.originCityCode,
      cityName: source?.originCityName,
    }),
    destination: normalizeScope(source?.destination || {}, {
      value: source?.destinationCity,
      countryCode: source?.destinationCountryCode,
      countryName: source?.destinationCountryName,
      cityCode: source?.destinationCityCode,
      cityName: source?.destinationCityName,
    }),
  };
}

function mergeInvoiceInformation(preferred = null, fallback = null) {
  const preferredInvoice = normalizeInvoiceInformationPayload(preferred || {});
  const fallbackInvoice = normalizeInvoiceInformationPayload(fallback || {});
  return {
    email: preferredInvoice.email || fallbackInvoice.email || null,
    cellphone: preferredInvoice.cellphone || fallbackInvoice.cellphone || null,
    address: preferredInvoice.address || fallbackInvoice.address || null,
  };
}

function mergeVisitors(preferred = null, fallback = null) {
  if (Array.isArray(preferred)) return normalizeCheckInVisitorsPayload(preferred);
  if (Array.isArray(fallback)) return normalizeCheckInVisitorsPayload(fallback);
  return [];
}

function mergeRegulation(preferred = null, fallback = null) {
  const preferredRegulation = normalizeRegulationPayload(preferred || {});
  const fallbackRegulation = normalizeRegulationPayload(fallback || {});
  const mergeScope = (preferredScope = {}, fallbackScope = {}) => ({
    value: preferredScope?.value || fallbackScope?.value || null,
    countryCode: preferredScope?.countryCode || fallbackScope?.countryCode || null,
    countryName: preferredScope?.countryName || fallbackScope?.countryName || null,
    cityCode: preferredScope?.cityCode || fallbackScope?.cityCode || null,
    cityName: preferredScope?.cityName || fallbackScope?.cityName || null,
  });
  return {
    residence: mergeScope(preferredRegulation?.residence, fallbackRegulation?.residence),
    origin: mergeScope(preferredRegulation?.origin, fallbackRegulation?.origin),
    destination: mergeScope(preferredRegulation?.destination, fallbackRegulation?.destination),
  };
}

function flattenRegulationPayload(raw = {}) {
  const regulation = normalizeRegulationPayload(raw || {});
  return {
    residenceCity: regulation?.residence?.value || null,
    originCity: regulation?.origin?.value || null,
    destinationCity: regulation?.destination?.value || null,
    residenceCountryCode: regulation?.residence?.countryCode || null,
    residenceCountryName: regulation?.residence?.countryName || null,
    residenceCityCode: regulation?.residence?.cityCode || null,
    residenceCityName: regulation?.residence?.cityName || null,
    originCountryCode: regulation?.origin?.countryCode || null,
    originCountryName: regulation?.origin?.countryName || null,
    originCityCode: regulation?.origin?.cityCode || null,
    originCityName: regulation?.origin?.cityName || null,
    destinationCountryCode: regulation?.destination?.countryCode || null,
    destinationCountryName: regulation?.destination?.countryName || null,
    destinationCityCode: regulation?.destination?.cityCode || null,
    destinationCityName: regulation?.destination?.cityName || null,
  };
}

function readRegulationPath(rawRegulation = {}, path = '') {
  const regulation = normalizeRegulationPayload(rawRegulation || {});
  const key = String(path || '').trim();
  const map = {
    residenceCity: regulation?.residence?.value,
    originCity: regulation?.origin?.value,
    destinationCity: regulation?.destination?.value,
    residenceCountryCode: regulation?.residence?.countryCode,
    residenceCountryName: regulation?.residence?.countryName,
    residenceCityCode: regulation?.residence?.cityCode,
    residenceCityName: regulation?.residence?.cityName,
    originCountryCode: regulation?.origin?.countryCode,
    originCountryName: regulation?.origin?.countryName,
    originCityCode: regulation?.origin?.cityCode,
    originCityName: regulation?.origin?.cityName,
    destinationCountryCode: regulation?.destination?.countryCode,
    destinationCountryName: regulation?.destination?.countryName,
    destinationCityCode: regulation?.destination?.cityCode,
    destinationCityName: regulation?.destination?.cityName,
  };
  return map[key];
}

function normalizeCheckInPayload(raw = {}) {
  const topLevelVisitorsRaw = Array.isArray(raw?.visitors) ? raw.visitors : [];
  const guestsFromNewPayload = Array.isArray(raw?.guests) ? raw.guests : [];

  const guestsFromOldPayload = (() => {
    const primary = raw?.primaryGuest || null;
    if (!primary) return [];

    const legacyMain = {
      firstName: cleanText(raw?.primaryGuest?.firstName || raw?.primaryGuest?.names),
      secondName: cleanText(raw?.primaryGuest?.secondName),
      firstLastName: cleanText(raw?.primaryGuest?.firstLastName || raw?.primaryGuest?.lastNames),
      secondLastName: cleanText(raw?.primaryGuest?.secondLastName),
      dateOfBirth: parseDateSafe(raw?.primaryGuest?.dateOfBirth || raw?.primaryGuest?.regulation?.dateOfBirth),
      IdType: cleanText(raw?.primaryGuest?.IdType || raw?.primaryGuest?.documentType),
      Id: cleanText(raw?.primaryGuest?.Id || raw?.primaryGuest?.documentNumber),
      nationality: cleanText(raw?.primaryGuest?.nationality),
      role: 'Main guest',
      invoiceInformation: normalizeInvoiceInformationPayload(raw?.primaryGuest?.invoice || {}),
      visitors: normalizeVisitorsPayload(raw?.primaryGuest?.visitors || []),
      regulation: normalizeRegulationPayload(raw?.primaryGuest?.regulation || {}),
    };

    const companionsRaw = Array.isArray(raw?.companions) ? raw.companions : [];
    const legacyCompanions = companionsRaw.map((entry) => ({
      firstName: cleanText(entry?.firstName || entry?.fullName),
      secondName: cleanText(entry?.secondName),
      firstLastName: cleanText(entry?.firstLastName),
      secondLastName: cleanText(entry?.secondLastName),
      dateOfBirth: parseDateSafe(entry?.dateOfBirth),
      IdType: cleanText(entry?.IdType),
      Id: cleanText(entry?.Id),
      nationality: cleanText(entry?.nationality),
      role: 'Guest',
      invoiceInformation: normalizeInvoiceInformationPayload(entry?.invoice || {}),
      visitors: normalizeVisitorsPayload(entry?.visitors || []),
      regulation: normalizeRegulationPayload(entry?.regulation || {}),
    }));

    return [legacyMain, ...legacyCompanions];
  })();

  const guestsRaw = guestsFromNewPayload.length ? guestsFromNewPayload : guestsFromOldPayload;
  const guests = guestsRaw
    .map((entry) => ({
      firstName: cleanText(entry?.firstName),
      secondName: cleanText(entry?.secondName),
      firstLastName: cleanText(entry?.firstLastName),
      secondLastName: cleanText(entry?.secondLastName),
      dateOfBirth: parseDateSafe(entry?.dateOfBirth),
      IdType: cleanText(entry?.IdType),
      Id: cleanText(entry?.Id),
      nationality: cleanText(entry?.nationality),
      role: String(entry?.role || '').trim() === 'Main guest' ? 'Main guest' : 'Guest',
      invoiceInformation: normalizeInvoiceInformationPayload(entry?.invoiceInformation || entry?.invoice || {}),
      visitors: normalizeVisitorsPayload(entry?.visitors || []),
      regulation: normalizeRegulationPayload(entry?.regulation || {}),
    }))
    .filter((entry) => entry.firstName || entry.firstLastName || entry.Id || entry.IdType || entry.nationality || entry.dateOfBirth);

  const visitors = topLevelVisitorsRaw.length
    ? normalizeCheckInVisitorsPayload(topLevelVisitorsRaw)
    : buildCheckInVisitorsFromGuests(guestsRaw);

  const mainGuest = getMainGuest(guests);
  if (mainGuest) {
    // Backward compatibility: if a legacy payload sends root invoice/regulation,
    // fold those values into the main guest.
    mainGuest.invoiceInformation = mergeInvoiceInformation(
      mainGuest?.invoiceInformation,
      mergeInvoiceInformation(raw?.invoiceInformation, raw?.primaryGuest?.invoice)
    );
    mainGuest.regulation = mergeRegulation(
      mainGuest?.regulation,
      mergeRegulation(raw?.regulation, raw?.primaryGuest?.regulation)
    );
  }

  const dataTreatmentConsent = normalizeDataTreatmentConsentPayload(raw?.dataTreatmentConsent);
  const apartmentRulesConsent = normalizeApartmentRulesConsentPayload(raw?.apartmentRulesConsent);
  const signature = normalizeSignaturePayload(raw?.signature);

  return { guests, visitors, dataTreatmentConsent, apartmentRulesConsent, signature };
}

function getMainGuest(guests = []) {
  const exact = guests.find((entry) => entry?.role === 'Main guest');
  if (exact) return exact;
  return guests[0] || null;
}

function getMainGuestInvoiceContact(checkIn = {}) {
  const mainGuest = getMainGuest(checkIn?.guests || []);
  return {
    email: cleanText(mainGuest?.invoiceInformation?.email) || null,
    phone: cleanText(mainGuest?.invoiceInformation?.cellphone) || null,
  };
}

function getGuestLinkRecipientEmail(doc = {}, overrideEmail = null) {
  const preferred = normalizeEmail(overrideEmail);
  if (preferred) return preferred;

  // Backward compatibility for legacy docs that still have root guestEmail.
  const legacy = normalizeEmail(doc?.guestEmail);
  if (legacy) return legacy;

  const fromCheckIn = normalizeEmail(getMainGuestInvoiceContact(doc?.checkIn || {}).email);
  return fromCheckIn || null;
}

function hasRequiredMainGuestFields(mainGuest = {}) {
  return !!(
    mainGuest?.firstName &&
    mainGuest?.firstLastName &&
    mainGuest?.IdType &&
    mainGuest?.Id &&
    mainGuest?.nationality
  );
}

function hasRequiredPrimaryCheckInFields(checkIn = {}) {
  const mainGuest = getMainGuest(checkIn?.guests || []);
  const readMain = (path) => readCheckInFieldValue(checkIn, path, mainGuest);
  return !!(
    hasRequiredMainGuestFields(mainGuest) &&
    hasValue(mainGuest?.dateOfBirth) &&
    hasValue(readMain('invoiceInformation.cellphone')) &&
    hasValue(readMain('invoiceInformation.email')) &&
    hasValue(readMain('invoiceInformation.address')) &&
    hasValue(readMain('checkIn.residenceCity')) &&
    hasValue(readMain('checkIn.originCity')) &&
    hasValue(readMain('checkIn.destinationCity'))
  );
}

function hasMainGuestAtLeastAge(checkIn = {}, minAge = 18) {
  const mainGuest = getMainGuest(checkIn?.guests || []);
  if (!mainGuest) return false;
  if (!hasValue(mainGuest?.dateOfBirth)) return false;
  return isAtLeastAge(mainGuest?.dateOfBirth, minAge);
}

function hasValue(value) {
  if (value === null || value === undefined) return false;
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

function isAlwaysOptionalPath(path = '') {
  const key = String(path || '').trim();
  return key === 'guests[].secondName' || key === 'guests[].secondLastName';
}

function readCheckInFieldValue(checkIn = {}, path = '', guest = null) {
  const key = String(path || '').trim();
  if (!key) return undefined;

  if (key.startsWith('guests[].')) {
    const suffix = key.replace(/^guests\[\]\./, '');
    const sourceGuest = guest || getMainGuest(checkIn?.guests || []) || null;
    if (!sourceGuest) return undefined;
    const guestFieldMap = {
      firstName: sourceGuest.firstName,
      secondName: sourceGuest.secondName,
      firstLastName: sourceGuest.firstLastName,
      secondLastName: sourceGuest.secondLastName,
      dateOfBirth: sourceGuest.dateOfBirth,
      IdType: sourceGuest.IdType,
      Id: sourceGuest.Id,
      nationality: sourceGuest.nationality,
      role: sourceGuest.role,
    };
    return guestFieldMap[suffix];
  }

  if (key.startsWith('invoiceInformation.')) {
    const suffix = key.replace(/^invoiceInformation\./, '');
    const sourceGuest = guest || getMainGuest(checkIn?.guests || []) || null;
    if (!sourceGuest) return undefined;
    const map = {
      email: sourceGuest?.invoiceInformation?.email,
      cellphone: sourceGuest?.invoiceInformation?.cellphone,
      address: sourceGuest?.invoiceInformation?.address,
    };
    return map[suffix];
  }

  if (key.startsWith('checkIn.')) {
    const suffix = key.replace(/^checkIn\./, '');
    const sourceGuest = guest || getMainGuest(checkIn?.guests || []) || null;
    if (!sourceGuest) return undefined;
    return readRegulationPath(sourceGuest?.regulation, suffix);
  }

  return undefined;
}

function hasRequiredMainGuestFieldsByApplicability(checkIn = {}, fieldApplicability = {}) {
  const entries = Object.entries(fieldApplicability || {});
  if (!entries.length) {
    return true;
  }

  const requiredEntries = entries.filter(([_, rawAppliesTo]) => {
    const appliesTo = normalizeAppliesTo(rawAppliesTo, 'main_guest');
    return appliesTo !== 'not_needed';
  });
  if (!requiredEntries.length) return true;

  const mainGuest = getMainGuest(checkIn?.guests || []);
  if (!mainGuest) return false;

  for (const [path, rawAppliesTo] of requiredEntries) {
    if (isAlwaysOptionalPath(path)) continue;
    const appliesTo = normalizeAppliesTo(rawAppliesTo, defaultAppliesToForPath(path));
    if (appliesTo === 'not_needed') continue;
    if (!hasValue(readCheckInFieldValue(checkIn, path, mainGuest))) {
      return false;
    }
  }
  return true;
}

function getMissingMainGuestFieldsByApplicability(checkIn = {}, fieldApplicability = {}) {
  const entries = Object.entries(fieldApplicability || {});
  if (!entries.length) return [];

  const requiredEntries = entries.filter(([_, rawAppliesTo]) => {
    const appliesTo = normalizeAppliesTo(rawAppliesTo, 'main_guest');
    return appliesTo !== 'not_needed';
  });
  if (!requiredEntries.length) return [];

  const mainGuest = getMainGuest(checkIn?.guests || []);
  if (!mainGuest) return requiredEntries.map(([path]) => String(path || '').trim()).filter(Boolean);

  const missing = [];
  for (const [path, rawAppliesTo] of requiredEntries) {
    if (isAlwaysOptionalPath(path)) continue;
    const appliesTo = normalizeAppliesTo(rawAppliesTo, defaultAppliesToForPath(path));
    if (appliesTo === 'not_needed') continue;
    if (!hasValue(readCheckInFieldValue(checkIn, path, mainGuest))) {
      missing.push(String(path || '').trim());
    }
  }

  return Array.from(new Set(missing.filter(Boolean)));
}

function hasRequiredCheckInFieldsByApplicability(checkIn = {}, fieldApplicability = {}) {
  const entries = Object.entries(fieldApplicability || {});
  if (!entries.length) {
    return true;
  }

  const requiredEntries = entries.filter(([_, rawAppliesTo]) => {
    const appliesTo = normalizeAppliesTo(rawAppliesTo, 'main_guest');
    return appliesTo !== 'not_needed';
  });
  if (!requiredEntries.length) return true;

  const guests = Array.isArray(checkIn?.guests) ? checkIn.guests : [];
  const mainGuest = getMainGuest(guests);
  if (!mainGuest) return false;

  for (const [path, rawAppliesTo] of requiredEntries) {
    if (isAlwaysOptionalPath(path)) continue;
    const appliesTo = normalizeAppliesTo(rawAppliesTo, defaultAppliesToForPath(path));
    if (appliesTo === 'not_needed') continue;
    if (appliesTo === 'all_guests') {
      if (!guests.length) return false;
      const allGuestsHaveField = guests.every((guest) => hasValue(readCheckInFieldValue(checkIn, path, guest)));
      if (!allGuestsHaveField) return false;
      continue;
    }

    const sourceGuest = String(path).startsWith('guests[].') ? mainGuest : null;
    if (!hasValue(readCheckInFieldValue(checkIn, path, sourceGuest))) {
      return false;
    }
  }

  return true;
}

function isGuestCompleteByApplicability(checkIn = {}, guest = null, isMainGuest = false, fieldApplicability = {}) {
  if (!guest || typeof guest !== 'object') return false;

  const entries = Object.entries(fieldApplicability || {});
  const requiredEntries = entries.filter(([_, rawAppliesTo]) => {
    const appliesTo = normalizeAppliesTo(rawAppliesTo, 'main_guest');
    return appliesTo !== 'not_needed';
  });

  if (!requiredEntries.length) {
    return hasRequiredMainGuestFields(guest);
  }

  for (const [path, rawAppliesTo] of requiredEntries) {
    if (isAlwaysOptionalPath(path)) continue;
    const key = String(path || '').trim();
    if (!key) continue;

    const appliesTo = normalizeAppliesTo(rawAppliesTo, defaultAppliesToForPath(key));
    if (appliesTo === 'not_needed') continue;

    if (key.startsWith('guests[].')) {
      if (appliesTo === 'main_guest' && !isMainGuest) {
        continue;
      }
      if (!hasValue(readCheckInFieldValue(checkIn, key, guest))) {
        return false;
      }
      continue;
    }

    if (appliesTo === 'main_guest' && !isMainGuest) continue;
    const sourceGuest = appliesTo === 'all_guests' ? guest : (isMainGuest ? guest : null);
    if (!hasValue(readCheckInFieldValue(checkIn, key, sourceGuest))) {
      return false;
    }
  }

  return true;
}

function countCompletedGuestsByApplicability(checkIn = {}, fieldApplicability = {}, totalGuests = 1) {
  const expectedGuests = Math.max(1, Number(totalGuests || 1));
  const guests = Array.isArray(checkIn?.guests) ? checkIn.guests : [];
  if (!guests.length) return 0;

  const mainGuest = getMainGuest(guests);
  const orderedGuests = [];
  if (mainGuest) orderedGuests.push(mainGuest);
  for (const guest of guests) {
    if (mainGuest && guest === mainGuest) continue;
    orderedGuests.push(guest);
  }

  let completed = 0;
  for (let index = 0; index < expectedGuests; index += 1) {
    const guest = orderedGuests[index];
    if (!guest) continue;
    const isMainGuest = index === 0;
    if (isGuestCompleteByApplicability(checkIn, guest, isMainGuest, fieldApplicability)) {
      completed += 1;
    }
  }

  return Math.min(expectedGuests, completed);
}

function hasAnyGuestRegistrationData(guest = {}) {
  if (!guest || typeof guest !== 'object') return false;
  return !!(
    hasValue(guest.firstName) ||
    hasValue(guest.secondName) ||
    hasValue(guest.firstLastName) ||
    hasValue(guest.secondLastName) ||
    hasValue(guest.dateOfBirth) ||
    hasValue(guest.IdType) ||
    hasValue(guest.Id) ||
    hasValue(guest.nationality)
  );
}

function buildGuestDisplayName(guest = {}, index = 0) {
  const nameParts = [
    String(guest?.firstName || '').trim(),
    String(guest?.secondName || '').trim(),
    String(guest?.firstLastName || '').trim(),
    String(guest?.secondLastName || '').trim(),
  ].filter(Boolean);
  if (nameParts.length) return nameParts.join(' ');
  return index === 0 ? 'Main guest' : `Guest ${index + 1}`;
}

function extractRegisteredGuests(guests = []) {
  const list = Array.isArray(guests) ? guests : [];
  if (!list.length) return [];

  const mainGuest = getMainGuest(list);
  const orderedGuests = [];
  if (mainGuest) orderedGuests.push(mainGuest);
  for (const guest of list) {
    if (mainGuest && guest === mainGuest) continue;
    orderedGuests.push(guest);
  }

  const out = [];
  for (let index = 0; index < orderedGuests.length; index += 1) {
    const guest = orderedGuests[index];
    if (!hasAnyGuestRegistrationData(guest)) continue;
    const isMainGuest = index === 0;
    out.push({
      role: isMainGuest ? 'Main guest' : 'Guest',
      fullName: buildGuestDisplayName(guest, index),
    });
  }

  return out;
}

function buildGuestLinkUrl(token) {
  return buildWebAppUrl(`/guest-link?token=${encodeURIComponent(token)}`);
}

function normalizeServiceType(type, title = '', internalName = '') {
  const t = String(type || '').trim().toLowerCase();
  if (t === 'accommodation' || t === 'experience' || t === 'transport') return t;
  const text = `${title} ${internalName}`.toLowerCase();
  if (text.includes('hotel') || text.includes('hostel') || text.includes('room') || text.includes('apartment')) {
    return 'accommodation';
  }
  return 'experience';
}

function normalizeBookingRowText(row = {}) {
  return [
    row?.guestName,
    row?.title,
    row?.internalName,
    row?.sourceStatus,
  ]
    .map((x) => String(x || '').toLowerCase())
    .join(' ');
}

function providerOwnedByRequester(providerDoc, reqUser) {
  if (!providerDoc || !reqUser) return false;
  if (String(reqUser.role || '').trim().toLowerCase() === 'admin') return true;
  const requesterId = String(reqUser._id || reqUser.id || '').trim();
  const ownerId = String(providerDoc.userId || '').trim();
  return !!requesterId && requesterId === ownerId;
}

async function loadProviderForRequester(req, res) {
  const providerId = String(req.params.id || '').trim();
  const providerDoc = await Provider.findById(providerId).lean();
  if (!providerDoc) {
    res.status(404).json({ error: 'NOT_FOUND' });
    return null;
  }
  if (!providerOwnedByRequester(providerDoc, req.user)) {
    res.status(403).json({ error: 'FORBIDDEN' });
    return null;
  }
  return providerDoc;
}

async function sendGuestLinkEmail({ to, guestName, providerName, serviceName, shareUrl }) {
  const safeGuest = String(guestName || '').trim() || 'Guest';
  const safeProvider = String(providerName || '').trim() || 'your host';
  const safeService = String(serviceName || '').trim();
  const title = safeService ? `for ${safeService}` : 'for your reservation';
  const subject = `Your check-in link ${title}`;
  const html = `
    <p>Hi ${safeGuest},</p>
    <p>${safeProvider} shared your check-in link ${title}.</p>
    <p><a href="${shareUrl}">Open check-in</a></p>
    <p>If the button does not work, copy this URL:</p>
    <p>${shareUrl}</p>
  `;
  const text = [
    `Hi ${safeGuest},`,
    `${safeProvider} shared your check-in link ${title}.`,
    shareUrl,
  ].join('\n');
  return sendEmail({ to, subject, html, text });
}

/** ===== List Providers ===== */
exports.list = async (req, res) => {
  try {
    const { page = 1, limit = 20, q, status, type, userId } = req.query;

    const filter = {};
    if (status) filter.status = status;
    if (type) filter.type = type;
    if (userId) filter.userId = userId;
    if (q) {
      filter.$or = [
        { slug: { $regex: q, $options: 'i' } },
        { name: { $regex: q, $options: 'i' } },
      ];
    }

    const cursor = Provider.find(filter)
      .sort({ createdAt: -1 })
      .skip((+page - 1) * +limit)
      .limit(+limit);

    const [items, total] = await Promise.all([
      cursor.lean(),
      Provider.countDocuments(filter)
    ]);

    res.json({ items, total, page: +page, pages: Math.ceil(total / +limit) });
  } catch (err) {
    console.error('provider.list error', err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
};

/** ===== Get Provider by id ===== */
exports.get = async (req, res) => {
  try {
    const doc = await Provider.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: 'NOT_FOUND' });
    res.json(doc);
  } catch (err) {
    console.error('provider.get error', err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
};

/** ===== Create Provider ===== */
exports.create = async (req, res) => {
  try {
    const isAdmin = String(req.user?.role || '').trim().toLowerCase() === 'admin';
    const requesterId = String(req.user?._id || req.user?.id || '').trim();
    const requestedUserId = String(req.body?.userId || '').trim();
    const userId = isAdmin ? requestedUserId : requesterId;

    if (!userId) {
      return res.status(400).json({ error: 'USER_ID_REQUIRED' });
    }

    // opcional: validar que el userId exista
    // const userExists = await User.exists({ _id: userId });
    // if (!userExists) return res.status(400).json({ error: 'USER_NOT_FOUND' });

    // evitar duplicados
    const exists = await Provider.findOne({ userId });
    if (exists) return res.status(409).json({ error: 'PROVIDER_ALREADY_EXISTS' });

    const payload = { ...(req.body || {}), userId };
    const doc = await Provider.create(payload);
    res.status(201).json(doc);
  } catch (err) {
    console.error('provider.create error', err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
};

/** ===== Update Provider ===== */
exports.update = async (req, res) => {
  try {
    const providerDoc = await loadProviderForRequester(req, res);
    if (!providerDoc) return;

    const payload = { ...(req.body || {}) };
    if (String(req.user?.role || '').trim().toLowerCase() !== 'admin') {
      delete payload.userId;
    }

    const doc = await Provider.findByIdAndUpdate(req.params.id, payload, { new: true });
    res.json(doc);
  } catch (err) {
    console.error('provider.update error', err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
};

/** ===== Delete Provider ===== */
exports.remove = async (req, res) => {
  try {
    const providerDoc = await loadProviderForRequester(req, res);
    if (!providerDoc) return;

    const ok = await Provider.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('provider.remove error', err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
};

/** ===== Admin management (extra) ===== */
exports.addAdmin = async (req, res) => {
  try {
    const providerDoc = await loadProviderForRequester(req, res);
    if (!providerDoc) return;

    const { email, role } = req.body;
    const doc = await Provider.findById(req.params.id);

    doc.adminUsers.push({ email, role });
    await doc.save();
    res.json(doc);
  } catch (err) {
    console.error('provider.addAdmin error', err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
};

/** ===== Guest Link management ===== */
exports.listGuestLinks = async (req, res) => {
  try {
    const providerDoc = await loadProviderForRequester(req, res);
    if (!providerDoc) return;

    const page = parsePositiveInt(req.query.page, 1, 1, 10000);
    const limit = parsePositiveInt(req.query.limit, 20, 1, 200);
    const status = String(req.query.status || '').trim();
    const serviceId = String(req.query.serviceId || '').trim();
    const q = String(req.query.q || '').trim();

    const filter = { providerId: providerDoc._id };
    if (status) filter.status = status;
    if (serviceId) filter.serviceId = serviceId;
    if (q) {
      filter.$or = [
        { guestName: { $regex: q, $options: 'i' } },
      ];
    }

    const cursor = ProviderGuestLink.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('serviceId', 'title serviceName internalName');

    const [items, total] = await Promise.all([
      cursor.lean(),
      ProviderGuestLink.countDocuments(filter),
    ]);

    res.json({
      items,
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error('provider.listGuestLinks error', err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
};

exports.listBookings = async (req, res) => {
  try {
    const providerDoc = await loadProviderForRequester(req, res);
    if (!providerDoc) return;

    const limit = parsePositiveInt(req.query.limit, 150, 1, 500);
    const q = String(req.query.q || '').trim().toLowerCase();
    const serviceIdFilter = String(req.query.serviceId || '').trim();
    const typeFilter = String(req.query.type || '').trim().toLowerCase(); // accommodation|experience|transport

    const serviceFilter = { providerId: providerDoc._id };
    if (serviceIdFilter) serviceFilter._id = serviceIdFilter;

    const providerServices = await Service.find(serviceFilter)
      .select('_id title serviceName internalName serviceType pricing BusinessUnitId')
      .lean();
    const providerServiceIds = providerServices.map((s) => s._id);
    const serviceById = new Map(providerServices.map((s) => [String(s._id), s]));
    const serviceBusinessUnitIdByServiceId = new Map(
      providerServices.map((service) => [String(service?._id || ''), extractBusinessUnitIdFromService(service)])
    );
    const businessUnitIds = Array.from(
      new Set(
        providerServices
          .map((service) => extractBusinessUnitIdFromService(service))
          .filter((id) => !!id && mongoose.Types.ObjectId.isValid(id))
      )
    );
    const businessUnitFieldApplicabilityById = new Map();
    if (businessUnitIds.length) {
      const businessUnits = await BusinessUnit.find({ _id: { $in: businessUnitIds } })
        .select('_id compliance.fieldApplicability compliance.fields')
        .lean();
      for (const businessUnit of businessUnits) {
        const businessUnitId = String(businessUnit?._id || '').trim();
        if (!businessUnitId) continue;
        businessUnitFieldApplicabilityById.set(
          businessUnitId,
          getBusinessUnitFieldApplicability(businessUnit)
        );
      }
    }

    const guestLinksFilter = { providerId: providerDoc._id };
    if (serviceIdFilter) guestLinksFilter.serviceId = serviceIdFilter;
    const guestLinks = await ProviderGuestLink.find(guestLinksFilter)
      .sort({ createdAt: -1 })
      .limit(500)
      .populate('serviceId', 'title serviceName internalName serviceType pricing BusinessUnitId')
      .lean();

    const itineraryFilter = {
      $or: [
        { 'booking.serviceSnapshot.providerId': providerDoc._id },
        ...(providerServiceIds.length ? [{ serviceId: { $in: providerServiceIds } }] : []),
      ],
    };
    if (serviceIdFilter) itineraryFilter.serviceId = serviceIdFilter;

    const itineraryItems = await ItineraryItem.find(itineraryFilter)
      .sort({ createdAt: -1 })
      .limit(500)
      .populate('serviceId', 'title serviceName internalName serviceType pricing BusinessUnitId')
      .lean();

    const convertedGuestLinkIds = new Set(
      itineraryItems
        .map((doc) => String(doc?.booking?.external?.providerBookingId || '').trim())
        .filter(Boolean)
    );

    const visibleGuestLinks = guestLinks.filter((doc) => {
      const linkId = String(doc?._id || '').trim();
      const hasConversionRefs = !!doc?.itineraryItemId || !!doc?.itineraryId;
      const alreadyRepresentedByItinerary = !!linkId && convertedGuestLinkIds.has(linkId);
      return !(hasConversionRefs || alreadyRepresentedByItinerary);
    });

    const fromGuestLinks = visibleGuestLinks.map((doc) => {
      const populatedService = doc?.serviceId && typeof doc.serviceId === 'object' ? doc.serviceId : null;
      const sid = populatedService?._id ? String(populatedService._id) : String(doc?.serviceId || '');
      const service = populatedService || (sid ? serviceById.get(sid) : null);
      const businessUnitId = extractBusinessUnitIdFromService(populatedService || service) || serviceBusinessUnitIdByServiceId.get(sid) || '';
      const fieldApplicability = businessUnitFieldApplicabilityById.get(businessUnitId) || {};
      const title = String(
        populatedService?.title ||
        populatedService?.serviceName ||
        service?.title ||
        service?.serviceName ||
        'Untitled service'
      );
      const internalName = String(
        populatedService?.internalName ||
        service?.internalName ||
        service?.serviceName ||
        '—'
      );
      const serviceType = normalizeServiceType(
        populatedService?.serviceType || service?.serviceType,
        title,
        internalName
      );
      const guestsCount = Math.max(1, Number(doc?.guestsCount || 1));
      const status = String(doc?.status || '').trim().toLowerCase();
      const checkInCompletedGuests = status === 'completed'
        ? guestsCount
        : countCompletedGuestsByApplicability(doc?.checkIn || {}, fieldApplicability, guestsCount);
      const invoiceContact = getMainGuestInvoiceContact(doc?.checkIn || {});
      const registeredGuests = extractRegisteredGuests(doc?.checkIn?.guests || []);
      return {
        _id: String(doc._id),
        source: 'guest_link',
        sourceStatus: String(doc.status || 'draft'),
        serviceId: sid || null,
        serviceType,
        title,
        internalName,
        guestName: String(doc.guestName || 'Guest'),
        guestEmail: invoiceContact.email,
        guestPhone: invoiceContact.phone,
        checkInDate: doc.checkInDate || null,
        checkOutDate: doc.checkOutDate || null,
        guestsCount,
        checkInCompletedGuests,
        registeredGuests,
        valueAmount: Number(
          doc?.quotedValue?.amount ??
          populatedService?.pricing?.basePrice ??
          service?.pricing?.basePrice ??
          NaN
        ),
        valueCurrency: String(
          doc?.quotedValue?.currency ||
          populatedService?.pricing?.currency ||
          service?.pricing?.currency ||
          ''
        ),
        paymentStatus: doc.status === 'completed' ? 'paid' : 'pending',
        checkInStatus: doc.status === 'completed' ? 'completed' : (doc.status === 'opened' ? 'in_progress' : 'pending'),
        shareUrl: doc.shareUrl || null,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
      };
    });

    const fromItinerary = itineraryItems.map((doc) => {
      const populatedService = doc?.serviceId && typeof doc.serviceId === 'object' ? doc.serviceId : null;
      const sid = populatedService?._id ? String(populatedService._id) : String(doc?.serviceId || '');
      const service = populatedService || (sid ? serviceById.get(sid) : null);
      const businessUnitId = extractBusinessUnitIdFromService(populatedService || service) || serviceBusinessUnitIdByServiceId.get(sid) || '';
      const fieldApplicability = businessUnitFieldApplicabilityById.get(businessUnitId) || {};
      const title = String(
        doc?.booking?.serviceSnapshot?.title ||
        populatedService?.title ||
        populatedService?.serviceName ||
        service?.title ||
        service?.serviceName ||
        'Untitled service'
      );
      const internalName = String(
        populatedService?.internalName ||
        service?.internalName ||
        '—'
      );
      const serviceType = normalizeServiceType(
        doc?.booking?.serviceSnapshot?.serviceType ||
        populatedService?.serviceType ||
        service?.serviceType,
        title,
        internalName
      );
      const guestsCount = Number(
        doc?.guests?.total ||
        ((Number(doc?.guests?.adults || 0) + Number(doc?.guests?.children || 0) + Number(doc?.guests?.babies || 0)) || 1)
      );
      const normalizedGuestsCount = Math.max(1, guestsCount);
      const itineraryStatus = String(doc?.status || doc?.bookingStatus || 'draft').trim().toLowerCase();
      const fallbackCompletedGuests = ['completed', 'confirmed', 'booked'].includes(itineraryStatus)
        ? normalizedGuestsCount
        : 0;
      const computedCompletedGuests = countCompletedGuestsByApplicability(
        doc?.booking?.guestCheckIn || {},
        fieldApplicability,
        normalizedGuestsCount
      );
      const checkInGuests = Array.isArray(doc?.booking?.guestCheckIn?.guests)
        ? doc.booking.guestCheckIn.guests
        : [];
      const mainGuest = getMainGuest(checkInGuests) || null;
      const registeredGuests = extractRegisteredGuests(doc?.booking?.guestCheckIn?.guests || []);
      return {
        _id: String(doc._id),
        source: 'itinerary_item',
        sourceStatus: String(doc.bookingStatus || doc.status || 'draft'),
        serviceId: sid || null,
        serviceType,
        title,
        internalName,
        guestName: mainGuest ? buildGuestDisplayName(mainGuest, 0) : 'IBeento traveler',
        guestEmail: cleanText(mainGuest?.invoiceInformation?.email) || null,
        guestPhone: cleanText(mainGuest?.invoiceInformation?.cellphone) || null,
        checkInDate: doc?.booking?.schedule?.startDate || doc?.timelineStartDate || null,
        checkOutDate: doc?.booking?.schedule?.endDate || doc?.timelineEndDate || null,
        guestsCount: normalizedGuestsCount,
        checkInCompletedGuests: Math.max(computedCompletedGuests, fallbackCompletedGuests),
        registeredGuests,
        valueAmount: Number(
          doc?.payment?.amount ??
          doc?.booking?.serviceSnapshot?.pricing?.basePrice ??
          service?.pricing?.basePrice ??
          NaN
        ),
        valueCurrency: String(
          doc?.payment?.currency ||
          doc?.booking?.serviceSnapshot?.pricing?.currency ||
          service?.pricing?.currency ||
          ''
        ),
        paymentStatus: String(doc?.payment?.status || 'none'),
        checkInStatus: String(doc?.status || doc?.bookingStatus || 'draft'),
        shareUrl: null,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
      };
    });

    let rows = [...fromGuestLinks, ...fromItinerary];
    if (typeFilter) {
      rows = rows.filter((row) => String(row.serviceType || '').toLowerCase() === typeFilter);
    }
    if (q) {
      rows = rows.filter((row) => normalizeBookingRowText(row).includes(q));
    }

    rows.sort((a, b) => {
      const ta = a?.createdAt ? +new Date(a.createdAt) : 0;
      const tb = b?.createdAt ? +new Date(b.createdAt) : 0;
      return tb - ta;
    });

    const items = rows.slice(0, limit);
    res.json({
      items,
      total: rows.length,
      sources: {
        guestLinks: fromGuestLinks.length,
        itineraryItems: fromItinerary.length,
      },
    });
  } catch (err) {
    console.error('provider.listBookings error', err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
};

exports.createGuestLink = async (req, res) => {
  try {
    const providerDoc = await loadProviderForRequester(req, res);
    if (!providerDoc) return;

    const guestName = String(req.body?.guestName || '').trim();
    if (!guestName) {
      return res.status(400).json({ error: 'GUEST_NAME_REQUIRED' });
    }

    const sendNowByEmail = toBool(req.body?.sendEmail, false);
    const guestEmail = normalizeEmail(req.body?.guestEmail);
    const serviceId = String(req.body?.serviceId || '').trim() || null;
    if (!serviceId) {
      return res.status(400).json({ error: 'SERVICE_REQUIRED' });
    }
    const guestsCount = parsePositiveInt(req.body?.guestsCount, 1, 1, 30);
    const rawValueAmount = req.body?.valueAmount;
    const hasValueAmount = rawValueAmount !== undefined && rawValueAmount !== null && String(rawValueAmount).trim() !== '';
    const parsedValueAmount = Number(rawValueAmount);
    const valueAmount = Number.isFinite(parsedValueAmount) && parsedValueAmount >= 0 ? parsedValueAmount : null;

    let serviceDoc = null;
    if (serviceId) {
        serviceDoc = await Service.findById(serviceId)
        .select('_id providerId title serviceName internalName pricing serviceType accommodation.checkIn accommodation.checkOut location.primaryZoneId location.zonePathIds location.timeZone startingPoint.timeZone')
        .lean();
      if (!serviceDoc) {
        return res.status(400).json({ error: 'SERVICE_NOT_FOUND' });
      }
      if (String(serviceDoc.providerId || '') !== String(providerDoc._id)) {
        return res.status(403).json({ error: 'FORBIDDEN_SERVICE' });
      }
    }
    if (hasValueAmount && valueAmount === null) {
      return res.status(400).json({ error: 'INVALID_VALUE_AMOUNT' });
    }
    const valueCurrency = String(req.body?.valueCurrency || serviceDoc?.pricing?.currency || '').trim().toUpperCase() || null;

    const token = randomToken();
    const shareUrl = buildGuestLinkUrl(token);
    const now = new Date();

    const payload = {
      providerId: providerDoc._id,
      serviceId: serviceDoc?._id || null,
      createdByUserId: req.user?._id || null,
      guestName,
      checkInDate: req.body?.checkInDate
        ? await parseReservationBoundaryDate(req.body.checkInDate, { serviceDoc, providerDoc, isCheckout: false })
        : null,
      checkOutDate: req.body?.checkOutDate
        ? await parseReservationBoundaryDate(req.body.checkOutDate, { serviceDoc, providerDoc, isCheckout: true })
        : null,
      guestsCount,
      quotedValue: valueAmount !== null ? { amount: valueAmount, currency: valueCurrency } : undefined,
      status: sendNowByEmail && guestEmail ? 'sent' : 'draft',
      token,
      shareUrl,
      sentAt: sendNowByEmail && guestEmail ? now : null,
    };

    if (req.body?.checkInDate && !payload.checkInDate) {
      return res.status(400).json({ error: 'INVALID_CHECKIN_DATE' });
    }
    if (req.body?.checkOutDate && !payload.checkOutDate) {
      return res.status(400).json({ error: 'INVALID_CHECKOUT_DATE' });
    }

    const created = await ProviderGuestLink.create(payload);

    let emailDelivery = null;
    if (sendNowByEmail) {
      if (!guestEmail) {
        emailDelivery = { ok: false, reason: 'guestEmail is required to send email' };
      } else {
        try {
          await sendGuestLinkEmail({
            to: guestEmail,
            guestName,
            providerName: providerDoc?.name || null,
            serviceName: serviceDoc?.title || serviceDoc?.serviceName || null,
            shareUrl,
          });
          emailDelivery = { ok: true };
        } catch (mailErr) {
          emailDelivery = { ok: false, reason: String(mailErr?.message || mailErr) };
          await ProviderGuestLink.findByIdAndUpdate(created._id, {
            $set: {
              status: 'draft',
              sentAt: null,
            },
          });
        }
      }
    }

    const doc = await ProviderGuestLink.findById(created._id)
      .populate('serviceId', 'title serviceName internalName')
      .lean();

    res.status(201).json({
      item: doc,
      emailDelivery,
    });
  } catch (err) {
    console.error('provider.createGuestLink error', err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
};

exports.sendGuestLink = async (req, res) => {
  try {
    const providerDoc = await loadProviderForRequester(req, res);
    if (!providerDoc) return;

    const linkId = String(req.params.linkId || '').trim();
    const doc = await ProviderGuestLink.findOne({
      _id: linkId,
      providerId: providerDoc._id,
    }).populate('serviceId', 'title serviceName internalName');

    if (!doc) return res.status(404).json({ error: 'NOT_FOUND' });
    if (String(doc.status || '').toLowerCase() === 'cancelled') {
      return res.status(400).json({ error: 'LINK_CANCELLED' });
    }
    const recipientEmail = getGuestLinkRecipientEmail(doc, req.body?.guestEmail);
    if (!recipientEmail) {
      return res.status(400).json({ error: 'GUEST_EMAIL_REQUIRED' });
    }

    await sendGuestLinkEmail({
      to: recipientEmail,
      guestName: doc.guestName,
      providerName: providerDoc?.name || null,
      serviceName: doc?.serviceId?.title || doc?.serviceId?.serviceName || null,
      shareUrl: doc.shareUrl,
    });

    doc.status = 'sent';
    doc.sentAt = new Date();
    await doc.save();

    res.json({ item: doc.toObject() });
  } catch (err) {
    console.error('provider.sendGuestLink error', err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
};

exports.updateGuestLink = async (req, res) => {
  try {
    const providerDoc = await loadProviderForRequester(req, res);
    if (!providerDoc) return;

    const linkId = String(req.params.linkId || '').trim();
    const existing = await ProviderGuestLink.findOne({
      _id: linkId,
      providerId: providerDoc._id,
    });
    if (!existing) return res.status(404).json({ error: 'NOT_FOUND' });
    if (String(existing.status || '').toLowerCase() === 'cancelled') {
      return res.status(400).json({ error: 'LINK_CANCELLED' });
    }

    const body = req.body || {};
    const set = {};
    const unset = {};

    if (Object.prototype.hasOwnProperty.call(body, 'guestName')) {
      const guestName = String(body.guestName || '').trim();
      if (!guestName) return res.status(400).json({ error: 'GUEST_NAME_REQUIRED' });
      set.guestName = guestName;
    }

    let resolvedServiceDoc = null;
    if (Object.prototype.hasOwnProperty.call(body, 'serviceId')) {
      const serviceId = String(body.serviceId || '').trim();
      if (!serviceId) {
        set.serviceId = null;
      } else {
        resolvedServiceDoc = await Service.findById(serviceId)
          .select('_id providerId pricing serviceType accommodation.checkIn accommodation.checkOut location.primaryZoneId location.zonePathIds location.timeZone startingPoint.timeZone')
          .lean();
        if (!resolvedServiceDoc) return res.status(400).json({ error: 'SERVICE_NOT_FOUND' });
        if (String(resolvedServiceDoc.providerId || '') !== String(providerDoc._id)) {
          return res.status(403).json({ error: 'FORBIDDEN_SERVICE' });
        }
        set.serviceId = resolvedServiceDoc._id;
      }
    }

    let serviceDocForDateParsing = resolvedServiceDoc;
    const dateFieldsProvided =
      Object.prototype.hasOwnProperty.call(body, 'checkInDate') ||
      Object.prototype.hasOwnProperty.call(body, 'checkOutDate');
    if (dateFieldsProvided && !serviceDocForDateParsing) {
      const existingServiceId = String(existing?.serviceId || '').trim();
      if (existingServiceId && mongoose.Types.ObjectId.isValid(existingServiceId)) {
        serviceDocForDateParsing = await Service.findById(existingServiceId)
          .select('_id providerId pricing serviceType accommodation.checkIn accommodation.checkOut location.primaryZoneId location.zonePathIds location.timeZone startingPoint.timeZone')
          .lean();
      }
    }

    if (Object.prototype.hasOwnProperty.call(body, 'checkInDate')) {
      const raw = body.checkInDate;
      if (raw === null || raw === '') set.checkInDate = null;
      else {
        const d = await parseReservationBoundaryDate(raw, {
          serviceDoc: serviceDocForDateParsing,
          providerDoc,
          isCheckout: false,
        });
        if (!d || Number.isNaN(d.getTime())) return res.status(400).json({ error: 'INVALID_CHECKIN_DATE' });
        set.checkInDate = d;
      }
    }

    if (Object.prototype.hasOwnProperty.call(body, 'checkOutDate')) {
      const raw = body.checkOutDate;
      if (raw === null || raw === '') set.checkOutDate = null;
      else {
        const d = await parseReservationBoundaryDate(raw, {
          serviceDoc: serviceDocForDateParsing,
          providerDoc,
          isCheckout: true,
        });
        if (!d || Number.isNaN(d.getTime())) return res.status(400).json({ error: 'INVALID_CHECKOUT_DATE' });
        set.checkOutDate = d;
      }
    }

    if (Object.prototype.hasOwnProperty.call(body, 'guestsCount')) {
      const n = Number(body.guestsCount);
      if (!Number.isFinite(n) || n < 1 || n > 30) {
        return res.status(400).json({ error: 'INVALID_GUESTS_COUNT' });
      }
      set.guestsCount = Math.floor(n);
    }

    if (
      Object.prototype.hasOwnProperty.call(body, 'valueAmount') ||
      Object.prototype.hasOwnProperty.call(body, 'valueCurrency')
    ) {
      const rawAmount = Object.prototype.hasOwnProperty.call(body, 'valueAmount')
        ? body.valueAmount
        : existing?.quotedValue?.amount;
      const hasAmount = rawAmount !== undefined && rawAmount !== null && String(rawAmount).trim() !== '';
      if (!hasAmount) {
        unset.quotedValue = 1;
      } else {
        const parsedAmount = Number(rawAmount);
        if (!Number.isFinite(parsedAmount) || parsedAmount < 0) {
          return res.status(400).json({ error: 'INVALID_VALUE_AMOUNT' });
        }
        const currency = String(
          body.valueCurrency ||
          resolvedServiceDoc?.pricing?.currency ||
          existing?.quotedValue?.currency ||
          ''
        ).trim().toUpperCase() || null;
        set.quotedValue = { amount: parsedAmount, currency };
      }
    }

    const update = {};
    if (Object.keys(set).length) update.$set = set;
    if (Object.keys(unset).length) update.$unset = unset;
    if (!Object.keys(update).length) {
      const item = await ProviderGuestLink.findById(existing._id)
        .populate('serviceId', 'title serviceName internalName serviceType pricing')
        .lean();
      return res.json({ item });
    }

    const item = await ProviderGuestLink.findByIdAndUpdate(existing._id, update, { new: true })
      .populate('serviceId', 'title serviceName internalName serviceType pricing')
      .lean();

    return res.json({ item });
  } catch (err) {
    console.error('provider.updateGuestLink error', err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
};

exports.deleteGuestLink = async (req, res) => {
  try {
    const providerDoc = await loadProviderForRequester(req, res);
    if (!providerDoc) return;

    const linkId = String(req.params.linkId || '').trim();
    const deleted = await ProviderGuestLink.findOneAndDelete({
      _id: linkId,
      providerId: providerDoc._id,
    }).lean();

    if (!deleted) return res.status(404).json({ error: 'NOT_FOUND' });

    return res.json({ ok: true });
  } catch (err) {
    console.error('provider.deleteGuestLink error', err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
};

exports.resolveGuestLink = async (req, res) => {
  try {
    const token = String(req.query.token || req.body?.token || '').trim();
    if (!token) return res.status(400).json({ error: 'TOKEN_REQUIRED' });

    const doc = await ProviderGuestLink.findOne({ token })
      .populate('providerId', 'name userId')
      .populate('serviceId', 'title serviceName internalName location.primaryZoneId location.zonePathIds BusinessUnitId businessUnitId')
      .lean();

    if (!doc) return res.status(404).json({ error: 'NOT_FOUND' });
    if (String(doc.status || '').toLowerCase() === 'cancelled') {
      return res.status(410).json({ error: 'LINK_CANCELLED' });
    }

    const now = new Date();
    const nextStatus = ['draft', 'sent'].includes(String(doc.status || '').toLowerCase())
      ? 'opened'
      : doc.status;

    await ProviderGuestLink.updateOne(
      { _id: doc._id },
      {
        $set: {
          status: nextStatus,
          openedAt: now,
        },
        $inc: { openCount: 1 },
      }
    );

    const serviceForComplianceCountry = doc?.serviceId && typeof doc.serviceId === 'object'
      ? doc.serviceId
      : null;
    let businessUnitId = extractBusinessUnitIdFromService(serviceForComplianceCountry);
    if (!businessUnitId) {
      const rawServiceId =
        doc?.serviceId && typeof doc.serviceId === 'object'
          ? String(doc.serviceId?._id || '').trim()
          : String(doc?.serviceId || '').trim();
      if (rawServiceId && mongoose.Types.ObjectId.isValid(rawServiceId)) {
        const serviceDocForBusinessUnit = await Service.findById(rawServiceId)
          .select('BusinessUnitId businessUnitId')
          .lean();
        businessUnitId = extractBusinessUnitIdFromService(serviceDocForBusinessUnit);
      }
    }
    const businessUnitDoc =
      businessUnitId && mongoose.Types.ObjectId.isValid(businessUnitId)
        ? await BusinessUnit.findById(businessUnitId).select('name businessName').lean()
        : null;
    let businessUnitName = cleanText(businessUnitDoc?.name) || cleanText(businessUnitDoc?.businessName);
    if (!businessUnitName) {
      const providerUserId =
        doc?.providerId && typeof doc.providerId === 'object'
          ? String(doc.providerId?.userId || '').trim()
          : '';
      if (providerUserId && mongoose.Types.ObjectId.isValid(providerUserId)) {
        const providerBusinessUnits = await BusinessUnit.find({ user: providerUserId })
          .select('name businessName')
          .sort({ updatedAt: -1 })
          .limit(2)
          .lean();
        if (providerBusinessUnits.length === 1) {
          businessUnitName =
            cleanText(providerBusinessUnits[0]?.name) ||
            cleanText(providerBusinessUnits[0]?.businessName);
        }
      }
    }
    const fieldApplicability = await buildEffectiveFieldApplicabilityForService(serviceForComplianceCountry);
    const dataTreatment = await buildDataTreatmentConfigForService(serviceForComplianceCountry);
    const apartmentRules = await buildApartmentRulesConfigForService(serviceForComplianceCountry);
    const complianceCountryName = await resolveCountryNameFromService(serviceForComplianceCountry);
    const storedGuests = Array.isArray(doc?.checkIn?.guests) ? doc.checkIn.guests : [];
    const inviteContact = getMainGuestInvoiceContact(doc?.checkIn || {});
    return res.json({
      item: {
        _id: String(doc._id),
        providerId: doc.providerId
          ? {
              _id: String(doc.providerId._id || doc.providerId),
              name: doc.providerId?.name || null,
            }
          : null,
        serviceId: doc.serviceId
          ? {
              _id: String(doc.serviceId._id || doc.serviceId),
              title: doc.serviceId?.title || doc.serviceId?.serviceName || doc.serviceId?.internalName || null,
            }
          : null,
        guestName: doc.guestName,
        guestEmail: inviteContact.email,
        guestPhone: inviteContact.phone,
        checkInDate: doc.checkInDate,
        checkOutDate: doc.checkOutDate,
        guestsCount: doc.guestsCount,
        shareUrl: doc.shareUrl,
        status: nextStatus,
        businessUnitName,
        complianceCountryName,
        fieldApplicability,
        dataTreatment,
        apartmentRules,
        mainGuestSaved:
          hasRequiredMainGuestFieldsByApplicability(doc?.checkIn || {}, fieldApplicability) &&
          hasMainGuestAtLeastAge(doc?.checkIn || {}, 18),
        checkIn: {
          guests: storedGuests.map((entry) => {
            const role = entry?.role === 'Main guest' ? 'Main guest' : 'Guest';
            const invoiceInformation = mergeInvoiceInformation(entry?.invoiceInformation, null);
            const regulation = mergeRegulation(entry?.regulation, null);
            return {
              firstName: entry?.firstName || null,
              secondName: entry?.secondName || null,
              firstLastName: entry?.firstLastName || null,
              secondLastName: entry?.secondLastName || null,
              dateOfBirth: entry?.dateOfBirth || null,
              IdType: entry?.IdType || null,
              Id: entry?.Id || null,
              nationality: entry?.nationality || null,
              role,
              invoiceInformation,
              visitors: normalizeVisitorsPayload(entry?.visitors || []),
              regulation: flattenRegulationPayload(regulation),
            };
          }),
          visitors: normalizeCheckInVisitorsPayload(doc?.checkIn?.visitors || []),
          dataTreatmentConsent: {
            accepted: doc?.checkIn?.dataTreatmentConsent?.accepted === true,
            acceptedAt: doc?.checkIn?.dataTreatmentConsent?.acceptedAt || null,
            policyUrl: doc?.checkIn?.dataTreatmentConsent?.policyUrl || dataTreatment?.policyUrl || null,
            policyText: doc?.checkIn?.dataTreatmentConsent?.policyText || dataTreatment?.customText || null,
          },
          apartmentRulesConsent: {
            accepted: doc?.checkIn?.apartmentRulesConsent?.accepted === true,
            acceptedAt: doc?.checkIn?.apartmentRulesConsent?.acceptedAt || null,
            policyUrl: doc?.checkIn?.apartmentRulesConsent?.policyUrl || apartmentRules?.policyUrl || null,
            policyText: doc?.checkIn?.apartmentRulesConsent?.policyText || apartmentRules?.customText || null,
          },
          submittedAt: doc?.checkIn?.submittedAt || null,
        },
      },
    });
  } catch (err) {
    console.error('provider.resolveGuestLink error', err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
};

exports.saveGuestLinkMainGuest = async (req, res) => {
  try {
    const token = String(req.body?.token || req.query?.token || '').trim();
    const requesterId = String(req.user?._id || req.user?.id || '').trim();
    if (!requesterId) return res.status(401).json({ error: 'UNAUTHORIZED' });
    if (!token) return res.status(400).json({ error: 'TOKEN_REQUIRED' });

    const doc = await ProviderGuestLink.findOne({ token }).lean();
    if (!doc) return res.status(404).json({ error: 'NOT_FOUND' });
    if (String(doc.status || '').toLowerCase() === 'cancelled') {
      return res.status(410).json({ error: 'LINK_CANCELLED' });
    }
    if (String(doc.status || '').toLowerCase() === 'completed') {
      return res.status(409).json({ error: 'LINK_ALREADY_COMPLETED' });
    }

    const serviceDoc = doc?.serviceId
      ? await Service.findById(doc.serviceId)
          .select('_id BusinessUnitId location.primaryZoneId location.zonePathIds')
          .lean()
      : null;
    const fieldApplicability = await buildEffectiveFieldApplicabilityForService(serviceDoc);
    const dataTreatment = await buildDataTreatmentConfigForService(serviceDoc);
    const apartmentRules = await buildApartmentRulesConfigForService(serviceDoc);
    const skipMainGuestValidation = toBool(req.body?.skipMainGuestValidation, false);
    const checkInPayload = normalizeCheckInPayload(req.body?.checkIn || {});
    const existingGuests = Array.isArray(doc?.checkIn?.guests) ? doc.checkIn.guests : [];
    const existingVisitors = normalizeCheckInVisitorsPayload(doc?.checkIn?.visitors || []);
    const existingMainGuest = getMainGuest(existingGuests) || {};
    const incomingMainGuest = getMainGuest(checkInPayload?.guests || []) || {};
    const incomingGuests = Array.isArray(checkInPayload?.guests) ? checkInPayload.guests : [];
    const incomingVisitors = normalizeCheckInVisitorsPayload(checkInPayload?.visitors || []);
    const mergedMainGuest = {
      firstName: incomingMainGuest.firstName || existingMainGuest.firstName || null,
      secondName: incomingMainGuest.secondName || existingMainGuest.secondName || null,
      firstLastName: incomingMainGuest.firstLastName || existingMainGuest.firstLastName || null,
      secondLastName: incomingMainGuest.secondLastName || existingMainGuest.secondLastName || null,
      dateOfBirth: incomingMainGuest.dateOfBirth || existingMainGuest.dateOfBirth || null,
      IdType: incomingMainGuest.IdType || existingMainGuest.IdType || null,
      Id: incomingMainGuest.Id || existingMainGuest.Id || null,
      nationality: incomingMainGuest.nationality || existingMainGuest.nationality || null,
      role: 'Main guest',
    };
    if (!skipMainGuestValidation && !hasRequiredMainGuestFields(mergedMainGuest)) {
      return res.status(400).json({ error: 'MAIN_GUEST_REQUIRED' });
    }
    if (!skipMainGuestValidation && hasValue(mergedMainGuest?.dateOfBirth) && !isAtLeastAge(mergedMainGuest?.dateOfBirth, 18)) {
      return res.status(400).json({ error: 'MAIN_GUEST_UNDERAGE', minAge: 18 });
    }

    mergedMainGuest.invoiceInformation = mergeInvoiceInformation(
      incomingMainGuest?.invoiceInformation,
      existingMainGuest?.invoiceInformation
    );
    mergedMainGuest.visitors = normalizeVisitorsPayload(
      Array.isArray(incomingMainGuest?.visitors) ? incomingMainGuest.visitors : existingMainGuest?.visitors
    );
    mergedMainGuest.regulation = mergeRegulation(
      incomingMainGuest?.regulation,
      existingMainGuest?.regulation
    );
    const incomingConsent = checkInPayload?.dataTreatmentConsent;
    const existingConsent = doc?.checkIn?.dataTreatmentConsent || {};
    const mergedDataTreatmentConsent = {
      accepted:
        incomingConsent && typeof incomingConsent.accepted === 'boolean'
          ? incomingConsent.accepted
          : existingConsent?.accepted === true,
      acceptedAt: null,
      policyUrl:
        cleanText(incomingConsent?.policyUrl) ||
        cleanText(existingConsent?.policyUrl) ||
        cleanText(dataTreatment?.policyUrl) ||
        null,
      policyText:
        cleanText(incomingConsent?.policyText) ||
        cleanText(existingConsent?.policyText) ||
        cleanText(dataTreatment?.customText) ||
        null,
    };
    if (mergedDataTreatmentConsent.accepted) {
      mergedDataTreatmentConsent.acceptedAt =
        incomingConsent?.acceptedAt ||
        existingConsent?.acceptedAt ||
        new Date();
    }
    const incomingApartmentRulesConsent = checkInPayload?.apartmentRulesConsent;
    const existingApartmentRulesConsent = doc?.checkIn?.apartmentRulesConsent || {};
    const mergedApartmentRulesConsent = {
      accepted:
        incomingApartmentRulesConsent && typeof incomingApartmentRulesConsent.accepted === 'boolean'
          ? incomingApartmentRulesConsent.accepted
          : existingApartmentRulesConsent?.accepted === true,
      acceptedAt: null,
      policyUrl:
        cleanText(incomingApartmentRulesConsent?.policyUrl) ||
        cleanText(existingApartmentRulesConsent?.policyUrl) ||
        cleanText(apartmentRules?.policyUrl) ||
        null,
      policyText:
        cleanText(incomingApartmentRulesConsent?.policyText) ||
        cleanText(existingApartmentRulesConsent?.policyText) ||
        cleanText(apartmentRules?.customText) ||
        null,
    };
    if (mergedApartmentRulesConsent.accepted) {
      mergedApartmentRulesConsent.acceptedAt =
        incomingApartmentRulesConsent?.acceptedAt ||
        existingApartmentRulesConsent?.acceptedAt ||
        new Date();
    }

    const expectedCompanions = Math.max(0, Number(doc?.guestsCount || 1) - 1);
    const existingCompanions = existingGuests.filter((entry) => String(entry?.role || '') !== 'Main guest');
    const incomingCompanions = incomingGuests
      .filter((entry) => String(entry?.role || '') !== 'Main guest');
    const companionsCount = Math.max(
      expectedCompanions,
      existingCompanions.length,
      incomingCompanions.length
    );

    const mergedCompanions = Array.from({ length: companionsCount }, (_, index) => {
      const existing = existingCompanions[index] || {};
      const incoming = incomingCompanions[index] || {};
      return {
        firstName: incoming.firstName || existing.firstName || null,
        secondName: incoming.secondName || existing.secondName || null,
        firstLastName: incoming.firstLastName || existing.firstLastName || null,
        secondLastName: incoming.secondLastName || existing.secondLastName || null,
        dateOfBirth: incoming.dateOfBirth || existing.dateOfBirth || null,
        IdType: incoming.IdType || existing.IdType || null,
        Id: incoming.Id || existing.Id || null,
        nationality: incoming.nationality || existing.nationality || null,
        role: 'Guest',
        invoiceInformation: mergeInvoiceInformation(incoming?.invoiceInformation, existing?.invoiceInformation),
        visitors: normalizeVisitorsPayload(
          Array.isArray(incoming?.visitors) ? incoming.visitors : existing?.visitors
        ),
        regulation: mergeRegulation(incoming?.regulation, existing?.regulation),
      };
    });

    const mergedGuests = (skipMainGuestValidation && !incomingGuests.length)
      ? existingGuests
      : [mergedMainGuest, ...mergedCompanions];
    const mergedVisitors = incomingVisitors.length ? incomingVisitors : existingVisitors;
    const mergedCheckIn = {
      guests: mergedGuests,
      visitors: mergedVisitors,
      dataTreatmentConsent: mergedDataTreatmentConsent,
      apartmentRulesConsent: mergedApartmentRulesConsent,
      signature: doc?.checkIn?.signature || null,
      submittedAt: doc?.checkIn?.submittedAt || null,
    };
    const mainGuestSaved =
      hasRequiredMainGuestFieldsByApplicability(mergedCheckIn, fieldApplicability) &&
      hasMainGuestAtLeastAge(mergedCheckIn, 18);
    const mainGuestMissingFields = mainGuestSaved
      ? []
      : getMissingMainGuestFieldsByApplicability(mergedCheckIn, fieldApplicability);

    await ProviderGuestLink.updateOne(
      { _id: doc._id },
      {
        $set: {
          checkIn: mergedCheckIn,
        },
        $unset: {
          'checkIn.invoiceInformation': 1,
          'checkIn.regulation': 1,
        },
      }
    );

    return res.json({ ok: true, mainGuestSaved, mainGuestMissingFields });
  } catch (err) {
    console.error('provider.saveGuestLinkMainGuest error', err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
};

exports.completeGuestLink = async (req, res) => {
  try {
    const token = String(req.body?.token || req.query?.token || '').trim();
    const requesterId = String(req.user?._id || req.user?.id || '').trim();
    if (!requesterId) return res.status(401).json({ error: 'UNAUTHORIZED' });
    if (!token) return res.status(400).json({ error: 'TOKEN_REQUIRED' });
    const requesterUser = await User.findById(requesterId).select('_id name email').lean();
    const submittedBy = buildSubmittedByActor(requesterId, requesterUser);

    const doc = await ProviderGuestLink.findOne({ token })
      .populate('providerId', 'name')
      .populate('serviceId', '_id providerId title serviceName internalName serviceType pricing duration location startingPoint')
      .lean();

    if (!doc) return res.status(404).json({ error: 'NOT_FOUND' });
    if (String(doc.status || '').toLowerCase() === 'cancelled') {
      return res.status(410).json({ error: 'LINK_CANCELLED' });
    }

    const previousConverterId = String(doc.convertedByUserId || '').trim();
    if (String(doc.status || '').toLowerCase() === 'completed' && previousConverterId && previousConverterId !== requesterId) {
      return res.status(409).json({ error: 'LINK_ALREADY_COMPLETED' });
    }
    if (String(doc.status || '').toLowerCase() === 'completed' && doc.itineraryId && doc.itineraryItemId) {
      return res.json({
        ok: true,
        alreadyCompleted: true,
        converted: {
          itineraryId: String(doc.itineraryId),
          itineraryItemId: String(doc.itineraryItemId),
          accountUserId: String(doc.convertedByUserId || requesterId),
        },
      });
    }

    const populatedService = doc?.serviceId && typeof doc.serviceId === 'object' ? doc.serviceId : null;
    const serviceId = populatedService?._id ? String(populatedService._id) : String(doc?.serviceId || '').trim();
    if (!serviceId) {
      return res.status(400).json({ error: 'SERVICE_REQUIRED' });
    }

    const serviceDoc = populatedService || await Service.findById(serviceId)
      .select('_id providerId title serviceName internalName serviceType pricing duration location startingPoint BusinessUnitId')
      .lean();
    if (!serviceDoc) return res.status(404).json({ error: 'SERVICE_NOT_FOUND' });

    const fieldApplicability = await buildEffectiveFieldApplicabilityForService(serviceDoc);
    const dataTreatment = await buildDataTreatmentConfigForService(serviceDoc);
    const apartmentRules = await buildApartmentRulesConfigForService(serviceDoc);
    const checkInPayload = normalizeCheckInPayload(req.body?.checkIn || {});
    const payloadMainGuest = getMainGuest(checkInPayload?.guests || []);
    if (hasValue(payloadMainGuest?.dateOfBirth) && !isAtLeastAge(payloadMainGuest?.dateOfBirth, 18)) {
      return res.status(400).json({ error: 'MAIN_GUEST_UNDERAGE', minAge: 18 });
    }
    const expectedCompanions = Math.max(0, Number(doc.guestsCount || 1) - 1);
    const requiresAllGuestFields = Object.entries(fieldApplicability || {}).some(([_, rawAppliesTo]) =>
      normalizeAppliesTo(rawAppliesTo, 'main_guest') === 'all_guests'
    );
    const providedCompanions = (checkInPayload?.guests || []).filter((entry) => String(entry?.role || '') === 'Guest');
    if (requiresAllGuestFields && expectedCompanions > 0 && providedCompanions.length < expectedCompanions) {
      return res.status(400).json({
        error: 'CHECKIN_COMPANIONS_REQUIRED',
        expectedCompanions,
      });
    }
    if (!hasRequiredCheckInFieldsByApplicability(checkInPayload, fieldApplicability)) {
      return res.status(400).json({ error: 'CHECKIN_PRIMARY_REQUIRED' });
    }
    const signatureInput = normalizeSignaturePayload(checkInPayload?.signature || req.body?.signature || null);
    if (!signatureInput) {
      return res.status(400).json({ error: 'SIGNATURE_REQUIRED' });
    }

    const now = new Date();
    const forwardedIp = String(req.headers['x-forwarded-for'] || '')
      .split(',')
      .map((entry) => String(entry || '').trim())
      .find(Boolean) || '';
    const remoteIp = String(req.ip || req.connection?.remoteAddress || '').trim();
    const userAgent = String(req.get('user-agent') || '').trim();
    const signatureSignerName = signatureInput?.signerName || cleanText(
      [payloadMainGuest?.firstName, payloadMainGuest?.firstLastName].filter(Boolean).join(' ')
    ) || null;
    const signatureCore = {
      format: signatureInput.format,
      signedAt: signatureInput.signedAt,
      signerRole: 'Main guest',
      signerName: signatureSignerName,
      canvas: signatureInput.canvas,
      strokes: signatureInput.strokes,
    };
    const signature = {
      ...signatureCore,
      evidence: {
        userId: requesterId || null,
        ipHash: hashSha256(forwardedIp || remoteIp),
        uaHash: hashSha256(userAgent),
      },
      integrityHash: hashSha256(JSON.stringify(signatureCore)),
    };

    const consentAccepted = checkInPayload?.dataTreatmentConsent?.accepted === true;
    if (dataTreatment?.consentRequired && !consentAccepted) {
      return res.status(400).json({ error: 'DATA_TREATMENT_CONSENT_REQUIRED' });
    }
    const dataTreatmentConsent = {
      accepted: consentAccepted,
      acceptedAt: consentAccepted
        ? (checkInPayload?.dataTreatmentConsent?.acceptedAt || now)
        : null,
      policyUrl:
        cleanText(checkInPayload?.dataTreatmentConsent?.policyUrl) ||
        cleanText(dataTreatment?.policyUrl) ||
        null,
      policyText:
        cleanText(checkInPayload?.dataTreatmentConsent?.policyText) ||
        cleanText(dataTreatment?.customText) ||
        null,
    };
    const apartmentRulesConsentAccepted = checkInPayload?.apartmentRulesConsent?.accepted === true;
    if (apartmentRules?.consentRequired && !apartmentRulesConsentAccepted) {
      return res.status(400).json({ error: 'APARTMENT_RULES_CONSENT_REQUIRED' });
    }
    const apartmentRulesConsent = {
      accepted: apartmentRulesConsentAccepted,
      acceptedAt: apartmentRulesConsentAccepted
        ? (checkInPayload?.apartmentRulesConsent?.acceptedAt || now)
        : null,
      policyUrl:
        cleanText(checkInPayload?.apartmentRulesConsent?.policyUrl) ||
        cleanText(apartmentRules?.policyUrl) ||
        null,
      policyText:
        cleanText(checkInPayload?.apartmentRulesConsent?.policyText) ||
        cleanText(apartmentRules?.customText) ||
        null,
    };

    const itineraryDoc = await ensureUserItinerary(requesterId, doc);

    const checkInDate = parseDateSafe(doc.checkInDate);
    const checkOutDate = parseDateSafe(doc.checkOutDate);
    const timelineStartDate = checkInDate || now;
    const timelineEndDate = checkOutDate || checkInDate || timelineStartDate;
    const guestsTotal = Math.max(
      1,
      Number(doc.guestsCount || 1),
      Number((checkInPayload?.guests || []).length || 0)
    );
    const payloadGuests = Array.isArray(checkInPayload?.guests) ? checkInPayload.guests : [];
    const payloadVisitors = normalizeCheckInVisitorsPayload(checkInPayload?.visitors || []);

    const itineraryItem = await ItineraryItem.create({
      itineraryId: itineraryDoc._id,
      serviceId: serviceDoc._id,
      status: 'booked',
      bookingStatus: 'confirmed',
      guests: {
        adults: guestsTotal,
        children: 0,
        babies: 0,
        total: guestsTotal,
      },
      timelineStartDate,
      timelineEndDate,
      booking: {
        serviceSnapshot: buildServiceSnapshot(serviceDoc),
        external: {
          providerBookingId: String(doc._id),
          bookingUrl: doc.shareUrl || undefined,
        },
        schedule: {
          startDate: checkInDate || undefined,
          endDate: checkOutDate || checkInDate || undefined,
          timeZone: serviceDoc?.startingPoint?.timeZone || serviceDoc?.location?.timeZone || undefined,
        },
        guestCheckIn: {
          guests: payloadGuests.map((entry) => {
            const role = entry?.role || 'Guest';
            return {
              firstName: entry.firstName || undefined,
              secondName: entry.secondName || undefined,
              firstLastName: entry.firstLastName || undefined,
              secondLastName: entry.secondLastName || undefined,
              dateOfBirth: entry.dateOfBirth || undefined,
              IdType: entry.IdType || undefined,
              Id: entry.Id || undefined,
              nationality: entry.nationality || undefined,
              role,
              invoiceInformation: mergeInvoiceInformation(entry?.invoiceInformation, null),
              visitors: normalizeVisitorsPayload(entry?.visitors || []),
              regulation: mergeRegulation(entry?.regulation, null),
            };
          }),
          visitors: payloadVisitors,
          dataTreatmentConsent: {
            accepted: dataTreatmentConsent.accepted,
            acceptedAt: dataTreatmentConsent.acceptedAt || undefined,
            policyUrl: dataTreatmentConsent.policyUrl || undefined,
            policyText: dataTreatmentConsent.policyText || undefined,
          },
          apartmentRulesConsent: {
            accepted: apartmentRulesConsent.accepted,
            acceptedAt: apartmentRulesConsent.acceptedAt || undefined,
            policyUrl: apartmentRulesConsent.policyUrl || undefined,
            policyText: apartmentRulesConsent.policyText || undefined,
          },
          submittedBy: submittedBy || undefined,
          signature,
          completedAt: now,
        },
        reservedAt: doc.createdAt || now,
        confirmedAt: now,
      },
      payment: {
        status: 'none',
        provider: 'none',
      },
      location: {
        countryId: serviceDoc?.location?.countryId || undefined,
        regionId: serviceDoc?.location?.regionId || undefined,
        cityId: serviceDoc?.location?.cityId || undefined,
        timeZone: serviceDoc?.startingPoint?.timeZone || serviceDoc?.location?.timeZone || undefined,
        address: serviceDoc?.location?.address || undefined,
        startPointAddress: serviceDoc?.startingPoint?.address || undefined,
        geo: normalizeGeoPoint(serviceDoc?.location?.geo),
        startPointGeo: normalizeGeoPoint(serviceDoc?.startingPoint?.geo),
      },
    });

    await ProviderGuestLink.updateOne(
      { _id: doc._id },
      {
        $set: {
          status: 'completed',
          completedAt: now,
          convertedByUserId: requesterId,
          itineraryId: itineraryDoc._id,
          itineraryItemId: itineraryItem._id,
          checkIn: {
            guests: payloadGuests.map((entry) => {
              const role = entry?.role || 'Guest';
              return {
                firstName: entry.firstName || null,
                secondName: entry.secondName || null,
                firstLastName: entry.firstLastName || null,
                secondLastName: entry.secondLastName || null,
                dateOfBirth: entry.dateOfBirth || null,
                IdType: entry.IdType || null,
                Id: entry.Id || null,
                nationality: entry.nationality || null,
                role,
                invoiceInformation: mergeInvoiceInformation(entry?.invoiceInformation, null),
                visitors: normalizeVisitorsPayload(entry?.visitors || []),
                regulation: mergeRegulation(entry?.regulation, null),
              };
            }),
            visitors: payloadVisitors,
            dataTreatmentConsent: {
              accepted: dataTreatmentConsent.accepted,
              acceptedAt: dataTreatmentConsent.acceptedAt || null,
              policyUrl: dataTreatmentConsent.policyUrl || null,
              policyText: dataTreatmentConsent.policyText || null,
            },
            apartmentRulesConsent: {
              accepted: apartmentRulesConsent.accepted,
              acceptedAt: apartmentRulesConsent.acceptedAt || null,
              policyUrl: apartmentRulesConsent.policyUrl || null,
              policyText: apartmentRulesConsent.policyText || null,
            },
            submittedBy: submittedBy || null,
            signature,
            submittedAt: now,
          },
        },
        $unset: {
          'checkIn.invoiceInformation': 1,
          'checkIn.regulation': 1,
        },
      }
    );

    return res.json({
      ok: true,
      alreadyCompleted: false,
      converted: {
        itineraryId: String(itineraryDoc._id),
        itineraryItemId: String(itineraryItem._id),
        accountUserId: requesterId,
      },
    });
  } catch (err) {
    console.error('provider.completeGuestLink error', err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
};
