const crypto = require('crypto');
const AnalyticsEvent = require('../models/AnalyticsEvent');

function hashIp(ip) {
  if (!ip) return null;
  const salt = process.env.ANALYTICS_IP_SALT || process.env.JWT_ACCESS_SECRET || 'ibeento-analytics';
  return crypto.createHash('sha256').update(`${salt}:${ip}`).digest('hex');
}

exports.track = async (req, res, next) => {
  try {
    const {
      event,
      sessionId,
      itineraryId,
      source,
      platform,
      pathname,
      step,
      success,
      metadata,
      occurredAt,
    } = req.body || {};

    const safeEvent = String(event || '').trim();
    if (!safeEvent) {
      return res.status(400).json({ success: false, message: 'event is required' });
    }

    const safeSessionId = String(sessionId || '').trim();
    const userId = req.user?._id || null;

    if (!userId && !safeSessionId) {
      return res.status(400).json({ success: false, message: 'sessionId is required for anonymous events' });
    }

    const doc = await AnalyticsEvent.create({
      event: safeEvent,
      userId: userId || undefined,
      sessionId: safeSessionId || undefined,
      itineraryId: itineraryId || undefined,
      source: source || 'web',
      platform: platform || 'web',
      pathname: pathname || undefined,
      step: step || undefined,
      success: typeof success === 'boolean' ? success : true,
      metadata: metadata && typeof metadata === 'object' ? metadata : {},
      occurredAt: occurredAt ? new Date(occurredAt) : new Date(),
      userAgent: req.get('user-agent') || undefined,
      ipHash: hashIp(req.ip || ''),
    });

    return res.status(201).json({ success: true, id: doc._id });
  } catch (err) {
    return next(err);
  }
};
