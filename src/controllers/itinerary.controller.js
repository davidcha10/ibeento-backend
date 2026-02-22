const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const Itinerary = require('../models/Itinerary');           // asumiendo que ya existe
const ItineraryItem = require('../models/ItineraryItem');   // ya lo venimos usando
const User = require('../models/User');
const Zone = require('../models/Zone');
const { sendTemplatedEmail } = require('../services/email.service');
const { buildWebAppUrl } = require('../utils/web-app-url');
const isValidObjectId = (v) => mongoose.Types.ObjectId.isValid(v);
const MAX_FREE_DESTINATIONS = 2;
const SHARE_ROLE_SET = new Set(['viewer', 'editor']);
const INVITE_LINK_TTL_DAYS = Math.max(1, Number(process.env.ITINERARY_INVITE_LINK_TTL_DAYS || 30));
const INVITE_LINK_SECRET = String(process.env.ITINERARY_INVITE_LINK_SECRET || process.env.JWT_ACCESS_SECRET || '').trim();

// Helpers
const toInt = (v, d) => (isNaN(parseInt(v,10)) ? d : parseInt(v,10));
const asDate = (iso) => (iso ? new Date(iso) : undefined);

function normalizeDateOnlyInput(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;

  const raw = String(value).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return undefined;
    return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  }

  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

function userIdFromReq(req, fallbackBodyUserId = null) {
  return (req.user && (req.user._id || req.user.id)) || fallbackBodyUserId || null;
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function toObjectIdString(value) {
  if (!value) return '';
  const v = String(value).trim();
  return isValidObjectId(v) ? v : '';
}

function getCollaboratorForUser(itinerary, reqUser) {
  if (!itinerary || !reqUser) return null;
  const userId = toObjectIdString(reqUser._id || reqUser.id);
  const email = normalizeEmail(reqUser.email);
  const collaborators = Array.isArray(itinerary.sharedWith) ? itinerary.sharedWith : [];
  return collaborators.find((entry) => {
    const entryUserId = toObjectIdString(entry?.userId);
    const entryEmail = normalizeEmail(entry?.email);
    const status = String(entry?.status || '').toLowerCase();
    if (status !== 'accepted' && status !== 'invited') return false;
    if (userId && entryUserId && entryUserId === userId) return true;
    if (email && entryEmail && entryEmail === email) return true;
    return false;
  }) || null;
}

function canReadItinerary(itinerary, reqUser) {
  if (!itinerary) return false;
  const requesterId = toObjectIdString(reqUser?._id || reqUser?.id);
  if (requesterId && toObjectIdString(itinerary.userId) === requesterId) return true;
  const collab = getCollaboratorForUser(itinerary, reqUser);
  return !!collab;
}

function canEditItinerary(itinerary, reqUser) {
  if (!itinerary) return false;
  const requesterId = toObjectIdString(reqUser?._id || reqUser?.id);
  if (requesterId && toObjectIdString(itinerary.userId) === requesterId) return true;
  const collab = getCollaboratorForUser(itinerary, reqUser);
  if (!collab) return false;
  if (String(collab.status || '').toLowerCase() !== 'accepted') return false;
  return String(collab.role || 'viewer').toLowerCase() === 'editor';
}

function isOwner(itinerary, reqUser) {
  if (!itinerary || !reqUser) return false;
  const requesterId = toObjectIdString(reqUser._id || reqUser.id);
  return !!requesterId && toObjectIdString(itinerary.userId) === requesterId;
}

function signInviteLinkToken(payload) {
  if (!INVITE_LINK_SECRET) throw new Error('Missing invite link secret');
  return jwt.sign(payload, INVITE_LINK_SECRET, { expiresIn: `${INVITE_LINK_TTL_DAYS}d` });
}

function verifyInviteLinkToken(token) {
  if (!INVITE_LINK_SECRET) throw new Error('Missing invite link secret');
  return jwt.verify(token, INVITE_LINK_SECRET);
}

function roleRank(role) {
  return String(role || '').toLowerCase() === 'editor' ? 2 : 1;
}

async function enforceNonProItineraryLimit(userId) {
  if (!userId || !isValidObjectId(userId)) return;

  const user = await User.findById(userId).select('_id isPro').lean();
  if (!user) return;
  if (user.isPro) return;

  const existingCount = await Itinerary.countDocuments({ userId: user._id });
  if (existingCount >= 1) {
    const err = new Error('Free plan allows only 1 itinerary. Upgrade to PRO to create more.');
    err.statusCode = 403;
    throw err;
  }
}

function normalizeRefId(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'object' && value !== null) {
    if (value._id) return String(value._id).trim();
    if (value.id) return String(value.id).trim();
  }
  return String(value).trim();
}

