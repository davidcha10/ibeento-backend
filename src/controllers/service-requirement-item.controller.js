const ServiceRequirementItem = require('../models/ServiceRequirementItem');

// Create
exports.createServiceRequirementItem = async (req, res) => {
  try {
    const item = await ServiceRequirementItem.create(req.body);
    res.status(201).json({ success: true, data: item });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// List
exports.getServiceRequirementItems = async (req, res) => {
  try {
    const query = { deletedAt: null };
    if (req.query.businessType) {
      const bt = req.query.businessType.split(',');
      query.businessTypes = { $in: bt };
    }
    const items = await ServiceRequirementItem.find(query).sort({ order: 1 });
    res.json({ success: true, data: items });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// Get by ID
exports.getServiceRequirementItemById = async (req, res) => {
  try {
    const item = await ServiceRequirementItem.findById(req.params.id);
    if (!item) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: item });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// Update
exports.updateServiceRequirementItem = async (req, res) => {
  try {
    const item = await ServiceRequirementItem.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json({ success: true, data: item });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// Deactivate (soft delete)
exports.deactivateServiceRequirementItem = async (req, res) => {
  try {
    const item = await ServiceRequirementItem.findByIdAndUpdate(
      req.params.id,
      { isActive: false, deletedAt: new Date() },
      { new: true }
    );
    res.json({ success: true, data: item });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// Restore
exports.restoreServiceRequirementItem = async (req, res) => {
  try {
    const item = await ServiceRequirementItem.findByIdAndUpdate(
      req.params.id,
      { isActive: true, deletedAt: null },
      { new: true }
    );
    res.json({ success: true, data: item });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// Delete permanently
exports.deleteServiceRequirementItem = async (req, res) => {
  try {
    await ServiceRequirementItem.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Deleted permanently' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};