const { Router } = require('express');
const paywallVariantsController = require('../controllers/paywall-variants.controller');

const router = Router();

router.get('/resolve', paywallVariantsController.resolve);

module.exports = router;
