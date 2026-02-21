const express = require('express');
const router = express.Router();

const controller = require('../controllers/service-requirement-item.controller');

router.post('/', controller.createServiceRequirementItem);
router.get('/', controller.getServiceRequirementItems);
router.get('/:id', controller.getServiceRequirementItemById);
router.patch('/:id', controller.updateServiceRequirementItem);
router.patch('/:id/deactivate', controller.deactivateServiceRequirementItem);
router.patch('/:id/restore', controller.restoreServiceRequirementItem);
router.delete('/:id', controller.deleteServiceRequirementItem);

module.exports = router;