function destinationCount(payload = {}) {
  const keys = new Set();

  const visitPlaces = Array.isArray(payload?.visitPlaces) ? payload.visitPlaces : [];
  for (const row of visitPlaces) {
    const type = String(row?.type || 'place').trim().toLowerCase();
    const id = normalizeRefId(row?._id || row?.id || row?.externalId || row?.label);
    if (!id) continue;
    keys.add(`${type}:${id}`);
  }

  if (keys.size > 0) return keys.size;

  const destinations = payload?.destinations || {};
  const countries = Array.isArray(destinations?.countries) ? destinations.countries : [];
  const regions = Array.isArray(destinations?.regions) ? destinations.regions : [];
  const cities = Array.isArray(destinations?.cities) ? destinations.cities : [];

  for (const row of countries) {
    const id = normalizeRefId(row?.countryId);
    if (id) keys.add(`country:${id}`);
  }
  for (const row of regions) {
    const id = normalizeRefId(row?.regionId);
    if (id) keys.add(`region:${id}`);
  }
  for (const row of cities) {
    const id = normalizeRefId(row?.cityId);
    if (id) keys.add(`city:${id}`);
  }

  return keys.size;
}

async function enforceNonProDestinationLimit(userId, nextState) {
  if (!userId || !isValidObjectId(userId)) return;

  const user = await User.findById(userId).select('_id isPro').lean();
  if (!user || user.isPro) return;

  const count = destinationCount(nextState);
  if (count > MAX_FREE_DESTINATIONS) {
    const err = new Error(
      `Free plan allows up to ${MAX_FREE_DESTINATIONS} destinations per itinerary. Upgrade to PRO to add more.`
    );
    err.statusCode = 403;
    throw err;
  }
}

exports.create = async (req, res, next) => {
  try {
    const body = req.body || {};
    // Prefer auth, but accept userId from body as fallback
    const userId = userIdFromReq(req, body.userId);
    if (!userId) {
      return res.status(400).json({ error: 'userId is required (provide in body or via auth token)' });
    }

    await enforceNonProItineraryLimit(userId);
    await enforceNonProDestinationLimit(userId, body);

    const doc = await Itinerary.create({
      userId,
      name: body.name,
      tripStartDate: normalizeDateOnlyInput(body.tripStartDate),
      tripEndDate: normalizeDateOnlyInput(body.tripEndDate),
      status: body.status || 'draft',
      destinations: body.destinations,
      visitPlaces: body.visitPlaces,
      guests: body.guests
    });
    res.status(201).json(doc);
  } catch (err) {
    if (err?.statusCode) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    next(err);
  }
};

