const ServiceRule = require('../models/ServiceRule');

// CREATE
exports.createServiceRule = async (req, res) => {
  try {
    const data = req.body;
    const newRule = await ServiceRule.create(data);
    res.status(201).json({ success: true, data: newRule });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// LIST with filters
exports.getServiceRules = async (req, res) => {
  try {
    const { businessType, isActive } = req.query;
    const query = {};

    if (businessType) query.businessTypes = { $in: businessType.split(',') };
    if (isActive !== undefined) query.isActive = isActive === 'true';

    const rules = await ServiceRule.find(query).sort({ order: 1 });
    res.status(200).json({ success: true, data: rules });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET ONE
exports.getServiceRuleById = async (req, res) => {
  try {
    const rule = await ServiceRule.findById(req.params.id);
    if (!rule) return res.status(404).json({ success: false, message: 'Not found' });
    res.status(200).json({ success: true, data: rule });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// UPDATE
exports.updateServiceRule = async (req, res) => {
  try {
    const rule = await ServiceRule.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.status(200).json({ success: true, data: rule });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// DEACTIVATE (soft delete)
exports.deactivateServiceRule = async (req, res) => {
  try {
    const rule = await ServiceRule.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
    res.status(200).json({ success: true, data: rule });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// RESTORE
exports.restoreServiceRule = async (req, res) => {
  try {
    const rule = await ServiceRule.findByIdAndUpdate(req.params.id, { isActive: true }, { new: true });
    res.status(200).json({ success: true, data: rule });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// DELETE REAL
exports.deleteServiceRule = async (req, res) => {
  try {
    await ServiceRule.findByIdAndDelete(req.params.id);
    res.status(200).json({ success: true, message: 'Deleted permanently' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};