const Itinerary = require('../models/Itinerary');
const ItineraryItem = require('../models/ItineraryItem');
const mongoose = require('mongoose');
const { Service } = require('../models/Service');
const Activity = require('../models/Activity');
const ActivityCategory = require('../models/ActivityCategory');

// Utils
const ensureItinerary = async (itineraryId) => {
  const exists = await Itinerary.exists({ _id: itineraryId });
  if (!exists) {
    const e = new Error('Itinerary not found');
    e.status = 404;
    throw e;
  }
};

const snapToMinutes = (isoOrDate, minutes = 15) => {
  if (!isoOrDate) return undefined;
  const d = new Date(isoOrDate);
  const m = d.getUTCMinutes();
  const snapped = Math.round(m / minutes) * minutes;
  d.setUTCMinutes(snapped, 0, 0);
  return d.toISOString();
};

const overlaps = (aStart, aEnd, bStart, bEnd) => {
  const aS = aStart ? +new Date(aStart) : null;
  const aE = aEnd ? +new Date(aEnd) : null;
  const bS = bStart ? +new Date(bStart) : null;
  const bE = bEnd ? +new Date(bEnd) : null;
  if (aS == null || bS == null) return false;
  const aEndEff = aE ?? aS;
  const bEndEff = bE ?? bS;
  return aS < bEndEff && bS < aEndEff;
};

const isValidObjectId = (value) => mongoose.Types.ObjectId.isValid(value);

const createHttpError = (status, message) => {
  const err = new Error(message);
  err.status = status;
  return err;
};

const buildServiceSnapshot = (serviceDoc) => {
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
};

const normalizeGeoPoint = (raw) => {
  // Accept:
  // - { type: 'Point', coordinates: [lng, lat] }
  // - { coordinates: [lng, lat] }  (legacy/incomplete payloads)
  // - [lng, lat]
  const coords = Array.isArray(raw)
    ? raw
    : (Array.isArray(raw?.coordinates) ? raw.coordinates : null);
  if (!coords || coords.length < 2) {
    return undefined;
  }
  const lng = Number(coords[0]);
  const lat = Number(coords[1]);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return undefined;
  return { type: 'Point', coordinates: [lng, lat] };
};

const pickFirstString = (...values) => {
  for (const value of values) {
    const v = String(value || '').trim();
    if (v) return v;
  }
  return undefined;
};

const pickFirstValue = (...values) => {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
};

const sanitizeCustomDataLocation = (customData) => {
  if (!customData || typeof customData !== 'object') return customData;
  const next = { ...customData };
  const toObjectIdOrUndefined = (value) => {
    if (value === undefined || value === null) return undefined;
    const raw = String(value).trim();
    if (!raw) return undefined;
    return isValidObjectId(raw) ? raw : undefined;
  };

  const categoryId = toObjectIdOrUndefined(next.activityCategoryId);
  if (categoryId) next.activityCategoryId = categoryId;
  else delete next.activityCategoryId;
  // customData.location is deprecated. Keep location only at itineraryItem.location.
  delete next.location;
  return next;
};

const buildResolvedItemLocation = ({ payloadLocation, currentLocation, serviceDoc, activityDoc, hasExplicitLocation }) => {
  // Accept legacy payloadLocation.activityGeo for backward compatibility.
  const payloadGeo = normalizeGeoPoint(payloadLocation?.geo) || normalizeGeoPoint(payloadLocation?.activityGeo);

  const geoFromActivity = normalizeGeoPoint(activityDoc?.location?.geo);
  const geoFromService = normalizeGeoPoint(serviceDoc?.location?.geo);
  // Read legacy currentLocation.activityGeo too while old docs exist.
  const geoFromCurrent = normalizeGeoPoint(currentLocation?.geo) || normalizeGeoPoint(currentLocation?.activityGeo);
  const geoFromCustom = normalizeGeoPoint(payloadLocation?.geo);

  // Business rule:
  // - geo should come from activity whenever an activity is linked.
  // - startPoint should only come from service.startingPoint when explicitly provided.
  const geo = activityDoc?._id
    ? geoFromActivity
    : (payloadGeo || geoFromCurrent || geoFromService || geoFromCustom);

  const startPointGeo = normalizeGeoPoint(serviceDoc?.startingPoint?.geo);

  const location = {
    countryId: pickFirstValue(
      payloadLocation?.countryId,
      serviceDoc?.location?.countryId,
      activityDoc?.location?.countryId,
      currentLocation?.countryId
    ),
    regionId: pickFirstValue(
      payloadLocation?.regionId,
      serviceDoc?.location?.regionId,
      activityDoc?.location?.regionId,
      currentLocation?.regionId
    ),
    cityId: pickFirstValue(
      payloadLocation?.cityId,
      serviceDoc?.location?.cityId,
      activityDoc?.location?.cityId,
      currentLocation?.cityId
    ),
    timeZone: pickFirstString(
      payloadLocation?.timeZone,
      serviceDoc?.startingPoint?.timeZone,
      serviceDoc?.location?.timeZone,
      activityDoc?.location?.timeZone,
      currentLocation?.timeZone
    ),
    address: pickFirstString(
      payloadLocation?.address,
      serviceDoc?.location?.address,
      activityDoc?.location?.address,
      currentLocation?.address
    ),
    geo,
    startPointGeo,
    startPointAddress: pickFirstString(serviceDoc?.startingPoint?.address),
  };

  const hasAny =
    !!location.countryId ||
    !!location.regionId ||
    !!location.cityId ||
    !!location.timeZone ||
    !!location.address ||
    !!location.startPointAddress ||
    !!location.geo ||
    !!location.startPointGeo;

  if (!hasAny) {
    if (hasExplicitLocation) return {};
    return undefined;
  }

  return location;
};