exports.list = async (req, res, next) => {
  try {
    const { status, q, dateFrom, dateTo } = req.query;
    const page  = Math.max(1, toInt(req.query.page, 1));
    const limit = Math.min(100, Math.max(1, toInt(req.query.limit, 20)));
    const skip  = (page - 1) * limit;

    const userId = userIdFromReq(req, req.query.userId);
    const requesterEmail = normalizeEmail(req.user?.email);
    const includeShared = String(req.query.includeShared || 'true').toLowerCase() !== 'false';

    const andFilters = [];

    if (userId) {
      const base = [{ userId }];
      if (includeShared) {
        base.push({ 'sharedWith.userId': userId, 'sharedWith.status': 'accepted' });
        if (requesterEmail) {
          base.push({ 'sharedWith.email': requesterEmail, 'sharedWith.status': { $in: ['accepted', 'invited'] } });
        }
      }
      andFilters.push({ $or: base });
    }

    if (status) andFilters.push({ status });
    if (q) andFilters.push({ name: { $regex: q, $options: 'i' } });
    if (dateFrom || dateTo) {
      // simple overlap: [tripStartDate, tripEndDate] ∩ [dateFrom, dateTo] ≠ ∅
      const from = asDate(dateFrom) || new Date('1900-01-01');
      const to   = asDate(dateTo)   || new Date('2999-12-31');
      andFilters.push({
        $or: [
          { tripStartDate: { $lte: to }, tripEndDate: { $gte: from } },
          { tripStartDate: { $exists: false }, tripEndDate: { $gte: from } },
          { tripStartDate: { $lte: to }, tripEndDate: { $exists: false } }
        ]
      });
    }

    const filter = andFilters.length ? { $and: andFilters } : {};

    const [items, total] = await Promise.all([
      Itinerary.aggregate([
        { $match: filter },
        { $sort: { createdAt: -1 } },
        { $skip: skip },
        { $limit: limit },
        {
          $lookup: {
            from: 'itineraryitems',
            let: { itinId: '$_id' },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $or: [
                      { $eq: ['$itineraryId', '$$itinId'] },
                      { $eq: ['$itineraryId', { $toString: '$$itinId' }] }
                    ]
                  }
                }
              },
              // Lookup for services
              {
                $lookup: {
                  from: 'services',
                  let: { sid: '$serviceId' },
                  pipeline: [
                    {
                      $match: {
                        $expr: {
                          $eq: [
                            '$_id',
                            {
                              $cond: [
                                { $eq: [{ $type: '$$sid' }, 'string'] },
                                { $toObjectId: '$$sid' },
                                '$$sid'
                              ]
                            }
                          ]
                        }
                      }
                    }
                  ],
                  as: 'svc'
                }
              },
              // Merge whichever service matched into a single 'service' field
              {
                $addFields: {
                  service: {
                    $let: {
                      vars: { merged: { $concatArrays: ['$svc'] } },
                      in: {
                        $cond: [
                          { $gt: [{ $size: '$$merged' }, 0] },
                          { $arrayElemAt: ['$$merged', 0] },
                          null
                        ]
                      }
                    }
                  }
                }
              },
              // Lookup for activities based on activityId
              {
                $lookup: {
                  from: 'activities',
                  let: { aid: '$activityId' },
                  pipeline: [
                    {
                      $match: {
                        $expr: {
                          $eq: [
                            '$_id',
                            {
                              $cond: [
                                { $eq: [{ $type: '$$aid' }, 'string'] },
                                { $toObjectId: '$$aid' },
                                '$$aid'
                              ]
                            }
                          ]
                        }
                      }
                    }
                  ],
                  as: 'act'
                }
              },
              // Merge whichever activity matched into a single 'activity' field
              {
                $addFields: {
                  activity: {
                    $let: {
                      vars: { mergedAct: { $concatArrays: ['$act'] } },
                      in: {
                        $cond: [
                          { $gt: [{ $size: '$$mergedAct' }, 0] },
                          { $arrayElemAt: ['$$mergedAct', 0] },
                          null
                        ]
                      }
                    }
                  }
                }
              },
              // Derive effective activityCategoryId (prefer customData, then activity)
              {
                $addFields: {
                  _activityCategoryId: {
                    $ifNull: [
                      '$customData.activityCategoryId',
                      {
                        $arrayElemAt: [
                          { $ifNull: ['$activity.activityCategoryIds', []] },
                          0
                        ]
                      }
                    ]
                  }
                }
              },
              // Lookup for ActivityCategory based on derived _activityCategoryId
              {
                $lookup: {
                  from: 'activitycategories',
                  let: { acid: '$_activityCategoryId' },
                  pipeline: [
                    {
                      $match: {
                        $expr: {
                          $eq: [
                            { $toString: '$_id' },
                            { $toString: '$$acid' }
                          ]
                        }
                      }
                    }
                  ],
                  as: 'ac'
                }
              },
              // Attach single activityCategory object at top level
              {
                $addFields: {
                  activityCategory: {
                    $cond: [
                      { $gt: [{ $size: '$ac' }, 0] },
                      { $arrayElemAt: ['$ac', 0] },
                      null
                    ]
                  }
                }
              },
              { $project: { svc: 0, act: 0, ac: 0, _activityCategoryId: 0 } }
            ],
            as: 'items'
          }
        }
      ]),
      Itinerary.countDocuments(filter)
    ]);

    // Enrich each itinerary with a visual cover from referenced zones.
    // so the front can render a destination-themed card immediately.
    const zoneIds = new Set();

    const normalizeId = (value) => {
      if (!value) return null;
      try {
        const id = String(value);
        return isValidObjectId(id) ? id : null;
      } catch {
        return null;
      }
    };

    for (const it of items) {
      const destinationZones = Array.isArray(it?.destinations?.zones) ? it.destinations.zones : [];
      for (const row of destinationZones) {
        const id = normalizeId(row?.zoneId);
        if (id) zoneIds.add(id);
      }

      const visitPlaces = Array.isArray(it?.visitPlaces) ? it.visitPlaces : [];
      for (const vp of visitPlaces) {
        const id = normalizeId(vp?._id || vp?.zoneId);
        if (id) zoneIds.add(id);
      }
    }

    const zones = zoneIds.size
      ? await Zone.find({ _id: { $in: Array.from(zoneIds) } }).select('_id cover').lean()
      : [];
    const zoneCoverById = new Map(zones.map((d) => [String(d._id), d.cover || null]));

    const pickCover = (it) => {
      const destinationZones = Array.isArray(it?.destinations?.zones) ? it.destinations.zones : [];
      for (const row of destinationZones) {
        const id = normalizeId(row?.zoneId);
        if (!id) continue;
        const cover = zoneCoverById.get(id);
        if (cover) return cover;
      }

      const visitPlaces = Array.isArray(it?.visitPlaces) ? it.visitPlaces : [];
      for (const vp of visitPlaces) {
        const id = normalizeId(vp?._id || vp?.zoneId);
        if (!id) continue;
        const cover = zoneCoverById.get(id);
        if (cover) return cover;
      }

      return null;
    };

    const enrichedItems = items.map((it) => ({
      ...it,
      cardCover: pickCover(it),
    }));

    res.json({
      items: enrichedItems,
      total,
      page,
      pages: Math.ceil(total / limit) || 1
    });
  } catch (err) { next(err); }
};

