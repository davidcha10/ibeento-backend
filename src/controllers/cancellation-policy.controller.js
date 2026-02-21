const CancellationPolicy = require('../models/CancellationPolicy');

// Create a policy
exports.create = async (req, res) => {
  try {
    const policy = await CancellationPolicy.create(req.body);
    res.status(201).json({ success: true, data: policy });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// List all policies (with optional filters)
exports.list = async (req, res) => {
  try {
    const query = {};
    if (req.query.isActive !== undefined) query.isActive = req.query.isActive === 'true';
    if (req.query.businessType) {
      const types = req.query.businessType.split(',');
      query.businessTypes = { $in: types };
    }

    const policies = await CancellationPolicy.find(query).sort({ order: 1 });
    res.status(200).json({ success: true, data: policies });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// Get single policy
exports.get = async (req, res) => {
  try {
    const policy = await CancellationPolicy.findById(req.params.id);
    if (!policy) return res.status(404).json({ success: false, message: 'Policy not found' });
    res.status(200).json({ success: true, data: policy });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// Update policy (including rules array)
exports.update = async (req, res) => {
  try {
    const policy = await CancellationPolicy.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!policy) return res.status(404).json({ success: false, message: 'Policy not found' });
    res.status(200).json({ success: true, data: policy });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// Deactivate policy (soft delete)
exports.deactivate = async (req, res) => {
  try {
    const policy = await CancellationPolicy.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
    if (!policy) return res.status(404).json({ success: false, message: 'Policy not found' });
    res.status(200).json({ success: true, data: policy });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// Restore policy
exports.restore = async (req, res) => {
  try {
    const policy = await CancellationPolicy.findByIdAndUpdate(req.params.id, { isActive: true }, { new: true });
    if (!policy) return res.status(404).json({ success: false, message: 'Policy not found' });
    res.status(200).json({ success: true, data: policy });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// Hard delete (permanent)
exports.remove = async (req, res) => {
  try {
    const policy = await CancellationPolicy.findByIdAndDelete(req.params.id);
    if (!policy) return res.status(404).json({ success: false, message: 'Policy not found' });
    res.status(200).json({ success: true, message: 'Policy permanently deleted' });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};