const SecurityComplianceItem = require('../models/SecurityComplianceItem');

// CREATE
exports.createItem = async (req, res) => {
  try {
    const item = await SecurityComplianceItem.create(req.body);
    return res.status(201).json({ success: true, data: item });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

// LIST
exports.getItems = async (req, res) => {
  try {
    const { businessType, isActive } = req.query;
    const filter = {};

    if (businessType) filter.businessType = businessType;
    if (isActive !== undefined) filter.isActive = isActive === 'true';

    const items = await SecurityComplianceItem.find(filter).sort({ order: 1 });
    return res.status(200).json({ success: true, data: items });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// GET BY ID
exports.getItemById = async (req, res) => {
  try {
    const item = await SecurityComplianceItem.findById(req.params.id);
    if (!item) return res.status(404).json({ success: false, message: 'Not found' });
    return res.status(200).json({ success: true, data: item });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// UPDATE
exports.updateItem = async (req, res) => {
  try {
    const item = await SecurityComplianceItem.findByIdAndUpdate(req.params.id, req.body, { new: true });
    return res.status(200).json({ success: true, data: item });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

// DELETE (logical)
exports.deleteItem = async (req, res) => {
  try {
    const item = await SecurityComplianceItem.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
    return res.status(200).json({ success: true, data: item });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

// REAL DELETE
exports.removeItem = async (req, res) => {
  try {
    await SecurityComplianceItem.findByIdAndDelete(req.params.id);
    return res.status(200).json({ success: true, message: 'Removed permanently' });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};