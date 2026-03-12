'use strict';

const mongoose = require('mongoose');
const { Service, ServiceAccommodation, ServiceTransport, ServiceExperience } = require('../models/Service');
const Activity = require('../models/Activity');
const ProviderProfile = require('../models/Provider');
const BusinessUnit = require('../models/BusinessUnit');
const { markOrphanActivityAfterRelink } = require('../services/activity-orphan-cleanup.service');

// ----------------------------- Helpers -----------------------------
const isValidObjectId = (v) => mongoose.Types.ObjectId.isValid(v);

function parsePagination(req) {
  const page = Math.max(parseInt(req.query.page ?? '1', 10), 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit ?? '20', 10), 1), 100);
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

function buildFilters(req) {
  const {
    q,
    serviceType, // 'accommodation|transport|experience'
    isActive,
    providerId,
    category,
    subCategory,
    zoneId,
    primaryZoneId,
    countryId,
    regionId,
    cityId,
    activityId,
    minPrice,
    maxPrice,
  } = req.query;

  const filter = {};

  // Active flag
  if (typeof isActive !== 'undefined') {
    filter.isActive = isActive === 'true' || isActive === true;
  } else {
    // Include docs where isActive is true OR not set (avoids filtering out legacy data)
    filter.isActive = { $ne: false };
  }

  // Service type(s)
  if (serviceType) {
    const types = String(serviceType)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (types.length) filter.serviceType = { $in: types };
  }

  if (providerId && isValidObjectId(providerId)) filter.providerId = new mongoose.Types.ObjectId(providerId);
  if (activityId && isValidObjectId(activityId)) filter.activityId = new mongoose.Types.ObjectId(activityId);
  if (category && isValidObjectId(category)) filter.category = new mongoose.Types.ObjectId(category);
  if (subCategory && isValidObjectId(subCategory)) filter.subCategory = new mongoose.Types.ObjectId(subCategory);

  // Location (zone-first model, with legacy compatibility).
  const locationConditions = [];
  const addZoneScopedCondition = (id, legacyFields = []) => {
    if (!id || !isValidObjectId(id)) return;
    const objectId = new mongoose.Types.ObjectId(id);
    const or = [
      { 'location.primaryZoneId': objectId },
      { 'location.zonePathIds': objectId },
      ...legacyFields.map((field) => ({ [field]: objectId })),
    ];
    locationConditions.push({ $or: or });
  };

  if (primaryZoneId && isValidObjectId(primaryZoneId)) {
    locationConditions.push({ 'location.primaryZoneId': new mongoose.Types.ObjectId(primaryZoneId) });
  }
  if (zoneId) {
    addZoneScopedCondition(zoneId, ['location.cityId', 'location.regionId', 'location.countryId']);
  }
  if (cityId) {
    addZoneScopedCondition(cityId, ['location.cityId']);
  }
  if (regionId) {
    addZoneScopedCondition(regionId, ['location.regionId']);
  }
  if (countryId) {
    addZoneScopedCondition(countryId, ['location.countryId']);
  }
  if (locationConditions.length) {
    const existingAnd = Array.isArray(filter.$and) ? filter.$and : [];
    filter.$and = [...existingAnd, ...locationConditions];
  }

  // Price range
  if (typeof minPrice !== 'undefined' || typeof maxPrice !== 'undefined') {
    filter['pricing.basePrice'] = {};
    if (typeof minPrice !== 'undefined') filter['pricing.basePrice'].$gte = Number(minPrice);
    if (typeof maxPrice !== 'undefined') filter['pricing.basePrice'].$lte = Number(maxPrice);
  }

  // Text search (simple, regex; swap for $text if you add text index)
  if (q && String(q).trim().length) {
    const rx = new RegExp(String(q).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ serviceName: rx }, { internalName: rx }, { description: rx }];
  }

  return filter;
}

function buildSort(req) {
  const sort = String(req.query.sort || '-createdAt');
  // examples: '-createdAt', 'serviceName', 'pricing.basePrice'
  const dir = sort.startsWith('-') ? -1 : 1;
  const field = sort.replace(/^[-+]/, '') || 'createdAt';
  return { [field]: dir };
}

function createHttpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function isAdminUser(reqUser) {
  return String(reqUser?.role || '').trim().toLowerCase() === 'admin';
}

async function ensureProviderOwnershipOrAdmin(providerId, reqUser) {
  if (!isValidObjectId(providerId)) {
    throw createHttpError(400, 'Invalid providerId');
  }

  const provider = await ProviderProfile.findById(providerId).select('_id userId').lean();
  if (!provider?._id) {
    throw createHttpError(404, 'Provider not found');
  }

  if (isAdminUser(reqUser)) {
    return provider;
  }

  const requesterId = String(reqUser?._id || reqUser?.id || '').trim();
  const ownerId = String(provider.userId || '').trim();
  if (!requesterId || requesterId !== ownerId) {
    throw createHttpError(403, 'Forbidden provider access');
  }

  return provider;
}

async function ensureValidActivityLink(rawActivityId) {
  if (typeof rawActivityId === 'undefined') return;
  if (rawActivityId === null || rawActivityId === '') return;
  if (!isValidObjectId(rawActivityId)) {
    throw createHttpError(400, 'Invalid activityId');
  }
  const exists = await Activity.exists({ _id: rawActivityId });
  if (!exists) {
    throw createHttpError(404, 'Activity not found');
  }
}

function normalizeGeoPoint(raw) {
  if (!raw || raw.type !== 'Point' || !Array.isArray(raw.coordinates) || raw.coordinates.length < 2) {
    return undefined;
  }
  const lng = Number(raw.coordinates[0]);
  const lat = Number(raw.coordinates[1]);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return undefined;
  return { type: 'Point', coordinates: [lng, lat] };
}

function toTrimmedString(value) {
  return String(value || '').trim();
}

function normalizeServicePayload(rawBody = {}) {
  const body = { ...(rawBody || {}) };
  const serviceName = toTrimmedString(body.serviceName);
  const legacyTitle = toTrimmedString(body.title);
  const serviceType = toTrimmedString(body.serviceType).toLowerCase();

  // Backward compatibility for old payloads that still send "title".
  if (!serviceName && legacyTitle) body.serviceName = legacyTitle;
  if (Object.prototype.hasOwnProperty.call(body, 'title')) {
    delete body.title;
  }
  if (serviceType) body.serviceType = serviceType;

  const location = (body.location && typeof body.location === 'object') ? { ...body.location } : undefined;
  if (location) {
    const geo = normalizeGeoPoint(location.geo);
    if (geo) location.geo = geo;
    else delete location.geo;
    body.location = location;
  }

  const startingPoint = (body.startingPoint && typeof body.startingPoint === 'object')
    ? { ...body.startingPoint }
    : undefined;
  if (startingPoint) {
    const geo = normalizeGeoPoint(startingPoint.geo);
    if (geo) startingPoint.geo = geo;
    else delete startingPoint.geo;
    body.startingPoint = startingPoint;
  }

  // Backward compatibility: move privacyIds from accommodation scope to root scope.
  if (typeof body.privacyIds === 'undefined' && Array.isArray(body?.accommodation?.privacyIds)) {
    body.privacyIds = body.accommodation.privacyIds;
  }
  if (body?.accommodation && Object.prototype.hasOwnProperty.call(body.accommodation, 'privacyIds')) {
    const acc = { ...body.accommodation };
    delete acc.privacyIds;
    body.accommodation = acc;
  }
  if (typeof body.privacyIds === 'undefined' && Array.isArray(body['accommodation.privacyIds'])) {
    body.privacyIds = body['accommodation.privacyIds'];
  }
  if (Object.prototype.hasOwnProperty.call(body, 'accommodation.privacyIds')) {
    delete body['accommodation.privacyIds'];
  }

  return body;
}

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function deepMergeObjects(target, source) {
  const out = isPlainObject(target) ? { ...target } : {};
  if (!isPlainObject(source)) return out;

  for (const [key, value] of Object.entries(source)) {
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMergeObjects(out[key], value);
      continue;
    }
    if (isPlainObject(value)) {
      out[key] = deepMergeObjects({}, value);
      continue;
    }
    out[key] = value;
  }

  return out;
}

