const ServiceTag = require('../models/ServiceTag');

function buildFilters(query) {
  const filters = {};

  if (query.isActive !== undefined) {
    filters.isActive = String(query.isActive) === 'true';
  }

  if (query.businessType) {
    // Allow filtering by a single businessType value
    filters.businessType = { $in: [query.businessType] };
  }

  if (query.q) {
    filters.$or = [
      { name: { $regex: query.q, $options: 'i' } },
      { slug: { $regex: query.q, $options: 'i' } }
    ];
  }

  return filters;
}

exports.create = async (req, res) => {
  try {
    const { name, slug, businessType, isActive } = req.body;

    if (!name || !slug || !Array.isArray(businessType) || businessType.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'name, slug and businessType[] are required.'
      });
    }

    const exists = await ServiceTag.findOne({ slug });
    if (exists)
      return res
        .status(409)
        .json({ success: false, message: 'Slug already exists.' });

    const item = await ServiceTag.create({ name, slug, businessType, isActive });
    return res.json({ success: true, data: item });
  } catch (err) {
    console.error('ServiceTag.create error:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
};

exports.createMany = async (req, res) => {
  try {
    const items = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Request body must be a non-empty array.',
      });
    }

    const invalidItems = [];

    items.forEach((item, index) => {
      const { name, slug, businessType } = item || {};
      if (!name || !slug || !Array.isArray(businessType) || businessType.length === 0) {
        invalidItems.push({ index, slug, name });
      }
    });

    if (invalidItems.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Each item must have name, slug and businessType[] (non-empty).',
        invalidItems,
      });
    }

    const slugs = items.map((i) => i.slug).filter(Boolean);

    const existing = await ServiceTag.find({ slug: { $in: slugs } }).select('slug');
    if (existing.length > 0) {
      const existingSlugs = existing.map((e) => e.slug);
      return res.status(409).json({
        success: false,
        message: 'Some slugs already exist.',
        existingSlugs,
      });
    }

    const payloads = items.map((item) => ({
      name: item.name,
      slug: item.slug,
      businessType: item.businessType,
      isActive: item.isActive,
    }));

    const created = await ServiceTag.insertMany(payloads);

    return res.json({ success: true, data: created });
  } catch (err) {
    console.error('ServiceTag.createMany error:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
};

exports.list = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '100', 10), 1), 200);
    const skip = (page - 1) * limit;

    const filters = buildFilters(req.query);

    const [items, total] = await Promise.all([
      ServiceTag.find(filters).sort({ name: 1 }).skip(skip).limit(limit),
      ServiceTag.countDocuments(filters)
    ]);

    return res.json({
      success: true,
      data: items,
      pagination: {
        total,
        page,
        pages: Math.ceil(total / limit),
        limit
      }
    });
  } catch (err) {
    console.error('ServiceTag.list error:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
};

exports.get = async (req, res) => {
  try {
    const item = await ServiceTag.findById(req.params.id);
    if (!item)
      return res
        .status(404)
        .json({ success: false, message: 'Not found.' });

    return res.json({ success: true, data: item });
  } catch (err) {
    console.error('ServiceTag.get error:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
};

exports.update = async (req, res) => {
  try {
    const payload = { ...req.body };

    if (payload.businessType) {
      if (!Array.isArray(payload.businessType) || payload.businessType.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'businessType must be a non-empty array.'
        });
      }
    }

    const updated = await ServiceTag.findByIdAndUpdate(req.params.id, payload, {
      new: true
    });

    if (!updated)
      return res
        .status(404)
        .json({ success: false, message: 'Not found.' });

    return res.json({ success: true, data: updated });
  } catch (err) {
    console.error('ServiceTag.update error:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
};

exports.deactivate = async (req, res) => {
  try {
    const updated = await ServiceTag.findByIdAndUpdate(
      req.params.id,
      { isActive: false, deletedAt: new Date() },
      { new: true }
    );

    if (!updated)
      return res
        .status(404)
        .json({ success: false, message: 'Not found.' });

    return res.json({ success: true, data: updated });
  } catch (err) {
    console.error('ServiceTag.deactivate error:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
};

exports.restore = async (req, res) => {
  try {
    const updated = await ServiceTag.findByIdAndUpdate(
      req.params.id,
      { isActive: true, deletedAt: null },
      { new: true }
    );

    if (!updated)
      return res
        .status(404)
        .json({ success: false, message: 'Not found.' });

    return res.json({ success: true, data: updated });
  } catch (err) {
    console.error('ServiceTag.restore error:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
};

exports.remove = async (req, res) => {
  try {
    const deleted = await ServiceTag.findByIdAndDelete(req.params.id);

    if (!deleted)
      return res
        .status(404)
        .json({ success: false, message: 'Not found.' });

    return res.json({ success: true, message: 'Deleted permanently.' });
  } catch (err) {
    console.error('ServiceTag.remove error:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
};