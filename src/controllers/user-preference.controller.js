const mongoose = require('mongoose');
const UserPreference = require('../models/UserPreference');

const ALLOWED_TRANSPORT_PRIORITIES = new Set([
  'velocity',
  'cost',
  'comfort',
  'balanced',
]);

/**
 * Get preferences for the authenticated user (or explicit userId for testing).
 * GET /api/user-preferences/me
 */
exports.getMyPreferences = async (req, res) => {
  try {
    const rawUserId = req.user?._id || req.query.userId || req.body.userId;

    if (!rawUserId) {
      return res
        .status(401)
        .json({ success: false, message: 'User not authenticated' });
    }

    const userId =
      typeof rawUserId === 'string'
        ? new mongoose.Types.ObjectId(rawUserId)
        : rawUserId;

    const preferences = await UserPreference.findOne({ userId }).lean();

    return res.status(200).json({
      success: true,
      data: preferences || null,
    });
  } catch (err) {
    console.error('[UserPreference] getMyPreferences error:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch user preferences',
      error: err.message,
    });
  }
};

/**
 * Create or update preferences for the authenticated user.
 * PUT /api/user-preferences/me
 */
exports.upsertMyPreferences = async (req, res) => {
  try {
    const rawUserId = req.user?._id || req.body.userId;

    if (!rawUserId) {
      return res
        .status(401)
        .json({ success: false, message: 'User not authenticated' });
    }

    const userId =
      typeof rawUserId === 'string'
        ? new mongoose.Types.ObjectId(rawUserId)
        : rawUserId;

    // Only pick the allowed fields from the body
    const {
      favoriteActivityTypes,
      pace,
      budgetLevel,
      wakeUpTime,
      sleepTime,
      transportPreference,
      foodRestrictions,
      avoid,
    } = req.body;

    const update = { userId };

    if (Array.isArray(favoriteActivityTypes)) {
      update.favoriteActivityTypes = favoriteActivityTypes;
    }

    if (typeof pace === 'number') {
      update.pace = pace;
    }

    if (typeof budgetLevel === 'number') {
      update.budgetLevel = budgetLevel;
    }

    if (typeof wakeUpTime === 'string') {
      update.wakeUpTime = wakeUpTime.trim();
    }

    if (typeof sleepTime === 'string') {
      update.sleepTime = sleepTime.trim();
    }

    if (
      transportPreference &&
      typeof transportPreference === 'object'
    ) {
      const tp = {};

      if (Array.isArray(transportPreference.methods)) {
        tp.methods = transportPreference.methods
          .map((method) => String(method || '').trim())
          .filter(Boolean);
      }

      if (typeof transportPreference.priority === 'string') {
        const normalizedPriority = String(transportPreference.priority || '')
          .trim()
          .toLowerCase();
        if (ALLOWED_TRANSPORT_PRIORITIES.has(normalizedPriority)) {
          tp.priority = normalizedPriority;
        }
      }

      if (Object.keys(tp).length) {
        update.transportPreference = tp;
      }
    }

    if (Array.isArray(foodRestrictions)) {
      update.foodRestrictions = foodRestrictions;
    }

    if (Array.isArray(avoid)) {
      update.avoid = avoid;
    }

    const preferences = await UserPreference.findOneAndUpdate(
      { userId },
      { $set: update },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
      }
    ).lean();

    return res.status(200).json({
      success: true,
      data: preferences,
    });
  } catch (err) {
    console.error('[UserPreference] upsertMyPreferences error:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to save user preferences',
      error: err.message,
    });
  }
};