exports.get = async (req, res, next) => {
  try {
    const { itineraryId } = req.params;
    const doc = await Itinerary.findById(itineraryId);
    if (!doc) return res.status(404).json({ error: 'Itinerary not found' });
    if (!canReadItinerary(doc, req.user)) {
      return res.status(403).json({ error: 'Forbidden: no access to this itinerary' });
    }
    res.json(doc);
  } catch (err) { next(err); }
};

exports.update = async (req, res, next) => {
  try {
    const { itineraryId } = req.params;
    const body = req.body || {};
    const nextBody = { ...body };

    if (Object.prototype.hasOwnProperty.call(body, 'tripStartDate')) {
      nextBody.tripStartDate = normalizeDateOnlyInput(body.tripStartDate);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'tripEndDate')) {
      nextBody.tripEndDate = normalizeDateOnlyInput(body.tripEndDate);
    }

    const current = await Itinerary.findById(itineraryId).lean();
    if (!current) return res.status(404).json({ error: 'Itinerary not found' });
    if (!canEditItinerary(current, req.user)) {
      return res.status(403).json({ error: 'Forbidden: no edit access to this itinerary' });
    }

    const mergedState = {
      ...current,
      ...nextBody,
      destinations: nextBody.destinations !== undefined ? nextBody.destinations : current.destinations,
      visitPlaces: nextBody.visitPlaces !== undefined ? nextBody.visitPlaces : current.visitPlaces,
    };
    await enforceNonProDestinationLimit(current.userId, mergedState);

    const doc = await Itinerary.findByIdAndUpdate(
      itineraryId,
      { $set: nextBody },
      { new: true }
    );
    res.json(doc);
  } catch (err) {
    if (err?.statusCode) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    next(err);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const { itineraryId } = req.params;
    const current = await Itinerary.findById(itineraryId).lean();
    if (!current) return res.status(404).json({ error: 'Itinerary not found' });
    if (!isOwner(current, req.user)) {
      return res.status(403).json({ error: 'Forbidden: only owner can delete this itinerary' });
    }

    // Try transactional delete first (replica set / mongos).
    // Fallback to non-transactional delete for standalone Mongo instances.
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await ItineraryItem.deleteMany({ itineraryId }, { session });
        await Itinerary.findByIdAndDelete(itineraryId, { session });
      });
    } catch (err) {
      const txUnsupported =
        err?.code === 20 ||
        String(err?.message || '').toLowerCase().includes('transaction numbers are only allowed');

      if (!txUnsupported) throw err;

      await ItineraryItem.deleteMany({ itineraryId });
      await Itinerary.findByIdAndDelete(itineraryId);
    } finally {
      await session.endSession();
    }

    res.json({ ok: true });
  } catch (err) { next(err); }
};

