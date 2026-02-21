const PrivacyItem = require('../models/PrivacyItem');

// Create
exports.createPrivacyItem = async (req, res) => {
  try {
    const item = await PrivacyItem.create(req.body);
    res.status(201).json({ success: true, data: item });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// List
exports.getPrivacyItems = async (req, res) => {
  try {
    const items = await PrivacyItem.find({ deletedAt: null });
    res.json({ success: true, data: items });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// Get by ID
exports.getPrivacyItemById = async (req, res) => {
  try {
    const item = await PrivacyItem.findById(req.params.id);
    if (!item) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: item });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// Update
exports.updatePrivacyItem = async (req, res) => {
  try {
    const item = await PrivacyItem.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json({ success: true, data: item });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// Soft delete (deactivate)
exports.deactivatePrivacyItem = async (req, res) => {
  try {
    const item = await PrivacyItem.findByIdAndUpdate(req.params.id, { isActive: false, deletedAt: new Date() }, { new: true });
    res.json({ success: true, data: item });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// Restore
exports.restorePrivacyItem = async (req, res) => {
  try {
    const item = await PrivacyItem.findByIdAndUpdate(req.params.id, { isActive: true, deletedAt: null }, { new: true });
    res.json({ success: true, data: item });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// Hard delete
exports.deletePrivacyItem = async (req, res) => {
  try {
    await PrivacyItem.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Deleted permanently' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};