function setByDottedPath(target, dottedPath, value) {
  const path = String(dottedPath || '').trim();
  if (!path) return;
  const parts = path.split('.').filter(Boolean);
  if (!parts.length) return;

  let cursor = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    if (!isPlainObject(cursor[key])) cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[parts[parts.length - 1]] = value;
}

function buildValidationCandidate(existingDoc = {}, patchDoc = {}) {
  const existing = isPlainObject(existingDoc)
    ? JSON.parse(JSON.stringify(existingDoc))
    : {};

  const nestedPatch = {};
  for (const [key, value] of Object.entries(patchDoc || {})) {
    if (String(key).includes('.')) {
      setByDottedPath(nestedPatch, key, value);
      continue;
    }
    nestedPatch[key] = value;
  }

  return deepMergeObjects(existing, nestedPatch);
}

function ensureServiceTypeCompatibility(body = {}) {
  const serviceType = toTrimmedString(body.serviceType).toLowerCase();
  if (!serviceType) return;

  const status = toTrimmedString(body.status || '').toLowerCase() || 'active';
  const requiresCompletePayload = status !== 'draft';

  const requirePositive = (value, fieldName) => {
    if (!requiresCompletePayload) return;
    if (!(Number(value) > 0)) throw createHttpError(400, `${fieldName} is required and must be > 0`);
  };

  const requireNonNegative = (value, fieldName) => {
    if (!requiresCompletePayload) return;
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) {
      throw createHttpError(400, `${fieldName} is required and must be >= 0`);
    }
  };

  const requireString = (value, fieldName) => {
    if (!requiresCompletePayload) return;
    if (!toTrimmedString(value)) throw createHttpError(400, `${fieldName} is required`);
  };

  const requireTime = (value, fieldName) => {
    if (!requiresCompletePayload) return;
    const raw = toTrimmedString(value);
    if (!raw) throw createHttpError(400, `${fieldName} is required`);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(raw)) throw createHttpError(400, `${fieldName} must be HH:mm`);
  };

  // Common required fields (for publish-ready docs)
  requirePositive(body?.pricing?.basePrice, 'pricing.basePrice');
  requireString(body?.pricing?.currency, 'pricing.currency');
  requireString(body?.pricing?.per, 'pricing.per');

  if (requiresCompletePayload && serviceType !== 'accommodation') {
    const d = Number(body?.duration?.d || 0);
    const h = Number(body?.duration?.h || 0);
    const m = Number(body?.duration?.m || 0);
    const durationMinutes = d * 1440 + h * 60 + m;
    if (!(durationMinutes > 0)) throw createHttpError(400, 'duration must be greater than 0');
    requireNonNegative(body?.waitTime, 'waitTime');
    requireString(body?.availabilityWindow, 'availabilityWindow');
  }

  if (serviceType === 'experience') {
    requireString(body.activityId, 'activityId');
    requirePositive(body?.experience?.groupSize, 'experience.groupSize');
    requirePositive(body?.experience?.minParticipants, 'experience.minParticipants');
    requireTime(body?.timeWindow?.start, 'timeWindow.start');
    requireTime(body?.timeWindow?.end, 'timeWindow.end');
  }

  if (serviceType === 'transport') {
    requireString(body?.transport?.vehicleType, 'transport.vehicleType');
    requirePositive(body?.transport?.capacity, 'transport.capacity');
    requirePositive(body?.allowedGroupSize?.min, 'allowedGroupSize.min');
    requirePositive(body?.allowedGroupSize?.max, 'allowedGroupSize.max');
    requireTime(body?.timeWindow?.start, 'timeWindow.start');
    requireTime(body?.timeWindow?.end, 'timeWindow.end');
  }

  if (serviceType === 'accommodation') {
    requirePositive(body?.accommodation?.maxGuests, 'accommodation.maxGuests');
    requirePositive(body?.accommodation?.roomsNumber, 'accommodation.roomsNumber');
    requireString(body?.accommodation?.checkIn, 'accommodation.checkIn');
    requireString(body?.accommodation?.checkOut, 'accommodation.checkOut');
    requirePositive(body?.accommodation?.minNights, 'accommodation.minNights');
    requirePositive(body?.accommodation?.maxNights, 'accommodation.maxNights');
    requireString(body?.accommodation?.noticePeriod, 'accommodation.noticePeriod');
    requireString(body?.accommodation?.availabilityWindow, 'accommodation.availabilityWindow');
  }
}

