const express = require('express');
const router = express.Router();
const exchangeRatesController = require('../controllers/exchange-rates.controller');

router.get('/latest', exchangeRatesController.getLatest);

module.exports = router;
