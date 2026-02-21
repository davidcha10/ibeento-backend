'use strict';

const mongoose = require('mongoose');
const { Service, ServiceAccommodation, ServiceTransport, ServiceExperience } = require('../models/Service');
const Activity = require('../models/Activity');

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

  // Location
  if (countryId && isValidObjectId(countryId)) filter['location.countryId'] = new mongoose.Types.ObjectId(countryId);
  if (regionId && isValidObjectId(regionId)) filter['location.regionId'] = new mongoose.Types.ObjectId(regionId);
  if (cityId && isValidObjectId(cityId)) filter['location.cityId'] = new mongoose.Types.ObjectId(cityId);

  // Price range
  if (typeof minPrice !== 'undefined' || typeof maxPrice !== 'undefined') {
    filter['pricing.basePrice'] = {};
    if (typeof minPrice !== 'undefined') filter['pricing.basePrice'].$gte = Number(minPrice);
    if (typeof maxPrice !== 'undefined') filter['pricing.basePrice'].$lte = Number(maxPrice);
  }

  // Text search (simple, regex; swap for $text if you add text index)
  if (q && String(q).trim().length) {
    const rx = new RegExp(String(q).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ title: rx }, { description: rx }];
  }

  return filter;
}

function buildSort(req) {
  const sort = String(req.query.sort || '-createdAt');
  // examples: '-createdAt', 'title', 'pricing.basePrice'
  const dir = sort.startsWith('-') ? -1 : 1;
  const field = sort.replace(/^[-+]/, '') || 'createdAt';
  return { [field]: dir };
}

function createHttpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
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
  const title = toTrimmedString(body.title);
  const serviceType = toTrimmedString(body.serviceType).toLowerCase();

  if (serviceName && !title) body.title = serviceName;
  if (title && !serviceName) body.serviceName = title;
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

  return body;
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

  if (requiresCompletePayload) {
    const d = Number(body?.duration?.d || 0);
    const h = Number(body?.duration?.h || 0);
    const m = Number(body?.duration?.m || 0);
    const durationMinutes = d * 1440 + h * 60 + m;
    if (!(durationMinutes > 0)) throw createHttpError(400, 'duration must be greater than 0');
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

    if (!serviceType) return res.status(400).json({ error: 'serviceType is required' });
    if (!['accommodation', 'transport', 'experience'].includes(serviceType)) {
      return res.status(400).json({ error: 'serviceType must be one of accommodation|transport|experience' });
    }

    ensureServiceTypeCompatibility(body);
    await ensureValidActivityLink(body.activityId);

    // You can create through base model; discriminator will pick by serviceType
    const created = await Service.create(body);

    res.status(201).json(created);
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

    const body = normalizeServicePayload(req.body || {});
    ensureServiceTypeCompatibility({ ...body, serviceType: body.serviceType || undefined });
    await ensureValidActivityLink(body.activityId);

    const updated = await Service.findByIdAndUpdate(id, body, {
      new: true,
      runValidators: true,
      // strict is true by default; ensures only schema fields are persisted
    });

    if (!updated) return res.status(404).json({ error: 'Service not found' });
    res.json(updated);
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

    const hard = String(req.query.hard || 'false') === 'true';

    if (hard) {
      const deleted = await Service.findByIdAndDelete(id);
      if (!deleted) return res.status(404).json({ error: 'Service not found' });
      return res.json({ ok: true, deleted: deleted._id });
    }

    const updated = await Service.findByIdAndUpdate(
      id,
      { isActive: false },
      { new: true }
    );
    if (!updated) return res.status(404).json({ error: 'Service not found' });
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

    const updated = await Service.findByIdAndUpdate(
      id,
      { isActive: true },
      { new: true }
    );

    if (!updated) return res.status(404).json({ error: 'Service not found' });
    res.json(updated);
  } catch (err) {
    next(err);
  }
};
