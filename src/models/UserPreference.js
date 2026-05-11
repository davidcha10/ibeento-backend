const mongoose = require('mongoose');

const { Schema } = mongoose;

const ActivityWindowSchema = new Schema(
  {
    startHour:    { type: Number, min: 0, max: 24 },
    endHour:      { type: Number, min: 0, max: 24 },
    durationHours:{ type: Number, min: 0, max: 24 },
  },
  { _id: false }
);

const UserPreferenceSchema = new Schema(
  {
    userId:               { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    favoriteActivityTypes:[{ type: String, enum: ['culture', 'entertainment', 'food_drinks', 'nature', 'shopping', 'wellness'] }],
    travelCompanion:      { type: String, enum: ['solo', 'partner', 'friends', 'family'], default: null },
    pace:                 { type: Number },
    budgetLevel:          { type: Number },
    activityWindow:       { type: ActivityWindowSchema, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('UserPreference', UserPreferenceSchema);
