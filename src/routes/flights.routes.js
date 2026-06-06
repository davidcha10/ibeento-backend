const { Router } = require('express');
const ctrl = require('../controllers/flight.controller');

const router = Router();

router.get('/lookup', ctrl.lookupByNumber);

module.exports = router;