function parseTimeToMinutes(rawValue) {
  const raw = toTrimmedString(rawValue);
  const match = raw.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours * 60 + minutes;
}

function durationToMinutes(duration = null) {
  const d = Number(duration?.d || 0);
  const h = Number(duration?.h || 0);
  const m = Number(duration?.m || 0);
  return d * 1440 + h * 60 + m;
}

function inferAccommodationDuration(checkIn, checkOut) {
  const checkInMinutes = parseTimeToMinutes(checkIn);
  const checkOutMinutes = parseTimeToMinutes(checkOut);
  if (!Number.isFinite(checkInMinutes) || !Number.isFinite(checkOutMinutes)) return null;

  // If check-out is earlier than or equal to check-in, assume next day.
  let diffMinutes = checkOutMinutes - checkInMinutes;
  if (diffMinutes <= 0) diffMinutes += 24 * 60;

  const d = Math.floor(diffMinutes / 1440);
  const remainder = diffMinutes % 1440;
  const h = Math.floor(remainder / 60);
  const m = remainder % 60;
  return { d, h, m };
}

function applyInferredAccommodationDuration(body = {}) {
  if (toTrimmedString(body?.serviceType).toLowerCase() !== 'accommodation') return;
  if (durationToMinutes(body?.duration) > 0) return;

  const inferred = inferAccommodationDuration(
    body?.accommodation?.checkIn,
    body?.accommodation?.checkOut
  );
  if (!inferred) return;
  body.duration = inferred;
}

function deriveActivityDefaultDurationFromAccommodation(service = {}) {
  const inferred = inferAccommodationDuration(
    service?.accommodation?.checkIn,
    service?.accommodation?.checkOut
  );
  const minutes = durationToMinutes(inferred);
  if (!(minutes > 0)) return undefined;
  return {
    minMinutes: minutes,
    maxMinutes: minutes,
    source: 'provider',
  };
}

function deriveActivityDefaultDurationFromService(service = {}) {
  const serviceType = toTrimmedString(service?.serviceType).toLowerCase();
  if (serviceType === 'accommodation') {
    return deriveActivityDefaultDurationFromAccommodation(service);
  }
  const minutes = durationToMinutes(service?.duration);
  if (!(minutes > 0)) return undefined;
  return {
    minMinutes: minutes,
    maxMinutes: minutes,
    source: 'provider',
  };
}

