const mongoose = require('mongoose');

const { Schema } = mongoose;

const UserPreferenceSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    favoriteActivityTypes: [{ type: String, enum: ['culture', 'entertainment', 'food_drinks', 'nature', 'shopping', 'wellness'] }],
    pace: { type: Number },
    budgetLevel: { type: Number },
    wakeUpTime: { type: String, trim: true },
    sleepTime: { type: String, trim: true },
    transportPreference: {
      methods: [{ type: String, trim: true }],
      priority: { type: String, enum: ['velocity', 'cost', 'comfort', 'balanced'], default: 'cost' },
    },
    foodRestrictions: [{ type: String, trim: true }],
    avoid: [{ type: String, trim: true }],
  },
  { timestamps: true }
);

module.exports = mongoose.model('UserPreference', UserPreferenceSchema);
