const express = require('express');
const router = express.Router();

const businessUnitController = require('../controllers/business-unit.controller');

// Business Unit routes
router.post('/', businessUnitController.createBusinessUnit);
router.get('/', businessUnitController.getBusinessUnits);
router.get('/:id', businessUnitController.getBusinessUnitById);
router.patch('/:id', businessUnitController.updateBusinessUnit);
router.delete('/:id', businessUnitController.deleteBusinessUnit);

module.exports = router;