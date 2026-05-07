const SocialImportLink = require('../models/SocialImportLink');

function toInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

exports.list = async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const source = String(req.query.source || '').trim();
    const status = String(req.query.status || '').trim();

    const limit = Math.min(200, Math.max(1, toInt(req.query.limit, 50)));
    const offset = Math.max(0, toInt(req.query.offset, 0));

    const filter = {};

    if (source) filter.source = source;
    if (status) filter['extraction.status'] = status;

    if (q) {
      const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [
        { normalizedUrl: re },
        { originalUrls: re },
        { postId: re },
        { source: re },
      ];
    }

    const [items, total] = await Promise.all([
      SocialImportLink.find(filter)
        .sort({ updatedAt: -1 })
        .skip(offset)
        .limit(limit)
        .populate({
          path: 'resolvedActivities.activityId',
          select: '_id name slug active externalRef',
        })
        .lean(),
      SocialImportLink.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: {
        items,
        total,
        limit,
        offset,
      },
    });
  } catch (err) {
    console.error('Error listing social import links:', err);
    res.status(500).json({ success: false, error: 'Unable to list social import links.' });
  }
};