exports.duplicate = async (req, res, next) => {
  try {
    const { itineraryId } = req.params;
    const { withItems = true } = req.body || {};
    const original = await Itinerary.findById(itineraryId);
    if (!original) return res.status(404).json({ error: 'Itinerary not found' });
    if (!canReadItinerary(original, req.user)) {
      return res.status(403).json({ error: 'Forbidden: no access to this itinerary' });
    }

    const ownerOrRequesterId = userIdFromReq(req, original.userId);
    await enforceNonProItineraryLimit(ownerOrRequesterId);
    await enforceNonProDestinationLimit(ownerOrRequesterId, {
      destinations: original.destinations,
      visitPlaces: original.visitPlaces,
    });

    const session = await mongoose.startSession();
    let newItin;
    await session.withTransaction(async () => {
      newItin = await Itinerary.create([{
        userId: ownerOrRequesterId,
        name: `${original.name || 'Itinerary'} (copy)`,
        tripStartDate: original.tripStartDate,
        tripEndDate: original.tripEndDate,
        status: 'draft',
        destinations: original.destinations,
        visitPlaces: original.visitPlaces,
        guests: original.guests
      }], { session }).then(r => r[0]);

      if (withItems) {
        const items = await ItineraryItem.find({ itineraryId: original._id }).lean();
        if (items.length) {
          const cloned = items.map(it => {
            const { _id, itineraryId, createdAt, updatedAt, ...rest } = it;
            return { ...rest, itineraryId: newItin._id, status: 'draft' };
          });
          await ItineraryItem.insertMany(cloned, { session });
        }
      }
    });
    session.endSession();
    res.status(201).json(newItin);
  } catch (err) {
    if (err?.statusCode) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    next(err);
  }
};

exports.listShares = async (req, res, next) => {
  try {
    const { itineraryId } = req.params;
    const doc = await Itinerary.findById(itineraryId).lean();
    if (!doc) return res.status(404).json({ error: 'Itinerary not found' });
    if (!isOwner(doc, req.user) && !canReadItinerary(doc, req.user)) {
      return res.status(403).json({ error: 'Forbidden: no access to this itinerary' });
    }

    const sharedWith = Array.isArray(doc.sharedWith) ? doc.sharedWith : [];
    return res.json({ items: sharedWith });
  } catch (err) {
    return next(err);
  }
};

