const express = require('express');
const router = express.Router();

const businessUnitController = require('../controllers/business-unit.controller');
const auth = require('../middlewares/auth');

// Business Unit routes
router.post('/', auth, businessUnitController.createBusinessUnit);
router.get('/', auth, businessUnitController.getBusinessUnits);
router.get('/:id/relevant-compliance-packs', auth, businessUnitController.getRelevantCompliancePacks);
router.get('/:id/sire-report-txt', auth, businessUnitController.downloadSireTxt);
router.get('/:id', auth, businessUnitController.getBusinessUnitById);
router.patch('/:id', auth, businessUnitController.updateBusinessUnit);
router.delete('/:id', auth, businessUnitController.deleteBusinessUnit);

module.exports = router;
