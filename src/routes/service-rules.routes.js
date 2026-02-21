const express = require('express');
const router = express.Router();

const serviceRuleController = require('../controllers/service-rule.controller');

router.post('/', serviceRuleController.createServiceRule);
router.get('/', serviceRuleController.getServiceRules);
router.get('/:id', serviceRuleController.getServiceRuleById);
router.patch('/:id', serviceRuleController.updateServiceRule);
router.patch('/:id/deactivate', serviceRuleController.deactivateServiceRule);
router.patch('/:id/restore', serviceRuleController.restoreServiceRule);
router.delete('/:id', serviceRuleController.deleteServiceRule);

module.exports = router;