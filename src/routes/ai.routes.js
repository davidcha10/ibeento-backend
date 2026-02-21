const express = require('express');
const router = express.Router();

const auth = require('../middlewares/auth');
const aiController = require('../controllers/ai.controller');

// AI routes (authenticated)
router.post('/itinerary', auth, aiController.generateItinerary);

module.exports = router;
