const express = require('express');
const router = express.Router();

const googlePlacesController = require('../controllers/google-places.controller');

router.get('/autocomplete', googlePlacesController.autocomplete);
router.get('/top-activities', googlePlacesController.getTopActivities);
router.get('/details/:placeId', googlePlacesController.getPlaceDetails);
router.get('/lookup/:placeId', googlePlacesController.getPlaceLookup);
router.get('/reverse-geocode', googlePlacesController.reverseGeocode);
router.get('/photo', googlePlacesController.getPlacePhoto);

module.exports = router;