exports.createShareLink = async (req, res, next) => {
  try {
    const { itineraryId } = req.params;
    const requestedRole = SHARE_ROLE_SET.has(String(req.body?.role || '').toLowerCase())
      ? String(req.body.role).toLowerCase()
      : 'viewer';

    const doc = await Itinerary.findById(itineraryId).lean();
    if (!doc) return res.status(404).json({ error: 'Itinerary not found' });
    if (!isOwner(doc, req.user)) {
      return res.status(403).json({ error: 'Forbidden: only owner can create share links' });
    }

    const token = signInviteLinkToken({
      typ: 'itinerary_share_link',
      itineraryId: String(doc._id),
      role: requestedRole,
    });
    const shareUrl = buildWebAppUrl(`/trip?inviteToken=${encodeURIComponent(token)}`);

    return res.json({
      ok: true,
      role: requestedRole,
      token,
      shareUrl,
      expiresInDays: INVITE_LINK_TTL_DAYS,
    });
  } catch (err) {
    return next(err);
  }
};

exports.acceptShareLink = async (req, res, next) => {
  try {
    const token = String(req.body?.token || '').trim();
    if (!token) return res.status(400).json({ error: 'token is required' });
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });

    let payload;
    try {
      payload = verifyInviteLinkToken(token);
    } catch {
      return res.status(400).json({ error: 'Invalid or expired invite link' });
    }

    if (String(payload?.typ || '') !== 'itinerary_share_link') {
      return res.status(400).json({ error: 'Invalid invite link type' });
    }

    const itineraryId = toObjectIdString(payload?.itineraryId);
    if (!itineraryId) return res.status(400).json({ error: 'Invalid itinerary id in link' });

    const linkRole = SHARE_ROLE_SET.has(String(payload?.role || '').toLowerCase())
      ? String(payload.role).toLowerCase()
      : 'viewer';

    const doc = await Itinerary.findById(itineraryId);
    if (!doc) return res.status(404).json({ error: 'Itinerary not found' });

    if (isOwner(doc, req.user)) {
      return res.json({ ok: true, owner: true, itineraryId: String(doc._id) });
    }

    const requesterId = toObjectIdString(req.user?._id || req.user?.id);
    const requesterEmail = normalizeEmail(req.user?.email);
    const sharedWith = Array.isArray(doc.sharedWith) ? doc.sharedWith : [];
    const now = new Date();
    const existing = sharedWith.find((row) => {
      const rowUserId = toObjectIdString(row?.userId);
      const rowEmail = normalizeEmail(row?.email);
      if (requesterId && rowUserId && rowUserId === requesterId) return true;
      return !!requesterEmail && !!rowEmail && rowEmail === requesterEmail;
    });

    if (existing) {
      const nextRole = roleRank(existing.role) >= roleRank(linkRole) ? existing.role : linkRole;
      existing.role = nextRole;
      existing.status = 'accepted';
      if (!existing.acceptedAt) existing.acceptedAt = now;
      if (requesterId && !existing.userId) existing.userId = requesterId;
      if (requesterEmail && !existing.email) existing.email = requesterEmail;
    } else {
      sharedWith.push({
        userId: requesterId || undefined,
        email: requesterEmail || undefined,
        role: linkRole,
        status: 'accepted',
        invitedBy: undefined,
        invitedAt: now,
        acceptedAt: now,
      });
      doc.sharedWith = sharedWith;
    }

    await doc.save();
    return res.json({ ok: true, itineraryId: String(doc._id), role: linkRole });
  } catch (err) {
    return next(err);
  }
};

