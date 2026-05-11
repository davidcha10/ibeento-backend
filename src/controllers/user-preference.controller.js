const mongoose = require('mongoose');
const UserPreference = require('../models/UserPreference');

const ALLOWED_ACTIVITY_TYPES = new Set([
  'culture', 'entertainment', 'food_drinks', 'nature', 'shopping', 'wellness',
]);

/**
 * GET /api/user-preferences/me
 */
exports.getMyPreferences = async (req, res) => {
  try {
    const rawUserId = req.user?._id || req.query.userId || req.body.userId;
    if (!rawUserId) {
      return res.status(401).json({ success: false, message: 'User not authenticated' });
    }

    const userId = typeof rawUserId === 'string'
      ? new mongoose.Types.ObjectId(rawUserId)
      : rawUserId;

    const preferences = await UserPreference.findOne({ userId }).lean();
    return res.status(200).json({ success: true, data: preferences || null });
  } catch (err) {
    console.error('[UserPreference] getMyPreferences error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch user preferences', error: err.message });
  }
};

/**
 * PUT /api/user-preferences/me
 */
exports.upsertMyPreferences = async (req, res) => {
  try {
    const rawUserId = req.user?._id || req.body.userId;
    if (!rawUserId) {
      return res.status(401).json({ success: false, message: 'User not authenticated' });
    }

    const userId = typeof rawUserId === 'string'
      ? new mongoose.Types.ObjectId(rawUserId)
      : rawUserId;

    const { favoriteActivityTypes, pace, budgetLevel, activityWindow, travelCompanion } = req.body;
    const update = { userId };

    if (Array.isArray(favoriteActivityTypes)) {
      update.favoriteActivityTypes = favoriteActivityTypes
        .map((v) => String(v || '').trim().toLowerCase())
        .filter((v) => ALLOWED_ACTIVITY_TYPES.has(v));
    }

    if (typeof pace === 'number' && Number.isFinite(pace)) {
      update.pace = Math.max(1, Math.min(10, Math.round(pace)));
    }

    if (typeof budgetLevel === 'number' && Number.isFinite(budgetLevel)) {
      update.budgetLevel = Math.max(1, Math.min(10, Math.round(budgetLevel)));
    }

    const normalizedCompanion = String(travelCompanion || '').trim().toLowerCase();
    if (['solo', 'partner', 'friends', 'family'].includes(normalizedCompanion)) {
      update.travelCompanion = normalizedCompanion;
    }

    if (activityWindow && typeof activityWindow === 'object') {
      const startHour = Number(activityWindow.startHour);
      const endHour = Number(activityWindow.endHour);
      const durationHours = Number(activityWindow.durationHours);

      if (Number.isFinite(startHour) && Number.isFinite(endHour)) {
        const safeStart = Math.max(0, Math.min(24, startHour));
        const safeEnd = Math.max(0, Math.min(24, endHour));
        const normalizedStart = Math.min(safeStart, safeEnd);
        const normalizedEnd = Math.max(safeStart, safeEnd);
        update.activityWindow = {
          startHour: normalizedStart,
          endHour: normalizedEnd,
          durationHours: Number.isFinite(durationHours)
            ? Math.max(0, Math.min(24, durationHours))
            : normalizedEnd - normalizedStart,
        };
      }
    }

    const preferences = await UserPreference.findOneAndUpdate(
      { userId },
      { $set: update },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean();

    return res.status(200).json({ success: true, data: preferences });
  } catch (err) {
    console.error('[UserPreference] upsertMyPreferences error:', err);
    return res.status(500).json({ success: false, message: 'Failed to save user preferences', error: err.message });
  }
};
