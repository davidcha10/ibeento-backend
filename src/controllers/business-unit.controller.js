const BusinessUnit = require('../models/BusinessUnit');

// Crear una nueva unidad de negocio
exports.createBusinessUnit = async (req, res) => {
  try {
    const data = req.body;
    
    // Manejar el caso en que el usuario venga como objeto completo o como string
    if (data.user && typeof data.user === 'object' && data.user._id) {
      data.user = data.user._id;
    }

    // Validación de seguridad
    if (!data.user) {
      return res.status(400).json({
        success: false,
        message: 'User ID is required to create a Business Unit.',
      });
    }

    const businessUnit = await BusinessUnit.create(data);
    res.status(201).json({ success: true, businessUnit });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: 'Error creating Business Unit',
      error: error.message,
    });
  }
};

// Obtener todas las unidades de negocio (con filtros opcionales)
exports.getBusinessUnits = async (req, res) => {
  try {
    const filters = {};
    if (req.query.user) filters.user = req.query.user;
    if (req.query.type) filters.businessType = req.query.type;
    if (req.query.cityId) filters['locationData.cityId'] = req.query.cityId;
    if (req.query.status) filters.status = req.query.status;

    const businessUnits = await BusinessUnit.find(filters)
      .populate('user', 'name email')
      .populate('locationData.cityId', 'name')
      .populate('locationData.regionId', 'name')
      .populate('locationData.countryId', 'name')
      .sort({ createdAt: -1 });

    res.json({ success: true, count: businessUnits.length, businessUnits });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Error fetching Business Units', error });
  }
};

// Obtener una unidad de negocio por ID
exports.getBusinessUnitById = async (req, res) => {
  try {
    const { id } = req.params;
    const businessUnit = await BusinessUnit.findById(id)
      .populate('user', 'name email')
      .populate('locationData.cityId', 'name')
      .populate('locationData.regionId', 'name')
      .populate('locationData.countryId', 'name');

    if (!businessUnit)
      return res.status(404).json({ success: false, message: 'Business Unit not found' });

    res.json({ success: true, businessUnit });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Error fetching Business Unit', error });
  }
};

// Actualizar una unidad de negocio
exports.updateBusinessUnit = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    const businessUnit = await BusinessUnit.findByIdAndUpdate(id, updates, { new: true });

    if (!businessUnit)
      return res.status(404).json({ success: false, message: 'Business Unit not found' });

    res.json({ success: true, message: 'Business Unit updated successfully', businessUnit });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Error updating Business Unit', error });
  }
};

// Eliminar (desactivar) una unidad de negocio
exports.deleteBusinessUnit = async (req, res) => {
  try {
    const { id } = req.params;
    const businessUnit = await BusinessUnit.findByIdAndUpdate(
      id,
      { status: 'inactive' },
      { new: true }
    );

    if (!businessUnit)
      return res.status(404).json({ success: false, message: 'Business Unit not found' });

    res.json({ success: true, message: 'Business Unit deactivated successfully', businessUnit });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Error deleting Business Unit', error });
  }
};