function slugify(input = '') {
  const normalized = String(input || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (normalized) return normalized;
  return `service-${Date.now()}`;
}

async function ensureUniqueActivitySlug(baseSlug) {
  const root = slugify(baseSlug || '');
  let candidate = root;
  let attempt = 2;
  while (await Activity.exists({ slug: candidate })) {
    candidate = `${root}-${attempt}`;
    attempt += 1;
  }
  return candidate;
}

function toObjectIdOrNull(raw) {
  const value = raw && typeof raw === 'object' ? (raw._id || raw.id || raw) : raw;
  const normalized = toTrimmedString(value);
  if (!normalized || !isValidObjectId(normalized)) return null;
  return new mongoose.Types.ObjectId(normalized);
}

function buildActivityLocationFromService(service = {}) {
  const serviceLocation = service?.location || {};
  const geo = normalizeGeoPoint(serviceLocation?.geo);
  if (!geo) return null;

  const primaryZoneId =
    toObjectIdOrNull(serviceLocation?.primaryZoneId) ||
    toObjectIdOrNull(Array.isArray(serviceLocation?.zonePathIds) ? serviceLocation.zonePathIds[0] : null);

  const zonePathIds = Array.isArray(serviceLocation?.zonePathIds)
    ? serviceLocation.zonePathIds
        .map((item) => toObjectIdOrNull(item))
        .filter(Boolean)
    : [];

  const dedupedZonePathIds = Array.from(
    new Map(zonePathIds.map((id) => [String(id), id])).values()
  );

  if (primaryZoneId && !dedupedZonePathIds.some((id) => String(id) === String(primaryZoneId))) {
    dedupedZonePathIds.unshift(primaryZoneId);
  }

  return {
    primaryZoneId: primaryZoneId || undefined,
    zonePathIds: dedupedZonePathIds.length ? dedupedZonePathIds : undefined,
    timeZone: toTrimmedString(serviceLocation?.timeZone) || undefined,
    address: toTrimmedString(serviceLocation?.address) || undefined,
    addresses: toTrimmedString(serviceLocation?.address)
      ? { es: toTrimmedString(serviceLocation?.address) }
      : {},
    addressSource: 'manual',
    geo,
    geoSource: 'manual',
    geoConfidence: 'high',
  };
}

function mapPricingModelFromService(service = {}) {
  const per = toTrimmedString(service?.pricing?.per).toLowerCase();
  if (per === 'person') return 'per_person';
  if (per === 'group') return 'per_group';
  if (per === 'night') return 'per_night';
  return 'unknown';
}

function normalizeActivityMediaFromService(service = {}) {
  const rawMedia = Array.isArray(service?.media) ? service.media : [];
  const images = rawMedia
    .map((item, index) => {
      const url = toTrimmedString(item?.url);
      if (!url) return null;
      const type = toTrimmedString(item?.type).toLowerCase();
      return {
        url,
        type: type === 'video' || type === 'other' ? type : 'image',
        caption: toTrimmedString(item?.caption) || undefined,
        order: Number.isFinite(Number(item?.order)) ? Number(item.order) : index,
      };
    })
    .filter(Boolean)
    .sort((a, b) => Number(a.order || 0) - Number(b.order || 0));

  return {
    cover: images[0]?.url || undefined,
    images,
  };
}

function resolveBusinessUnitObjectIdFromService(service = {}) {
  const rawBusinessUnitId =
    service?.BusinessUnitId && typeof service.BusinessUnitId === 'object'
      ? (service.BusinessUnitId._id || service.BusinessUnitId.id || service.BusinessUnitId)
      : (service?.BusinessUnitId || service?.businessUnitId);
  return toObjectIdOrNull(rawBusinessUnitId);
}

function normalizeActivityTypeFromBusinessType(rawBusinessType) {
  const value = toTrimmedString(rawBusinessType).toLowerCase();
  if (!value) return null;
  if (
    value === 'accommodation' ||
    value === 'experience' ||
    value === 'food_drinks' ||
    value === 'transport' ||
    value === 'practical_services'
  ) {
    return value;
  }
  return null;
}

async function resolveActivityTypeForService(serviceDoc = {}) {
  const inlineBusinessType =
    serviceDoc?.BusinessUnitId && typeof serviceDoc.BusinessUnitId === 'object'
      ? serviceDoc.BusinessUnitId.businessType
      : undefined;
  const normalizedInline = normalizeActivityTypeFromBusinessType(inlineBusinessType);
  if (normalizedInline) return normalizedInline;

  const businessUnitId = resolveBusinessUnitObjectIdFromService(serviceDoc);
  if (businessUnitId) {
    const businessUnit = await BusinessUnit.findById(businessUnitId).select('businessType').lean();
    const normalizedFromBusiness = normalizeActivityTypeFromBusinessType(businessUnit?.businessType);
    if (normalizedFromBusiness) return normalizedFromBusiness;
  }

  const fallbackByServiceType = normalizeActivityTypeFromBusinessType(serviceDoc?.serviceType);
  if (fallbackByServiceType) return fallbackByServiceType;

  return 'accommodation';
}

function shouldAutoCreateServiceActivity(service = {}) {
  const serviceType = toTrimmedString(service?.serviceType).toLowerCase();
  if (!['accommodation', 'experience', 'transport'].includes(serviceType)) return false;
  if (toTrimmedString(service?.activityId)) return false;
  return true;
}

async function autoLinkServiceActivity(serviceDoc) {
  if (!serviceDoc?._id || !shouldAutoCreateServiceActivity(serviceDoc)) {
    return serviceDoc;
  }

  const serviceId = String(serviceDoc._id);
  const externalId = `manual:service:${serviceId}`;
  const derivedDefaultDurationMin = deriveActivityDefaultDurationFromService(serviceDoc);
  const businessUnitId = resolveBusinessUnitObjectIdFromService(serviceDoc);
  const serviceObjectId = toObjectIdOrNull(serviceDoc?._id);
  const existingByExternalRef = await Activity.findOne({
    'externalRef.provider': 'manual',
    'externalRef.id': externalId,
  })
    .select('_id')
    .lean();

  let activityId = existingByExternalRef?._id || null;
  const activityType = await resolveActivityTypeForService(serviceDoc);

  if (!activityId) {
    const location = buildActivityLocationFromService(serviceDoc);
    if (!location?.geo?.coordinates?.length) {
      console.warn('[Service] Skipping auto activity creation: service has no valid geo location', {
        serviceId,
      });
      return serviceDoc;
    }

    const baseName =
      toTrimmedString(serviceDoc?.serviceName) ||
      toTrimmedString(serviceDoc?.internalName) ||
      `Service ${serviceId.slice(-6)}`;

    const payload = {
      name: baseName,
      slug: await ensureUniqueActivitySlug(baseName),
      description: toTrimmedString(serviceDoc?.description) || undefined,
      type: activityType,
      activityCategoryIds: [],
      tags: [],
      defaultDurationMin: derivedDefaultDurationMin || undefined,
      active: serviceDoc?.isActive !== false,
      location,
      pricing: {
        currency: toTrimmedString(serviceDoc?.pricing?.currency) || undefined,
        priceFrom: Number.isFinite(Number(serviceDoc?.pricing?.basePrice))
          ? Number(serviceDoc.pricing.basePrice)
          : undefined,
        pricingModel: mapPricingModelFromService(serviceDoc),
        source: 'provider',
      },
      media: normalizeActivityMediaFromService(serviceDoc),
      purchaseHint: {
        requiresTicket: true,
      },
      ownership: {
        mode: businessUnitId ? 'business_unit' : 'global',
        businessUnitId: businessUnitId || null,
        createdFromServiceId: serviceObjectId || null,
      },
      externalRef: {
        provider: 'manual',
        id: externalId,
      },
    };

    try {
      const createdActivity = await Activity.create(payload);
      activityId = createdActivity?._id || null;
    } catch (error) {
      if (error?.code === 11000) {
        const duplicate = await Activity.findOne({
          'externalRef.provider': 'manual',
          'externalRef.id': externalId,
        })
          .select('_id')
          .lean();
        activityId = duplicate?._id || null;
      } else {
        throw error;
      }
    }
  }

  if (!activityId) return serviceDoc;

    const activityPatch = {
    ...(derivedDefaultDurationMin ? { defaultDurationMin: derivedDefaultDurationMin } : {}),
    purchaseHint: { requiresTicket: true },
    ownership: {
      mode: businessUnitId ? 'business_unit' : 'global',
      businessUnitId: businessUnitId || null,
      createdFromServiceId: serviceObjectId || null,
    },
  };
  await Activity.findByIdAndUpdate(activityId, activityPatch);

  const updatedService = await Service.findByIdAndUpdate(
    serviceDoc._id,
    { activityId },
    { new: true }
  );

  return updatedService || serviceDoc;
}

// ----------------------------- Controllers -----------------------------

/**
 * GET /api/services
 * List with filters + pagination
 */
exports.list = async (req, res, next) => {
  try {
    const { page, limit, skip } = parsePagination(req);
    const filter = buildFilters(req);
    const sort = buildSort(req);

    // Optional projection (comma-separated fields)
    const fieldsParam = req.query.fields
      ? String(req.query.fields).split(',').map((s) => s.trim()).filter(Boolean)
      : null;

    const pipeline = [
      { $match: filter },
      { $sort: sort },
      { $skip: skip },
      { $limit: limit },
      // --- serviceCategory lookup (new) ---
      {
        $lookup: {
          from: 'servicecategories',
          let: { scid: '$serviceCategoryId' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $eq: [
                    '$_id',
                    {
                      $cond: [
                        { $eq: [{ $type: '$$scid' }, 'string'] },
                        { $toObjectId: '$$scid' },
                        '$$scid'
                      ]
                    }
                  ]
                }
              }
            }
          ],
          as: 'sc'
        }
      },
      // Collapse to single serviceCategory object
      {
        $addFields: {
          serviceCategory: {
            $cond: [
              { $gt: [{ $size: '$sc' }, 0] },
              { $arrayElemAt: ['$sc', 0] },
              null
            ]
          }
        }
      },
      // --- category lookup (supports categoryId or category) ---
      {
        $lookup: {
          from: 'categories',
          let: { cid: { $ifNull: ['$categoryId', '$category'] } },
          pipeline: [
            {
              $match: {
                $expr: {
                  $eq: [
                    '$_id',
                    {
                      $cond: [
                        { $eq: [{ $type: '$$cid' }, 'string'] },
                        { $toObjectId: '$$cid' },
                        '$$cid'
                      ]
                    }
                  ]
                }
              }
            }
          ],
          as: 'cat'
        }
      },
      // --- subcategory lookup (supports subcategoryId or subCategory) ---
      {
        $lookup: {
          from: 'subcategories',
          let: { scid: { $ifNull: ['$subcategoryId', '$subCategory'] } },
          pipeline: [
            {
              $match: {
                $expr: {
                  $eq: [
                    '$_id',
                    {
                      $cond: [
                        { $eq: [{ $type: '$$scid' }, 'string'] },
                        { $toObjectId: '$$scid' },
                        '$$scid'
                      ]
                    }
                  ]
                }
              }
            }
          ],
          as: 'subcat'
        }
      },
      // Collapse to single objects
      {
        $addFields: {
          category: {
            $cond: [
              { $gt: [{ $size: '$cat' }, 0] },
              { $arrayElemAt: ['$cat', 0] },
              null
            ]
          },
          subcategory: {
            $cond: [
              { $gt: [{ $size: '$subcat' }, 0] },
              { $arrayElemAt: ['$subcat', 0] },
              null
            ]
          }
        }
      },
      { $project: { cat: 0, subcat: 0, sc: 0 } }
    ];

    // If client requested fields, apply a projection that always keeps _id, category, subcategory
    if (fieldsParam && fieldsParam.length) {
      const proj = { _id: 1, category: 1, subcategory: 1 };
      for (const f of fieldsParam) proj[f] = 1;
      pipeline.push({ $project: proj });
    }

    const [items, total] = await Promise.all([
      Service.aggregate(pipeline),
      Service.countDocuments(filter),
    ]);

    res.json({ items, total, page, pageSize: limit, pages: Math.ceil(total / limit) });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/services/activity/:activityId
 * List services attached to one activity
 */
