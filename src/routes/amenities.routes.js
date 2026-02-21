const express = require('express');
const router = express.Router();

const amenityController = require('../controllers/amenity.controller');

router.post('/', amenityController.createAmenity);
router.get('/', amenityController.getAmenities);
router.get('/:id', amenityController.getAmenityById);
router.patch('/:id', amenityController.updateAmenity);
router.patch('/:id/deactivate', amenityController.deactivateAmenity);
router.patch('/:id/restore', amenityController.restoreAmenity);
router.delete('/:id', amenityController.deleteAmenity);

module.exports = router;