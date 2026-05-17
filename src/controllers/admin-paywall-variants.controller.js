const PaywallVariant = require('../models/PaywallVariant');

function parsePercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function toAnalyticsKey(value = '') {
  const base = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
  return base || `variant_${Date.now()}`;
}

function normalizePayload(body = {}) {
  const name = String(body.name || '').trim();
  const deepLinkKey = String(body.deepLinkKey || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 140);
  const payload = {
    name,
    analyticsKey: toAnalyticsKey(body.analyticsKey || name),
    deepLinkKey,
    appearancePercent: parsePercent(body.appearancePercent),
    isActive: !!body.isActive,
    code: body.code && typeof body.code === 'object' ? body.code : {},
  };
  return payload;
}

exports.list = async (_req, res) => {
  try {
    const missing = await PaywallVariant.find({
      $or: [{ analyticsKey: { $exists: false } }, { analyticsKey: '' }, { analyticsKey: null }],
    }).select('_id name').lean();
    if (missing.length) {
      await Promise.all(
        missing.map((item) =>
          PaywallVariant.updateOne(
            { _id: item._id },
            { $set: { analyticsKey: toAnalyticsKey(item.name) } }
          )
        )
      );
    }
    const items = await PaywallVariant.find({}).sort({ updatedAt: -1 }).lean();
    return res.json({ success: true, data: items });
  } catch (error) {
    console.error('[admin-paywall-variants.list]', error);
    return res.status(500).json({ success: false, error: 'Unable to list paywall variants.' });
  }
};

exports.create = async (req, res) => {
  try {
    const payload = normalizePayload(req.body || {});
    if (!payload.name) {
      return res.status(400).json({ success: false, error: 'name is required' });
    }
    const created = await PaywallVariant.create(payload);
    return res.status(201).json({ success: true, data: created });
  } catch (error) {
    console.error('[admin-paywall-variants.create]', error);
    if (error?.code === 11000) {
      return res.status(409).json({ success: false, error: 'A paywall variant with this name already exists.' });
    }
    return res.status(500).json({ success: false, error: 'Unable to create paywall variant.' });
  }
};

exports.updateById = async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ success: false, error: 'id is required' });

    const payload = normalizePayload(req.body || {});
    if (!payload.name) {
      return res.status(400).json({ success: false, error: 'name is required' });
    }

    const updated = await PaywallVariant.findByIdAndUpdate(id, payload, {
      new: true,
      runValidators: true,
    });

    if (!updated) return res.status(404).json({ success: false, error: 'Paywall variant not found.' });
    return res.json({ success: true, data: updated });
  } catch (error) {
    console.error('[admin-paywall-variants.updateById]', error);
    if (error?.code === 11000) {
      return res.status(409).json({ success: false, error: 'A paywall variant with this name already exists.' });
    }
    return res.status(500).json({ success: false, error: 'Unable to update paywall variant.' });
  }
};

exports.removeById = async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ success: false, error: 'id is required' });

    const removed = await PaywallVariant.findByIdAndDelete(id);
    if (!removed) return res.status(404).json({ success: false, error: 'Paywall variant not found.' });
    return res.json({ success: true, data: { _id: removed._id } });
  } catch (error) {
    console.error('[admin-paywall-variants.removeById]', error);
    return res.status(500).json({ success: false, error: 'Unable to delete paywall variant.' });
  }
};
