const express = require('express');
const router = express.Router();

const socialAreaController = require('../controllers/social-area.controller');

// CRUD básico
router.post('/', socialAreaController.createSocialArea);
router.get('/', socialAreaController.getSocialAreas);
router.get('/:id', socialAreaController.getSocialAreaById);
router.patch('/:id', socialAreaController.updateSocialArea);

// Delete lógico y restore
router.patch('/:id/deactivate', socialAreaController.deactivateSocialArea);
router.patch('/:id/restore', socialAreaController.restoreSocialArea);

// Eliminación real
router.delete('/:id', socialAreaController.deleteSocialArea);

module.exports = router;