exports.listByActivity = async (req, res, next) => {
  try {
    const activityId = req.params.activityId || req.params.id;
    if (!isValidObjectId(activityId)) {
      return res.status(400).json({ error: 'Invalid activity id' });
    }

    const reqForList = Object.create(req);
    Object.defineProperty(reqForList, 'query', {
      value: { ...(req.query || {}), activityId },
      writable: true,
      configurable: true,
      enumerable: true,
    });

    return exports.list(reqForList, res, next);
  } catch (err) {
    return next(err);
  }
};

/**
 * POST /api/activities/:id/services
 * Create a service already linked to an activity
 */
exports.createForActivity = async (req, res, next) => {
  req.body = { ...(req.body || {}), activityId: req.params.id };
  return exports.create(req, res, next);
};

/**
 * GET /api/services/:id
 */
exports.get = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return res.status(400).json({ error: 'Invalid service id' });

    const doc = await Service.findById(id);
    if (!doc) return res.status(404).json({ error: 'Service not found' });
    res.json(doc);
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/services
 * Creates a service using discriminators based on body.serviceType
 */
exports.create = async (req, res, next) => {
  try {
    const body = normalizeServicePayload(req.body || {});
    const { serviceType } = body;
    applyInferredAccommodationDuration(body);

    if (!body.providerId) {
      return res.status(400).json({ error: 'providerId is required' });
    }

    if (!serviceType) return res.status(400).json({ error: 'serviceType is required' });
    if (!['accommodation', 'transport', 'experience'].includes(serviceType)) {
      return res.status(400).json({ error: 'serviceType must be one of accommodation|transport|experience' });
    }

    await ensureProviderOwnershipOrAdmin(body.providerId, req.user);
    ensureServiceTypeCompatibility(body);
    await ensureValidActivityLink(body.activityId);

    // You can create through base model; discriminator will pick by serviceType
    const created = await Service.create(body);
    const withActivityLink = await autoLinkServiceActivity(created);
    try {
      await markOrphanActivityAfterRelink({
        previousActivityId: null,
        nextActivityId: withActivityLink?.activityId,
        serviceId: withActivityLink?._id || created?._id,
      });
    } catch (err) {
      console.error('[Service] post-create orphan cleanup sync failed:', err?.message || err);
    }

    res.status(201).json(withActivityLink);
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH /api/services/:id
 * Partial update with validation
 */
exports.update = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return res.status(400).json({ error: 'Invalid service id' });

    const existing = await Service.findById(id).lean();
    if (!existing?._id) return res.status(404).json({ error: 'Service not found' });
    const previousActivityId = toTrimmedString(existing?.activityId);
    await ensureProviderOwnershipOrAdmin(existing.providerId, req.user);

    const body = normalizeServicePayload(req.body || {});
    if (body.providerId) {
      await ensureProviderOwnershipOrAdmin(body.providerId, req.user);
    }
    const effectiveServiceType = toTrimmedString(body.serviceType || existing.serviceType).toLowerCase();
    const validationCandidate = buildValidationCandidate(existing, body);
    applyInferredAccommodationDuration(validationCandidate);
    if (
      effectiveServiceType === 'accommodation' &&
      durationToMinutes(body?.duration) <= 0 &&
      durationToMinutes(validationCandidate?.duration) > 0
    ) {
      body.duration = validationCandidate.duration;
    }
    ensureServiceTypeCompatibility({
      ...validationCandidate,
      serviceType: effectiveServiceType || undefined,
    });
    await ensureValidActivityLink(body.activityId);

    const modelByServiceType = {
      accommodation: ServiceAccommodation,
      transport: ServiceTransport,
      experience: ServiceExperience,
    };
    const updateModel = modelByServiceType[effectiveServiceType] || Service;

    const hasDottedPathKeys = Object.keys(body || {}).some((key) => String(key).includes('.'));
    const updateDoc = hasDottedPathKeys ? { $set: body } : body;

    const updated = await updateModel.findByIdAndUpdate(id, updateDoc, {
      new: true,
      runValidators: true,
      // strict is true by default; ensures only schema fields are persisted
    });

    const withActivityLink = await autoLinkServiceActivity(updated);
    try {
      await markOrphanActivityAfterRelink({
        previousActivityId,
        nextActivityId: withActivityLink?.activityId,
        serviceId: withActivityLink?._id || id,
      });
    } catch (err) {
      console.error('[Service] post-update orphan cleanup sync failed:', err?.message || err);
    }
    res.json(withActivityLink);
  } catch (err) {
    next(err);
  }
};

