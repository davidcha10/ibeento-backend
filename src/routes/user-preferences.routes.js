const express = require('express');
const router = express.Router();

const auth = require('../middlewares/auth');
const userPreferenceController = require('../controllers/user-preference.controller');
const rejectSensitiveBodyFields = require('../middlewares/rejectSensitiveBodyFields');

// User Preferences Routes (authenticated)
router.get('/me', auth, userPreferenceController.getMyPreferences);      // Get my preferences
router.put('/me', auth, rejectSensitiveBodyFields, userPreferenceController.upsertMyPreferences);   // Create / update my preferences

module.exports = router;
