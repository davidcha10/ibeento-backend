const crypto = require('crypto');
const PaywallVariant = require('../models/PaywallVariant');

function hashToUnitInterval(input) {
  const normalized = String(input || '').trim();
  if (!normalized) return Math.random();
  const hash = crypto.createHash('sha256').update(normalized).digest('hex');
  const slice = hash.slice(0, 12);
  const intVal = Number.parseInt(slice, 16);
  const maxVal = Number.parseInt('ffffffffffff', 16);
  return maxVal > 0 ? (intVal / maxVal) : Math.random();
}

function resolveWeightedVariant(items, actorKey = '') {
  if (!Array.isArray(items) || !items.length) return null;

  const weighted = items
    .map((item) => ({
      item,
      weight: Number.isFinite(Number(item.appearancePercent)) ? Math.max(0, Number(item.appearancePercent)) : 0,
    }))
    .filter((row) => row.weight > 0);

  if (!weighted.length) return items[0] || null;

  const total = weighted.reduce((acc, row) => acc + row.weight, 0);
  const pick = hashToUnitInterval(actorKey || `${Date.now()}-${Math.random()}`) * total;

  let cursor = 0;
  for (const row of weighted) {
    cursor += row.weight;
    if (pick <= cursor) return row.item;
  }
  return weighted[weighted.length - 1].item;
}

function toAnalyticsKey(value = '') {
  const base = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
  return base || 'unknown';
}

exports.resolve = async (req, res) => {
  try {
    const actorKey = String(req.query.actorKey || req.body?.actorKey || '').trim();
    const deepLinkKey = String(req.query.deepLinkKey || req.query.paywallDeepLinkKey || req.body?.deepLinkKey || '')
      .trim()
      .toLowerCase();

    if (deepLinkKey) {
      const forcedVariant = await PaywallVariant.findOne({
        isActive: true,
        deepLinkKey,
      }).lean();

      if (forcedVariant) {
        return res.json({
          success: true,
          data: {
            _id: forcedVariant._id,
            name: forcedVariant.name,
            analyticsKey: forcedVariant.analyticsKey || toAnalyticsKey(forcedVariant.name),
            deepLinkKey: forcedVariant.deepLinkKey || '',
            appearancePercent: forcedVariant.appearancePercent,
            isActive: forcedVariant.isActive,
            code: forcedVariant.code || {},
          },
        });
      }
    }

    const active = await PaywallVariant.find({ isActive: true })
      .sort({ appearancePercent: -1, updatedAt: -1 })
      .lean();

    if (!active.length) {
      return res.status(404).json({ success: false, error: 'No active paywall variants configured.' });
    }

    const variant = resolveWeightedVariant(active, actorKey);
    if (!variant) {
      return res.status(404).json({ success: false, error: 'Unable to resolve paywall variant.' });
    }

    return res.json({
      success: true,
      data: {
        _id: variant._id,
        name: variant.name,
        analyticsKey: variant.analyticsKey || toAnalyticsKey(variant.name),
        deepLinkKey: variant.deepLinkKey || '',
        appearancePercent: variant.appearancePercent,
        isActive: variant.isActive,
        code: variant.code || {},
      },
    });
  } catch (error) {
    console.error('[paywall-variants.resolve]', error);
    return res.status(500).json({ success: false, error: 'Unable to resolve paywall variant.' });
  }
};
