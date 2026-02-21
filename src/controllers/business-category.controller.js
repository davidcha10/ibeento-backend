const BusinessCategory = require('../models/businessCategory');

// Crear categoría
exports.create = async (req, res) => {
  try {
    const data = req.body;
    const category = await BusinessCategory.create(data);
    return res.status(201).json({ success: true, data: category });
  } catch (error) {
    console.error('Error creating Business Category:', error);
    return res.status(500).json({ success: false, message: 'Failed to create Business Category', error });
  }
};

// Listar categorías (con filtro opcional por businessType)
exports.list = async (req, res) => {
  try {
    const { businessType } = req.query;
    const filter = businessType ? { businessType } : {};
    const categories = await BusinessCategory.find(filter).sort({ order: 1 });
    return res.status(200).json({ success: true, data: categories });
  } catch (error) {
    console.error('Error fetching Business Categories:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch Business Categories', error });
  }
};

// Obtener una categoría por ID
exports.get = async (req, res) => {
  try {
    const { id } = req.params;
    const category = await BusinessCategory.findById(id);
    if (!category) {
      return res.status(404).json({ success: false, message: 'Business Category not found' });
    }
    return res.status(200).json({ success: true, data: category });
  } catch (error) {
    console.error('Error fetching Business Category:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch Business Category', error });
  }
};

// Actualizar categoría
exports.update = async (req, res) => {
  try {
    const { id } = req.params;
    const data = req.body;
    const updated = await BusinessCategory.findByIdAndUpdate(id, data, { new: true });
    if (!updated) {
      return res.status(404).json({ success: false, message: 'Business Category not found' });
    }
    return res.status(200).json({ success: true, data: updated });
  } catch (error) {
    console.error('Error updating Business Category:', error);
    return res.status(500).json({ success: false, message: 'Failed to update Business Category', error });
  }
};

// Desactivar (delete lógico)
exports.deactivate = async (req, res) => {
  try {
    const { id } = req.params;
    const updated = await BusinessCategory.findByIdAndUpdate(id, { isActive: false }, { new: true });
    if (!updated) {
      return res.status(404).json({ success: false, message: 'Business Category not found' });
    }
    return res.status(200).json({ success: true, data: updated });
  } catch (error) {
    console.error('Error deactivating Business Category:', error);
    return res.status(500).json({ success: false, message: 'Failed to deactivate Business Category', error });
  }
};

// Restaurar categoría desactivada
exports.restore = async (req, res) => {
  try {
    const { id } = req.params;
    const updated = await BusinessCategory.findByIdAndUpdate(id, { isActive: true }, { new: true });
    if (!updated) {
      return res.status(404).json({ success: false, message: 'Business Category not found' });
    }
    return res.status(200).json({ success: true, data: updated });
  } catch (error) {
    console.error('Error restoring Business Category:', error);
    return res.status(500).json({ success: false, message: 'Failed to restore Business Category', error });
  }
};

// Eliminación real
exports.remove = async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await BusinessCategory.findByIdAndDelete(id);
    if (!deleted) {
      return res.status(404).json({ success: false, message: 'Business Category not found' });
    }
    return res.status(200).json({ success: true, message: 'Business Category deleted permanently' });
  } catch (error) {
    console.error('Error deleting Business Category:', error);
    return res.status(500).json({ success: false, message: 'Failed to delete Business Category', error });
  }
};