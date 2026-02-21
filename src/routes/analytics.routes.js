const { Router } = require('express');
const rateLimit = require('express-rate-limit');
const authOptional = require('../middlewares/authOptional');
const analyticsController = require('../controllers/analytics.controller');

const router = Router();
const eventsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/events', eventsLimiter, authOptional, analyticsController.track);

module.exports = router;