/**
 * DELETE /api/services/:id
 * Soft-delete by default (isActive=false). Hard delete with ?hard=true
 */
exports.remove = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return res.status(400).json({ error: 'Invalid service id' });

    const existing = await Service.findById(id).select('_id providerId').lean();
    if (!existing?._id) return res.status(404).json({ error: 'Service not found' });
    await ensureProviderOwnershipOrAdmin(existing.providerId, req.user);

    const hard = String(req.query.hard || 'false') === 'true';

    if (hard) {
      const deleted = await Service.findByIdAndDelete(id);
      return res.json({ ok: true, deleted: deleted._id });
    }

    const updated = await Service.findByIdAndUpdate(
      id,
      { isActive: false },
      { new: true }
    );
    res.json({ ok: true, id: updated._id, isActive: updated.isActive });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/services/:id/restore
 * Restore a soft-deleted service (isActive=true)
 */
exports.restore = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return res.status(400).json({ error: 'Invalid service id' });

    const existing = await Service.findById(id).select('_id providerId').lean();
    if (!existing?._id) return res.status(404).json({ error: 'Service not found' });
    await ensureProviderOwnershipOrAdmin(existing.providerId, req.user);

    const updated = await Service.findByIdAndUpdate(
      id,
      { isActive: true },
      { new: true }
    );

    res.json(updated);
  } catch (err) {
    next(err);
  }
};
