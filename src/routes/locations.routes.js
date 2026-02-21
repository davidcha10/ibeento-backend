const express = require('express');
const router = express.Router();

const locationController = require('../controllers/location.controller');

// Sugerencias de destinos (BD + Google)
router.get('/suggest', locationController.suggest);

// Resolver/crear una Location a partir de un placeId de Google
router.post('/resolve', locationController.resolve);

module.exports = router;