const normalizeItemContext = async (payload = {}, currentItem = null) => {
  const normalized = { ...payload };
  normalized.customData = sanitizeCustomDataLocation(normalized.customData);

  const hasExplicitService = Object.prototype.hasOwnProperty.call(payload, 'serviceId');
  const hasExplicitActivity = Object.prototype.hasOwnProperty.call(payload, 'activityId');
  const hasExplicitLocation = Object.prototype.hasOwnProperty.call(payload, 'location');
  const shouldResolveService = hasExplicitService || hasExplicitActivity || !currentItem;

  const serviceIdRaw = hasExplicitService ? payload.serviceId : currentItem?.serviceId;
  const activityIdRaw = hasExplicitActivity ? payload.activityId : currentItem?.activityId;

  let serviceDoc = null;
  let serviceActivityId = null;

  if (shouldResolveService && serviceIdRaw !== undefined && serviceIdRaw !== null && serviceIdRaw !== '') {
    if (!isValidObjectId(serviceIdRaw)) {
      throw createHttpError(400, 'Invalid serviceId');
    }
    serviceDoc = await Service.findById(serviceIdRaw).lean();
    if (!serviceDoc) {
      throw createHttpError(404, 'Service not found');
    }
    serviceActivityId = serviceDoc.activityId ? String(serviceDoc.activityId) : null;
  }

  let normalizedActivityId = null;
  if (hasExplicitActivity && activityIdRaw !== undefined && activityIdRaw !== null && activityIdRaw !== '') {
    if (!isValidObjectId(activityIdRaw)) {
      throw createHttpError(400, 'Invalid activityId');
    }
    normalizedActivityId = String(activityIdRaw);
  }

  if (serviceActivityId) {
    if (hasExplicitActivity && normalizedActivityId && normalizedActivityId !== serviceActivityId) {
      throw createHttpError(400, 'activityId must match service.activityId');
    }
    normalized.activityId = serviceActivityId;
    normalizedActivityId = serviceActivityId;
  }

  let activityDoc = null;
  if (normalizedActivityId) {
    activityDoc = await Activity.findById(normalizedActivityId)
      .select({ location: 1 })
      .lean();
    if (!activityDoc) {
      throw createHttpError(404, 'Activity not found');
    }
  }

  if (serviceDoc && (hasExplicitService || !currentItem)) {
    normalized.booking = {
      ...(currentItem?.booking || {}),
      ...(payload.booking || {}),
      serviceSnapshot: buildServiceSnapshot(serviceDoc),
    };
  }

  const legacyCustomLocation =
    !hasExplicitLocation && payload?.customData?.location && typeof payload.customData.location === 'object'
      ? payload.customData.location
      : {};

  const payloadLocation =
    hasExplicitLocation && payload?.location && typeof payload.location === 'object'
      ? payload.location
      : (!hasExplicitLocation && Object.keys(legacyCustomLocation).length
          ? legacyCustomLocation
          : (!hasExplicitLocation && payload?.activity?.location && typeof payload.activity.location === 'object'
              ? payload.activity.location
              : (!hasExplicitLocation && payload?.service?.location && typeof payload.service.location === 'object'
                  ? payload.service.location
                  : {})));

  const shouldResolveLocation =
    hasExplicitLocation ||
    !!serviceDoc ||
    !!activityDoc ||
    (!currentItem && !!legacyCustomLocation && Object.keys(legacyCustomLocation).length > 0);

  if (shouldResolveLocation) {
    const resolvedLocation = buildResolvedItemLocation({
      payloadLocation,
      currentLocation: currentItem?.location,
      serviceDoc,
      activityDoc,
      hasExplicitLocation,
    });
    if (resolvedLocation !== undefined) {
      normalized.location = resolvedLocation;
    }
  }

  const effectiveServiceId =
    hasExplicitService
      ? normalized.serviceId
      : (currentItem?.serviceId || normalized.serviceId);

  if (!effectiveServiceId) {
    delete normalized.booking;
    delete normalized.payment;
  }

  return normalized;
};

