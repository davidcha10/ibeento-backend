const PossibleRiskItem = require('../models/PossibleRiskItem');

function buildFilters(query) {
  const filters = {};
  if (query.isActive !== undefined) filters.isActive = String(query.isActive) === 'true';
  if (query.businessType)          filters.businessType = { $in: [query.businessType] };
  if (query.q) {
    filters.$or = [
      { name: { $regex: query.q, $options: 'i' } },
      { slug: { $regex: query.q, $options: 'i' } },
    ];
  }
  return filters;
}

exports.create = async (req, res) => {
  try {
    const { name, slug, icon, businessType, order, isActive } = req.body;

    if (!name || !slug || !Array.isArray(businessType) || businessType.length === 0) {
      return res.status(400).json({ success: false, message: 'name, slug and businessType[] are required.' });
    }

    const exists = await PossibleRiskItem.findOne({ slug });
    if (exists) return res.status(409).json({ success: false, message: 'Slug already exists.' });

    const item = await PossibleRiskItem.create({ name, slug, icon, businessType, order, isActive });
    return res.json({ success: true, data: item });
  } catch (err) {
    console.error('PossibleRiskItem.create error:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
};

exports.list = async (req, res) => {
  try {
    const page  = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '100', 10), 1), 200);
    const skip  = (page - 1) * limit;

    const filters = buildFilters(req.query);

    const [items, total] = await Promise.all([
      PossibleRiskItem.find(filters).sort({ order: 1, name: 1 }).skip(skip).limit(limit),
      PossibleRiskItem.countDocuments(filters),
    ]);

    return res.json({
      success: true,
      data: items,
      pagination: { total, page, pages: Math.ceil(total / limit), limit },
    });
  } catch (err) {
    console.error('PossibleRiskItem.list error:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
};

exports.get = async (req, res) => {
  try {
    const item = await PossibleRiskItem.findById(req.params.id);
    if (!item) return res.status(404).json({ success: false, message: 'Not found.' });
    return res.json({ success: true, data: item });
  } catch (err) {
    console.error('PossibleRiskItem.get error:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
};

exports.update = async (req, res) => {
  try {
    const payload = { ...req.body };
    if (payload.businessType) {
      if (!Array.isArray(payload.businessType) || payload.businessType.length === 0) {
        return res.status(400).json({ success: false, message: 'businessType must be a non-empty array.' });
      }
    }
    const updated = await PossibleRiskItem.findByIdAndUpdate(req.params.id, payload, { new: true });
    if (!updated) return res.status(404).json({ success: false, message: 'Not found.' });
    return res.json({ success: true, data: updated });
  } catch (err) {
    console.error('PossibleRiskItem.update error:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
};

exports.deactivate = async (req, res) => {
  try {
    const updated = await PossibleRiskItem.findByIdAndUpdate(
      req.params.id,
      { isActive: false, deletedAt: new Date() },
      { new: true }
    );
    if (!updated) return res.status(404).json({ success: false, message: 'Not found.' });
    return res.json({ success: true, data: updated });
  } catch (err) {
    console.error('PossibleRiskItem.deactivate error:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
};

exports.restore = async (req, res) => {
  try {
    const updated = await PossibleRiskItem.findByIdAndUpdate(
      req.params.id,
      { isActive: true, deletedAt: null },
      { new: true }
    );
    if (!updated) return res.status(404).json({ success: false, message: 'Not found.' });
    return res.json({ success: true, data: updated });
  } catch (err) {
    console.error('PossibleRiskItem.restore error:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
};

exports.remove = async (req, res) => {
  try {
    const deleted = await PossibleRiskItem.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ success: false, message: 'Not found.' });
    return res.json({ success: true, message: 'Deleted permanently.' });
  } catch (err) {
    console.error('PossibleRiskItem.remove error:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
};