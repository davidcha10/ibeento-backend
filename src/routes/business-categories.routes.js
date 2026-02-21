const express = require('express');
const router = express.Router();

const businessCategoryController = require('../controllers/business-category.controller');

// Business Category routes
router.post('/', businessCategoryController.create); // Crear nueva categoría
router.get('/', businessCategoryController.list); // Listar categorías (con filtro opcional ?businessType=)
router.get('/:id', businessCategoryController.get); // Obtener una categoría por ID
router.patch('/:id', businessCategoryController.update); // Actualizar categoría
router.patch('/:id/deactivate', businessCategoryController.deactivate); // Desactivar (delete lógico)
router.patch('/:id/restore', businessCategoryController.restore); // Restaurar categoría desactivada
router.delete('/:id', businessCategoryController.remove); // Eliminación real

module.exports = router;