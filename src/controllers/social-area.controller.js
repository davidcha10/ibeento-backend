const SocialArea = require('../models/SocialArea');

// Crear social area
exports.createSocialArea = async (req, res) => {
  try {
    const area = await SocialArea.create(req.body);
    res.status(201).json({ success: true, data: area });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// Listar social areas (con filtro opcional por isActive)
exports.getSocialAreas = async (req, res) => {
  try {
    const filter = {};
    if (req.query.isActive !== undefined) filter.isActive = req.query.isActive === 'true';

    const areas = await SocialArea.find(filter).sort({ order: 1 });
    res.status(200).json({ success: true, data: areas });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// Obtener por ID
exports.getSocialAreaById = async (req, res) => {
  try {
    const area = await SocialArea.findById(req.params.id);
    if (!area) return res.status(404).json({ success: false, message: 'Social area not found' });
    res.status(200).json({ success: true, data: area });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// Actualizar
exports.updateSocialArea = async (req, res) => {
  try {
    const area = await SocialArea.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true
    });
    res.status(200).json({ success: true, data: area });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// Delete lógico
exports.deactivateSocialArea = async (req, res) => {
  try {
    const area = await SocialArea.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
    res.status(200).json({ success: true, data: area });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// Restore
exports.restoreSocialArea = async (req, res) => {
  try {
    const area = await SocialArea.findByIdAndUpdate(req.params.id, { isActive: true }, { new: true });
    res.status(200).json({ success: true, data: area });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// Eliminación real
exports.deleteSocialArea = async (req, res) => {
  try {
    await SocialArea.findByIdAndDelete(req.params.id);
    res.status(200).json({ success: true, message: 'Social area permanently removed' });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};