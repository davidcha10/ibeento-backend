const BillingTransaction = require('../models/BillingTransaction');
const UserSubscription = require('../models/UserSubscription');

function parseLimit(raw, fallback = 30, max = 200) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(Math.round(n), 1), max);
}

function parseOffset(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n);
}

function parseDays(raw, fallback = 90) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(Math.round(n), 1), 3650);
}

exports.transactions = async (req, res, next) => {
  try {
    const limit = parseLimit(req.query.limit, 30, 200);
    const offset = parseOffset(req.query.offset);
    const days = parseDays(req.query.days, 90);
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const filter = { occurredAt: { $gte: from } };
    if (req.query.provider) filter.provider = String(req.query.provider).trim();
    if (req.query.status) filter.status = String(req.query.status).trim();
    if (req.query.eventType) filter.eventType = String(req.query.eventType).trim();
    if (req.query.userId) filter.userId = String(req.query.userId).trim();
    if (req.query.planId) filter['plan.planId'] = String(req.query.planId).trim();

    const [rows, total] = await Promise.all([
      BillingTransaction.find(filter)
        .sort({ occurredAt: -1, _id: -1 })
        .skip(offset)
        .limit(limit)
        .populate('userId', '_id email name')
        .lean(),
      BillingTransaction.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: {
        total,
        limit,
        offset,
        rows,
      },
    });
  } catch (err) {
    return next(err);
  }
};

exports.subscriptions = async (req, res, next) => {
  try {
    const limit = parseLimit(req.query.limit, 50, 300);
    const offset = parseOffset(req.query.offset);

    const filter = {};
    if (req.query.provider) filter.provider = String(req.query.provider).trim();
    if (req.query.status) filter.status = String(req.query.status).trim();
    if (req.query.planId) filter['plan.planId'] = String(req.query.planId).trim();
    if (req.query.isPro !== undefined) {
      const raw = String(req.query.isPro).trim().toLowerCase();
      if (raw === 'true' || raw === '1') filter.isPro = true;
      if (raw === 'false' || raw === '0') filter.isPro = false;
    }

    const [rows, total] = await Promise.all([
      UserSubscription.find(filter)
        .sort({ updatedAt: -1, _id: -1 })
        .skip(offset)
        .limit(limit)
        .populate('userId', '_id email name role')
        .lean(),
      UserSubscription.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: {
        total,
        limit,
        offset,
        rows,
      },
    });
  } catch (err) {
    return next(err);
  }
};