exports.list = async (req, res, next) => {
  try {
    const { itineraryId } = req.params;
    await ensureItinerary(itineraryId);
    const items = await ItineraryItem
      .find({ itineraryId })
      .sort({ timelineStartDate: 1, createdAt: 1 })
      .lean();

    const rawIds = items
      .map((item) => item?.customData?.activityCategoryId)
      .filter(Boolean)
      .map((v) => String(v));

    const objIds = rawIds
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .map((id) => new mongoose.Types.ObjectId(id));

    const slugs = rawIds.map((id) => id.toLowerCase());

    const categories = await ActivityCategory.find({
      $or: [
        objIds.length ? { _id: { $in: objIds } } : null,
        slugs.length ? { slug: { $in: slugs } } : null,
        slugs.length ? { name: { $in: slugs } } : null
      ].filter(Boolean)
    }).lean();

    const byId = new Map(categories.map((c) => [String(c._id), c]));
    const bySlug = new Map(categories.map((c) => [String(c.slug).toLowerCase(), c]));
    const byName = new Map(categories.map((c) => [String(c.name).toLowerCase(), c]));

    const normalized = items.map((item) => {
      const key = item?.customData?.activityCategoryId ? String(item.customData.activityCategoryId) : '';
      const match =
        (key && byId.get(key)) ||
        (key && bySlug.get(key.toLowerCase())) ||
        (key && byName.get(key.toLowerCase())) ||
        null;
      return {
        ...item,
        activityCategory: item.activityCategory || match || null,
      };
    });

    res.json(normalized);
  } catch (err) { next(err); }
};

exports.get = async (req, res, next) => {
  try {
    const { itineraryId, itemId } = req.params;
    await ensureItinerary(itineraryId);
    const item = await ItineraryItem
      .findOne({ _id: itemId, itineraryId })
      .lean();
    if (!item) return res.status(404).json({ error: 'Item not found' });
    const key = item?.customData?.activityCategoryId ? String(item.customData.activityCategoryId) : '';
    let activityCategory = null;
    if (key) {
      if (mongoose.Types.ObjectId.isValid(key)) {
        activityCategory = await ActivityCategory.findById(key).lean();
      } else {
        activityCategory = await ActivityCategory.findOne({ $or: [{ slug: key }, { name: key }] }).lean();
      }
    }
    res.json({
      ...item,
      activityCategory: item.activityCategory || activityCategory || null,
    });
  } catch (err) { next(err); }
};

exports.create = async (req, res, next) => {
  try {
    const { itineraryId } = req.params;
    await ensureItinerary(itineraryId);

    const body = await normalizeItemContext(req.body || {});

    const item = await ItineraryItem.create({
      ...body,
      itineraryId
    });

    res.status(201).json(item);
  } catch (err) { next(err); }
};

exports.update = async (req, res, next) => {
  try {
    const { itineraryId, itemId } = req.params;
    await ensureItinerary(itineraryId);

    const existing = await ItineraryItem.findOne({ _id: itemId, itineraryId }).lean();
    if (!existing) return res.status(404).json({ error: 'Item not found' });

    const body = await normalizeItemContext(req.body || {}, existing);
    const hasExplicitService = Object.prototype.hasOwnProperty.call(req.body || {}, 'serviceId');
    const nextServiceId = hasExplicitService ? body?.serviceId : existing?.serviceId;

    const updateDoc = { $set: body };
    if (!nextServiceId) {
      updateDoc.$unset = { booking: 1, payment: 1 };
    }

    const updated = await ItineraryItem.findOneAndUpdate(
      { _id: itemId, itineraryId },
      updateDoc,
      { new: true }
    );
    res.json(updated);
  } catch (err) { next(err); }
};

exports.remove = async (req, res, next) => {
  try {
    const { itineraryId, itemId } = req.params;
    await ensureItinerary(itineraryId);
    await ItineraryItem.deleteOne({ _id: itemId, itineraryId });
    res.json({ ok: true });
  } catch (err) { next(err); }
};

