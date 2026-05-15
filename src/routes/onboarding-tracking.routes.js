const { Router } = require('express');
const onboardingTrackingController = require('../controllers/onboarding-tracking.controller');

const router = Router();

router.get('/progress', onboardingTrackingController.getProgress);
router.put('/progress', onboardingTrackingController.upsertProgress);

module.exports = router;
