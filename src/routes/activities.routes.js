const express = require('express');
const router = express.Router();

const activityController = require('../controllers/activity.controller');
const serviceController = require('../controllers/service.controller');

// Activities routes
// Discover activities based on multiple locations
router.post('/discover', activityController.discover);
router.post('/discover-preview', activityController.discoverPreview);
router.post('/discover-preview-suggest', activityController.discoverPreviewSuggest);
router.post('/discover-preview-one', activityController.discoverPreviewOne);
router.get('/:id/services', serviceController.listByActivity);
router.post('/:id/services', serviceController.createForActivity);
router.post('/', activityController.create);                 // Crear nueva actividad
router.get('/', activityController.list);                    // Listar actividades (filtros: q,type,countryId,regionId,cityId,...)
router.get('/:id', activityController.get);                  // Obtener una actividad por ID
router.patch('/:id', activityController.update);             // Actualizar actividad
router.patch('/:id/deactivate', activityController.deactivate); // Desactivar (delete lógico)
router.patch('/:id/restore', activityController.restore);    // Restaurar actividad desactivada
router.delete('/:id', activityController.remove);            // Eliminación real

module.exports = router;
