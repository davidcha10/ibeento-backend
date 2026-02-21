const express = require('express');
const router = express.Router();

const googlePlacesController = require('../controllers/google-places.controller');

router.get('/photo', googlePlacesController.getPlacePhoto);

module.exports = router;
