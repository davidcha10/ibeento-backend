

const ServiceCategory = require('../models/serviceCategory');

// Create service category
exports.createServiceCategory = async (req, res) => {
  try {
    const category = new ServiceCategory(req.body);
    await category.save();
    res.status(201).json({ success: true, category });
  } catch (error) {
    console.error('Error creating Service Category:', error);
    res.status(400).json({ success: false, message: error.message });
  }
};

// List service categories with optional filters
exports.listServiceCategories = async (req, res) => {
  try {
    const { businessType, businessCategoryId, isActive } = req.query;
    const filter = {};

    if (businessType) filter.businessType = businessType;
    if (businessCategoryId) filter.businessCategories = businessCategoryId;
    if (isActive !== undefined) filter.isActive = isActive === 'true';

    const categories = await ServiceCategory.find(filter).populate('businessCategories');
    res.status(200).json({ success: true, categories });
  } catch (error) {
    console.error('Error listing Service Categories:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Get single service category
exports.getServiceCategoryById = async (req, res) => {
  try {
    const category = await ServiceCategory.findById(req.params.id).populate('businessCategories');
    if (!category) return res.status(404).json({ success: false, message: 'Service Category not found' });
    res.status(200).json({ success: true, category });
  } catch (error) {
    console.error('Error fetching Service Category:', error);
    res.status(400).json({ success: false, message: 'Invalid request' });
  }
};

// Update service category
exports.updateServiceCategory = async (req, res) => {
  try {
    const category = await ServiceCategory.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!category) return res.status(404).json({ success: false, message: 'Service Category not found' });
    res.status(200).json({ success: true, category });
  } catch (error) {
    console.error('Error updating Service Category:', error);
    res.status(400).json({ success: false, message: error.message });
  }
};

// Soft delete
exports.deleteServiceCategory = async (req, res) => {
  try {
    const category = await ServiceCategory.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
    if (!category) return res.status(404).json({ success: false, message: 'Service Category not found' });
    res.status(200).json({ success: true, message: 'Service Category deactivated', category });
  } catch (error) {
    console.error('Error deactivating Service Category:', error);
    res.status(400).json({ success: false, message: error.message });
  }
};

// Restore
exports.restoreServiceCategory = async (req, res) => {
  try {
    const category = await ServiceCategory.findByIdAndUpdate(req.params.id, { isActive: true }, { new: true });
    if (!category) return res.status(404).json({ success: false, message: 'Service Category not found' });
    res.status(200).json({ success: true, message: 'Service Category reactivated', category });
  } catch (error) {
    console.error('Error restoring Service Category:', error);
    res.status(400).json({ success: false, message: error.message });
  }
};

// Real delete
exports.removeServiceCategory = async (req, res) => {
  try {
    const category = await ServiceCategory.findByIdAndDelete(req.params.id);
    if (!category) return res.status(404).json({ success: false, message: 'Service Category not found' });
    res.status(200).json({ success: true, message: 'Service Category permanently removed' });
  } catch (error) {
    console.error('Error removing Service Category:', error);
    res.status(400).json({ success: false, message: error.message });
  }
};