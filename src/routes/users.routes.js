const express = require('express');
const router = express.Router();

const userController = require('../controllers/user.controller');
const auth = require('../middlewares/auth');
const authAdmin = require('../middlewares/authAdmin');
const rejectSensitiveBodyFields = require('../middlewares/rejectSensitiveBodyFields');

router.get('/me', auth, userController.me); // Get current authenticated user

router.put('/preferences', auth, rejectSensitiveBodyFields, userController.updatePreferences); // Update preferences

router.get('/preferences/analytics', auth, userController.getPreferenceAnalytics); // Get user preference analytics

router.put('/profile', auth, rejectSensitiveBodyFields, userController.updateProfile); // Update basic profile

router.get('/:id', authAdmin, userController.get); // Admin: get user by ID

router.patch('/:id/deactivate', authAdmin, userController.deactivate); // Admin: soft delete user

router.patch('/:id/restore', authAdmin, userController.restore); // Admin: restore user

router.delete('/:id', authAdmin, userController.remove); // Admin: hard delete user

module.exports = router;
