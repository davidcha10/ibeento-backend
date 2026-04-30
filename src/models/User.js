const { Schema, model } = require('mongoose');

const USER_ROLES = ['user', 'admin'];
const USER_STATUS = ['active', 'pending_verification', 'blocked', 'deleted'];
const DOC_TYPES = ['dni', 'passport', 'id_card', 'other'];

const TripPreferencesSchema = new Schema(
  {
    pace: { type: String, enum: ['slow', 'balanced', 'packed'] },
    type: [
      {
        type: String, enum: ['romantic', 'family', 'friends', 'solo', 'business']
      }
    ],
    budget: {
      level: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
      preferredCurrency: { type: String, enum: ['USD', 'EUR', 'COP'], default: 'USD' },
      approxDailySpendUsd: { type: Number }
    },
    serviceCategories: [
      { type: Schema.Types.ObjectId, ref: 'ServiceCategory' }
    ],
    activityCategories: [
      { type: Schema.Types.ObjectId, ref: 'ActivityCategory' }
    ],
    preferredTransportMethods: [
      { type: String, enum: ['walk', 'taxi', 'bus', 'metro', 'bycicle'] }
    ],
    timeWindow: {
      startHour: { type: Number, min: 0, max: 24 },
      endHour: { type: Number, min: 0, max: 24 },
      durationHours: { type: Number, min: 0, max: 24 }
    }
  },
  { _id: false }
);

const PreferencesSchema = new Schema(
  {
    trip: { type: TripPreferencesSchema, default: {} },
  },
  { _id: false }
);

const userSchema = new Schema(
  {
    name: { type: String, trim: true, maxlength: 120 },

    passwordHash: { type: String, required: false },

    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 254 },
    phone: { type: String, trim: true, unique: true, sparse: true },

    emailVerifiedAt: { type: Date },
    phoneVerifiedAt: { type: Date },
    
    document: {
      type: { type: String, enum: DOC_TYPES },
      number: { type: String, trim: true, unique: true, sparse: true }
    },
    
    nationality: { type: String, trim: true },

    role: { type: String, enum: USER_ROLES, default: 'user', index: true }, // índice normal para filtrar rápido por rol
    isPro: { type: Boolean, default: false, index: true },
    stripeCustomerId: { type: String, trim: true, index: true, sparse: true },

    status: { type: String, enum: USER_STATUS, default: 'active', index: true }, // índice normal

    onboardingCompleted: { type: Boolean, default: false },

    lastLoginAt: { type: Date },

    providers: [{
      provider: { type: String, enum: ['google', 'apple'], required: true },
      providerId: { type: String, required: true, index: true }, // índice por providerId
      linkedAt: { type: Date, default: Date.now }
    }],

    onboarding: { type: Schema.Types.Mixed, default: null },

    preferences: { type: PreferencesSchema, default: {} }
  },
  { timestamps: true }
);

module.exports = model('User', userSchema);
module.exports.USER_ROLES = USER_ROLES;
module.exports.USER_STATUS = USER_STATUS;
module.exports.DOC_TYPES = DOC_TYPES;