exports.acceptInvite = async (req, res, next) => {
  try {
    const { itineraryId } = req.params;
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });

    const doc = await Itinerary.findById(itineraryId);
    if (!doc) return res.status(404).json({ error: 'Itinerary not found' });

    if (isOwner(doc, req.user)) {
      return res.json({ ok: true, owner: true });
    }

    const requesterId = toObjectIdString(req.user?._id || req.user?.id);
    const requesterEmail = normalizeEmail(req.user?.email);
    const sharedWith = Array.isArray(doc.sharedWith) ? doc.sharedWith : [];
    const entry = sharedWith.find((row) => {
      const rowUserId = toObjectIdString(row?.userId);
      const rowEmail = normalizeEmail(row?.email);
      if (requesterId && rowUserId && rowUserId === requesterId) return true;
      return !!requesterEmail && !!rowEmail && rowEmail === requesterEmail;
    });

    if (!entry) {
      return res.status(403).json({ error: 'Forbidden: no invitation found for this user' });
    }

    const now = new Date();
    const status = String(entry.status || '').toLowerCase();
    if (status !== 'accepted') {
      entry.status = 'accepted';
      entry.acceptedAt = now;
    } else if (!entry.acceptedAt) {
      entry.acceptedAt = now;
    }

    if (requesterId && !entry.userId) {
      entry.userId = requesterId;
    }
    if (requesterEmail && !entry.email) {
      entry.email = requesterEmail;
    }

    await doc.save();
    return res.json({ ok: true, share: entry });
  } catch (err) {
    return next(err);
  }
};