exports.bulkCreate = async (req, res, next) => {
  try {
    const { itineraryId } = req.params;
    await ensureItinerary(itineraryId);
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: 'items array required' });
    const normalizedItems = [];
    for (const item of items) {
      normalizedItems.push(await normalizeItemContext(item || {}));
    }
    const docs = await ItineraryItem.insertMany(
      normalizedItems.map(x => ({ ...x, itineraryId }))
    );
    res.status(201).json(docs);
  } catch (err) { next(err); }
};

exports.reorder = async (req, res, next) => {
  try {
    const { itineraryId } = req.params;
    const { moves = [], simulateOnly = false, snapMinutes = 15, atomic = false } = req.body || {};

    if (!Array.isArray(moves) || moves.length === 0) {
      return res.status(400).json({ error: 'moves[] required' });
    }

    await ensureItinerary(itineraryId);

    // Cargar todos los items del itinerario (una sola vez)
    const allItems = await ItineraryItem.find({ itineraryId }).lean();
    const allById = new Map(allItems.map(i => [String(i._id), i]));

    const results = [];
    const bulk = [];

    const session = atomic ? await mongoose.startSession() : null;
    if (session) session.startTransaction();

    try {
      for (const mv of moves) {
        const item = allById.get(String(mv.itemId));
        if (!item) {
          results.push({ itemId: mv.itemId, outcome: 'denied', reason: 'not_found' });
          if (atomic) throw new Error('not_found');
          continue;
        }

        const policy = ItineraryItem.deriveMovePolicy(item);
        const targetStart = snapToMinutes(mv.targetStart, snapMinutes);
        const targetEnd   = mv.targetEnd ? snapToMinutes(mv.targetEnd, snapMinutes) : (item.timelineEndDate || null);

        // 1) Reglas duras: no movible
        if (policy === 'hard_fixed') {
          results.push({ itemId: String(item._id), policy, outcome: 'denied', reason: 'hard_fixed' });
          if (atomic) throw new Error('hard_fixed');
          continue;
        }

        // 2) Validar ventana opcional
        if (item.timeWindow?.start || item.timeWindow?.end) {
          const wS = item.timeWindow.start ? +new Date(item.timeWindow.start) : null;
          const wE = item.timeWindow.end ? +new Date(item.timeWindow.end) : null;
          const tS = +new Date(targetStart);
          if ((wS && tS < wS) || (wE && tS > wE)) {
            if (policy === 'soft_request') {
              results.push({ itemId: String(item._id), policy, outcome: 'requested', reason: 'outside_time_window' });
            } else {
              results.push({ itemId: String(item._id), policy, outcome: 'denied', reason: 'outside_time_window' });
              if (atomic) throw new Error('outside_time_window');
            }
            continue;
          }
        }

        // 3) Conflictos con hard_fixed existentes
        const hardFixedItems = allItems.filter(x => {
          if (String(x._id) === String(item._id)) return false;
          const p = ItineraryItem.deriveMovePolicy(x);
          return p === 'hard_fixed';
        });
        const conflict = hardFixedItems.find(x => overlaps(targetStart, targetEnd, x.timelineStartDate, x.timelineEndDate));
        if (conflict) {
          results.push({
            itemId: String(item._id),
            policy,
            outcome: 'denied',
            reason: 'hard_fixed_or_conflict',
            blockingItemId: String(conflict._id)
          });
          if (atomic) throw new Error('conflict');
          continue;
        }

        // 4) Desenlace por policy
        if (policy === 'soft_request') {
          results.push({
            itemId: String(item._id),
            policy,
            outcome: 'requested',
            reason: 'requires_provider_change'
          });
          continue;
        }

        // policy === 'free' → aplicar (si no es simulación)
        if (!simulateOnly) {
          bulk.push({
            updateOne: {
              filter: { _id: item._id, itineraryId },
              update: { $set: { timelineStartDate: targetStart, timelineEndDate: targetEnd } }
            }
          });
          // actualizar en memoria para validaciones posteriores dentro del mismo batch
          item.timelineStartDate = targetStart;
          item.timelineEndDate = targetEnd;
          allById.set(String(item._id), item);
        }

        results.push({
          itemId: String(item._id),
          policy,
          outcome: simulateOnly ? 'simulated' : 'applied',
          newStart: targetStart,
          newEnd: targetEnd
        });
      }

      if (!simulateOnly && bulk.length) {
        await ItineraryItem.bulkWrite(bulk, session ? { session } : {});
      }

      if (session) await session.commitTransaction();

      return res.json({ results });
    } catch (inner) {
      if (session) await session.abortTransaction();
      if (atomic) return res.status(409).json({ error: 'reorder_failed_atomic', details: inner.message, results });
      return res.json({ results }); // resultados parciales si no es atómico
    } finally {
      if (session) session.endSession();
    }
  } catch (err) {
    next(err);
  }
};
