const mongoose = require('mongoose');
const { Schema } = mongoose;

const complianceCredentialSchema = new Schema(
  {
    // Free-form identifier of the target integration/vendor (e.g. "SIRE", "TRA").
    provider: { type: String, trim: true, uppercase: true, default: null },
    // Human-friendly label for admin UIs (e.g. "Secure code", "Account code").
    label: { type: String, trim: true, default: null },
    // Optional plaintext value for non-sensitive or local/dev usage.
    value: { type: String, trim: true, default: null },
    // Optional encrypted blob for production secrets.
    encryptedValue: { type: String, trim: true, default: null },
    // Helps UIs decide whether to mask and treat as secret.
    isSecret: { type: Boolean, default: true },
    // Rotation/version metadata for scalable credential lifecycle.
    version: { type: Number, min: 1, default: 1 },
    updatedAt: { type: Date, default: Date.now },
    rotatedAt: { type: Date, default: null },
  },
  { _id: false }
);

const complianceBusinessUnitFieldSchema = new Schema(
  {
    path: { type: String, required: true, trim: true },
    required: { type: Boolean, default: false },
    appliesTo: {
      type: String,
      enum: ['main_guest', 'all_guests'],
      default: 'all_guests',
    },
    packs: [{ type: String, trim: true, uppercase: true }],
  },
  { _id: false }
);

const teamMemberSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    email: { type: String, trim: true, lowercase: true, match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ },
    name: { type: String, trim: true, default: null },
    role: { type: String, enum: ['owner', 'admin', 'operator', 'viewer'], default: 'viewer' },
    status: { type: String, enum: ['invited', 'active', 'inactive'], default: 'invited' },
    invitedAt: { type: Date, default: Date.now },
    acceptedAt: { type: Date, default: null },
  },
  { _id: false }
);

const systemAlertSchema = new Schema(
  {
    code: { type: String, trim: true, required: true },
    title: { type: String, trim: true, required: true },
    message: { type: String, trim: true, required: true },
    serviceId: { type: Schema.Types.ObjectId, ref: 'Service', default: null },
    serviceName: { type: String, trim: true, default: null },
    activityId: { type: Schema.Types.ObjectId, ref: 'Activity', default: null },
    sourceActivityName: { type: String, trim: true, default: null },
    replacementActivityId: { type: Schema.Types.ObjectId, ref: 'Activity', default: null },
    replacementActivityName: { type: String, trim: true, default: null },
    deleteAfterAt: { type: Date, default: null },
    readAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const BusinessUnitSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true }, // propietario
    entityType: { type: String, enum: ['individual', 'business'] ,default: 'individual' }, // true = empresa, false = individual
    teamMembers: { type: [teamMemberSchema], default: [] },

    businessType: {
      type: String,
      enum: ['accommodation', 'experience', 'food_drinks', 'transport', 'practical_services'],
      index: true,
    },

    businessCategory: { type: String, trim: true }, // hotel, restaurant, tour company, etc.
    businessName: { type: String, trim: true },
    placeCreation: {
      placeName: { type: String, trim: true, default: null },
      placeDescription: { type: String, trim: true, default: null },
    },
    serviceCoverageMode: {
      type: String,
      enum: ['fixed_place', 'zone_based', 'no_fixed_place'],
      default: 'fixed_place',
      index: true,
    },
    description: { type: String, trim: true },
    logo: { type: String, trim: true },

    locationData: {
      address: { type: String, trim: true },
      timeZone: { type: String, trim: true, default: null },
      primaryZoneId: { type: Schema.Types.ObjectId, ref: 'Zone', index: true },
      coverageZoneIds: [{ type: Schema.Types.ObjectId, ref: 'Zone' }],
      geo: {
        type: { type: String, enum: ['Point'], default: 'Point' },
        coordinates: { type: [Number], index: '2dsphere' },
        details: {type: String, trim: true}
      },
    },


    contact: {
      phone: { type: String, match: /^[0-9+\-() ]{7,20}$/ },
      email: { type: String, match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ },
    },

    compliance: {
      enabledPackCodes: [{ type: String, trim: true, uppercase: true }],
      dataTreatment: {
        enabled: { type: Boolean, default: true },
        policyUrl: { type: String, trim: true, default: null },
        customText: { type: String, trim: true, default: null },
      },
      apartmentRules: {
        enabled: { type: Boolean, default: true },
        policyUrl: { type: String, trim: true, default: null },
        customText: { type: String, trim: true, default: null },
      },
      fieldApplicability: {
        // Stored as a plain object because field paths contain dots
        // (e.g. "guests[].dateOfBirth"), which are not compatible with Mongoose Map keys.
        // The API may also persist it as an array of { path, appliesTo } entries.
        type: Schema.Types.Mixed,
        default: {},
      },
      // Source of truth for guest data requirements in this BU.
      // Syncs from enabled compliance packs and persists resolved rules.
      fields: {
        type: [complianceBusinessUnitFieldSchema],
        default: [],
      },
      // Scalable credential store for compliance integrations.
      // Key examples:
      // - "SIRE_secureCode"
      // - "SIRE_accountCode"
      // - "TRA_apiToken"
      credentials: {
        type: Map,
        of: complianceCredentialSchema,
        default: {},
      },
    },

    systemAlerts: {
      type: [systemAlertSchema],
      default: [],
    },

    media: [{
      url: { type: String, required: true, trim: true, match: /^https?:\/\/.+/ },
      type: { type: String, enum: ['image','video'], default: 'image' },
      category: { type: String, enum: ['cover','gallery','menu','room','promo','other'], default: 'gallery' },
      caption: { type: String, trim: true },
      order: { type: Number, default: 0 }
    }],

    isVerified: { type: Boolean, default: false },
    status: { type: String, enum: ['draft','active', 'inactive', 'suspended'], default: 'active' },
  },
  { timestamps: true, minimize: false }
);

// Indexes for optimized queries
BusinessUnitSchema.index({ user: 1, businessType: 1 });
BusinessUnitSchema.index({ 'teamMembers.userId': 1 });
BusinessUnitSchema.index({ 'teamMembers.email': 1 });

module.exports = mongoose.model('BusinessUnit', BusinessUnitSchema);