exports.share = async (req, res, next) => {
  try {
    const { itineraryId } = req.params;
    const body = req.body || {};
    const defaultRole = SHARE_ROLE_SET.has(String(body.role || '').toLowerCase())
      ? String(body.role).toLowerCase()
      : 'viewer';

    const doc = await Itinerary.findById(itineraryId);
    if (!doc) return res.status(404).json({ error: 'Itinerary not found' });
    if (!isOwner(doc, req.user)) {
      return res.status(403).json({ error: 'Forbidden: only owner can share this itinerary' });
    }

    const ownerId = toObjectIdString(doc.userId);
    const ownerEmail = normalizeEmail(req.user?.email);
    const invitationRows = Array.isArray(body.invitations)
      ? body.invitations
      : [];

    const incomingUserIds = Array.isArray(body.userIds) ? body.userIds : [];
    const incomingEmails = Array.isArray(body.emails) ? body.emails : [];

    const normalizedRows = [];
    for (const row of invitationRows) {
      if (!row || typeof row !== 'object') continue;
      const email = normalizeEmail(row.email);
      const userId = toObjectIdString(row.userId);
      if (!email && !userId) continue;
      const role = SHARE_ROLE_SET.has(String(row.role || '').toLowerCase())
        ? String(row.role).toLowerCase()
        : defaultRole;
      normalizedRows.push({ email, userId, role });
    }

    for (const userIdRaw of incomingUserIds) {
      const userId = toObjectIdString(userIdRaw);
      if (!userId) continue;
      normalizedRows.push({ email: '', userId, role: defaultRole });
    }
    for (const emailRaw of incomingEmails) {
      const email = normalizeEmail(emailRaw);
      if (!email) continue;
      normalizedRows.push({ email, userId: '', role: defaultRole });
    }

    const uniqueUserIds = Array.from(new Set(normalizedRows.map((r) => r.userId).filter(Boolean)));
    const uniqueEmails = Array.from(new Set(normalizedRows.map((r) => r.email).filter(Boolean)));

    const usersById = uniqueUserIds.length
      ? await User.find({ _id: { $in: uniqueUserIds } }).select('_id email').lean()
      : [];
    const usersByEmail = uniqueEmails.length
      ? await User.find({ email: { $in: uniqueEmails } }).select('_id email').lean()
      : [];

    const knownUsersById = new Map(usersById.map((u) => [toObjectIdString(u._id), normalizeEmail(u.email)]));
    const knownUsersByEmail = new Map(usersByEmail.map((u) => [normalizeEmail(u.email), toObjectIdString(u._id)]));

    const recipientsMap = new Map();
    for (const row of normalizedRows) {
      let userId = row.userId;
      let email = row.email;
      if (userId && !email) {
        email = knownUsersById.get(userId) || '';
      }
      if (email && !userId) {
        userId = knownUsersByEmail.get(email) || '';
      }
      if (userId && knownUsersById.has(userId) && !email) {
        email = knownUsersById.get(userId) || '';
      }
      if (!email && !userId) continue;
      if ((userId && userId === ownerId) || (email && email === ownerEmail)) continue;

      const key = email || `uid:${userId}`;
      recipientsMap.set(key, { userId, email, role: row.role || defaultRole });
    }

    const recipients = Array.from(recipientsMap.values());
    if (!recipients.length) {
      return res.status(400).json({ error: 'No valid recipients to share with' });
    }

    const current = Array.isArray(doc.sharedWith) ? doc.sharedWith : [];
    const now = new Date();

    for (const recipient of recipients) {
      const existing = current.find((row) => {
        const rowId = toObjectIdString(row?.userId);
        const rowEmail = normalizeEmail(row?.email);
        if (recipient.userId && rowId && recipient.userId === rowId) return true;
        return !!recipient.email && !!rowEmail && recipient.email === rowEmail;
      });

      if (existing) {
        existing.role = recipient.role || defaultRole;
        existing.status = existing.status || 'accepted';
        existing.invitedAt = existing.invitedAt || now;
        existing.invitedBy = existing.invitedBy || req.user?._id;
        if (recipient.userId && !existing.userId) {
          existing.userId = recipient.userId;
        }
        if (!existing.email) {
          existing.email = recipient.email;
        }
        if (existing.status === 'accepted' && !existing.acceptedAt) {
          existing.acceptedAt = now;
        }
        continue;
      }

      current.push({
        userId: recipient.userId || undefined,
        email: recipient.email,
        role: recipient.role || defaultRole,
        status: recipient.userId ? 'accepted' : 'invited',
        invitedBy: req.user?._id,
        invitedAt: now,
        acceptedAt: recipient.userId ? now : undefined,
      });
    }

    doc.sharedWith = current;
    await doc.save();

    const itineraryPath = doc?._id ? `/trip?itineraryId=${encodeURIComponent(String(doc._id))}` : '/trip';
    const ctaUrl = buildWebAppUrl(itineraryPath);
    const senderName = String(req.user?.name || '').trim();
    const itineraryName = String(doc?.name || 'Shared trip').trim();
    const recipientsWithEmail = recipients.filter((r) => !!normalizeEmail(r.email));

    if (recipientsWithEmail.length) {
      Promise.allSettled(
        recipientsWithEmail.map((r) => {
          const recipientEmail = normalizeEmail(r.email);
          const recipientRole = SHARE_ROLE_SET.has(String(r.role || '').toLowerCase())
            ? String(r.role).toLowerCase()
            : 'viewer';
          return sendTemplatedEmail({
            to: recipientEmail,
            templateKey: 'itinerary_invite',
            data: {
              senderName,
              itineraryName,
              recipientRole,
              ctaUrl,
            },
          });
        })
      ).then((results) => {
        for (const result of results) {
          if (result.status === 'rejected') {
            console.error('[itinerary.share] invitation email failed:', result.reason?.message || result.reason);
          }
        }
      });
    }

    return res.json({ ok: true, sharedWith: doc.sharedWith });
  } catch (err) {
    return next(err);
  }
};

exports.unshare = async (req, res, next) => {
  try {
    const { itineraryId, memberId } = req.params;
    const memberIdNorm = String(memberId || '').trim().toLowerCase();
    if (!memberIdNorm) return res.status(400).json({ error: 'memberId is required' });

    const doc = await Itinerary.findById(itineraryId);
    if (!doc) return res.status(404).json({ error: 'Itinerary not found' });
    if (!isOwner(doc, req.user)) {
      return res.status(403).json({ error: 'Forbidden: only owner can unshare this itinerary' });
    }

    const before = Array.isArray(doc.sharedWith) ? doc.sharedWith : [];
    const next = before.filter((entry) => {
      const entryId = toObjectIdString(entry?.userId).toLowerCase();
      const entryEmail = normalizeEmail(entry?.email);
      return entryId !== memberIdNorm && entryEmail !== memberIdNorm;
    });

    doc.sharedWith = next;
    await doc.save();

    return res.json({ ok: true, removed: before.length - next.length, sharedWith: doc.sharedWith });
  } catch (err) {
    return next(err);
  }
};
