const express = require('express');
const router = express.Router();

const activityController = require('../controllers/activity.controller');
const activityCommentController = require('../controllers/activity-comment.controller');
const serviceController = require('../controllers/service.controller');
const auth = require('../middlewares/auth');

// Activities routes
// Discover activities based on multiple locations
router.post('/discover', activityController.discover);
router.post('/discover-preview', activityController.discoverPreview);
router.post('/discover-preview/jobs', activityController.discoverPreviewStartJob);
router.get('/discover-preview/jobs/:jobId', activityController.discoverPreviewJobStatus);
router.get('/discover-preview/jobs/:jobId/result', activityController.discoverPreviewJobResult);
router.post('/discover-preview-suggest', activityController.discoverPreviewSuggest);
router.post('/discover-preview-one', activityController.discoverPreviewOne);
router.post('/import/social/preview', activityController.previewSocialActivities);
router.post('/import/social', auth, activityController.importSocialActivities);
router.post('/wikidata/draft', auth, activityController.previewWikidataActivityDraft);
router.post('/:id/acquire', auth, activityController.acquireOwnership);
router.post('/:id/accept-import', auth, activityController.acceptImportedActivity);
router.post('/:id/upsert-names-slugs-from-wikidata', auth, activityController.upsertNamesSlugsFromWikidata);
router.get('/:id/comments', activityCommentController.listByActivity);
router.post('/:id/comments', auth, activityCommentController.createForActivity);
router.get('/:id/services', serviceController.listByActivity);
router.post('/:id/services', auth, serviceController.createForActivity);
router.post('/', auth, activityController.create);                 // Crear nueva actividad
router.get('/', activityController.list);                    // Listar actividades (filtros: q,type,countryId,regionId,cityId,...)
router.get('/:id', activityController.get);                  // Obtener una actividad por ID
router.patch('/:id', auth, activityController.update);             // Actualizar actividad
router.patch('/:id/deactivate', auth, activityController.deactivate); // Desactivar (delete lógico)
router.patch('/:id/restore', auth, activityController.restore);    // Restaurar actividad desactivada
router.delete('/:id', auth, activityController.remove);            // Eliminación real

module.exports = router;
