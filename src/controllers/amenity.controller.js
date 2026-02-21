const Amenity = require('../models/Amenity');

// Create
exports.createAmenity = async (req, res) => {
  try {
    const amenity = await Amenity.create(req.body);
    return res.status(201).json({ success: true, data: amenity });
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message });
  }
};

// List (optional filter by businessType or isActive)
exports.getAmenities = async (req, res) => {
  try {
    const query = {};
    if (req.query.businessType) query.businessTypes = req.query.businessType;
    if (req.query.isActive !== undefined) query.isActive = req.query.isActive === 'true';

    const amenities = await Amenity.find(query).sort({ order: 1 });
    return res.json({ success: true, data: amenities });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// Get by ID
exports.getAmenityById = async (req, res) => {
  try {
    const amenity = await Amenity.findById(req.params.id);
    if (!amenity) return res.status(404).json({ success: false, message: 'Amenity not found' });

    return res.json({ success: true, data: amenity });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// Update (PATCH)
exports.updateAmenity = async (req, res) => {
  try {
    const amenity = await Amenity.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!amenity) return res.status(404).json({ success: false, message: 'Amenity not found' });

    return res.json({ success: true, data: amenity });
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message });
  }
};

// Soft Delete (set isActive = false)
exports.deactivateAmenity = async (req, res) => {
  try {
    const amenity = await Amenity.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
    return res.json({ success: true, data: amenity });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// Restore Soft Deleted amenity
exports.restoreAmenity = async (req, res) => {
  try {
    const amenity = await Amenity.findByIdAndUpdate(req.params.id, { isActive: true }, { new: true });
    return res.json({ success: true, data: amenity });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// Permanent Delete
exports.deleteAmenity = async (req, res) => {
  try {
    await Amenity.findByIdAndDelete(req.params.id);
    return res.json({ success: true, message: 'Amenity permanently deleted' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};