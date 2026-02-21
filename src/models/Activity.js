// models/Activity.js
const { Schema, model, Types } = require('mongoose');

const activitySchema = new Schema({

    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, trim: true },
    description: { type: String, trim: true },
    activityCategoryIds: [{ type: Types.ObjectId, ref: 'ActivityCategory' }],
    tags: [{ type: Types.ObjectId, ref: 'ServiceTag' }],
    defaultDurationMin: {
      minMinutes: { type: Number },   // mínimo recomendado en minutos
      maxMinutes: { type: Number },   // máximo recomendado en minutos
      source: {
        type: String,
        enum: ['tags', 'ai', 'manual', 'provider', 'category'],
        default: 'tags',
      },
    },
    active: { type: Boolean, default: true },

    location: {

      primaryZoneId: { type: Types.ObjectId, ref: 'Zone' },
      zonePathIds: [{ type: Types.ObjectId, ref: 'Zone' }],
      timeZone:  { type: String, trim: true },
      address:   { type: String, trim: true },
      addresses: {
        type: Map,
        of: String,
        default: {},
      },
      addressSource: {
        type: String,
        enum: ['wikidata', 'nominatim', 'manual'],
        default: 'manual',
      },
      geo: {
        type: { type: String, enum: ['Point'] },
        coordinates: { type: [Number], index: '2dsphere' } // [lng, lat]
      },
      geoSource: {
        type: String,
        enum: ['wikidata', 'nominatim', 'manual'],
        default: 'manual',
      },
      geoConfidence: {
        type: String,
        enum: ['high', 'medium', 'low'],
        default: 'high',
      },
    },

    availability: {
        openingHours: {
          // Lightweight, editable structure for bootstrapped provider data + manual curation.
          openDays: [{ type: String, trim: true }], // e.g. ["all days of the week"] or ["Mon-Fri"]
          opensAt: { type: String, trim: true }, // e.g. "09:00"
          closesAt: { type: String, trim: true }, // e.g. "21:00"
          weeklySchedule: [{
            day: {
              type: String,
              enum: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'holiday'],
              required: true,
            },
            opensAt: { type: String, trim: true }, // HH:mm
            closesAt: { type: String, trim: true }, // HH:mm
            closed: { type: Boolean, default: false },
          }],
          lastEntryAt: { type: String, trim: true }, // e.g. "20:00"
          rawText: { type: String, trim: true }, // free text fallback for provider payloads
          source: {
            type: String,
            enum: ['wikidata', 'google', 'manual', 'provider', 'fallback', 'unknown'],
            default: 'unknown',
          },
          confidence: {
            type: String,
            enum: ['high', 'medium', 'low'],
            default: 'low',
          },
          notes: { type: String, trim: true },
          updatedAt: { type: Date },
        },
        blackoutDates: [{
          startDate: { type: String, required: true, trim: true },  // first day the activity is closed (UTC ISO string)
          endDate:   { type: String, trim: true },                  // optional last day (UTC ISO string; if omitted, only startDate is closed)
          reason:    { type: String, trim: true },                  // optional description (maintenance, holidays, etc.)
        }],

    },

    pricing: {

        currency: { type: String, trim: true },                  // ISO 4217 code, e.g. "USD", "EUR", "COP"
        priceFrom: { type: Number },                             // minimum known price for the activity
        priceTo: { type: Number },                               // optional upper bound (e.g. seasonal or tiered pricing)
        pricingModel: {
          type: String,
          enum: ['per_person', 'per_group', 'per_night', 'free', 'unknown'],
          default: 'unknown',
        },                                                       // how the price should be interpreted
        source: {
          type: String,
          enum: ['provider', 'manual', 'ai'],
          default: 'manual',
        },                                                       // where this pricing data came from

    },

    purchaseHint: {
      requiresTicket: { type: Boolean, default: false },
      message: { type: String, trim: true },
      ctaLabel: { type: String, trim: true },
    },

    media: {

        cover: {type: String, trim: true},
        images: [{
            url:     { type: String, required: true, trim: true },
            type:    { type: String, enum: ['image','video','other'], default: 'image' },
            caption: { type: String, trim: true },
            order:   { type: Number, default: 0 } 
        }],
    },

    ranking: {

        ratingAvg: { type: Number, default: 0 },
        reviewsCount: { type: Number, default: 0 },
        priority: { type: Number, default: 0 },

    },

    // Global admin audit status for activity quality control.
    audit: {
      isAudited: { type: Boolean, default: false, index: true },
      status: {
        type: String,
        enum: ['pending', 'approved', 'rejected'],
        default: 'pending',
      },
      auditedBy: { type: Types.ObjectId, ref: 'User' },
      auditedAt: { type: Date },
      notes: { type: String, trim: true },
    },

    // Optional external reference for provider-backed entities (e.g. Wikidata QID).
    // Manual activities can omit this entirely.
    externalRef: {
      provider: {
        type: String,
        enum: ['wikidata', 'google', 'manual'],
        trim: true,
      },
      id: { type: String, trim: true },
      url: { type: String, trim: true },
    },

}, { timestamps: true });

activitySchema.pre('validate', function (next) {
  const coords = this?.location?.geo?.coordinates;
  const type = this?.location?.geo?.type;
  const valid =
    type === 'Point' &&
    Array.isArray(coords) &&
    coords.length === 2 &&
    Number.isFinite(Number(coords[0])) &&
    Number.isFinite(Number(coords[1]));

  if (!valid) {
    return next(new Error('location.geo (Point with [lng, lat]) is required'));
  }
  return next();
});

activitySchema.index({ 'location.primaryZoneId': 1, 'ranking.priority': 1 });
activitySchema.index({ 'location.zonePathIds': 1, 'ranking.priority': 1 });
activitySchema.index({ 'audit.status': 1, 'audit.isAudited': 1 });
activitySchema.index({ 'location.geo': '2dsphere' });
activitySchema.index(
  { name: 'text', description: 'text' },
  { weights: { name: 5, description: 1 } }
);
activitySchema.index(
  { 'externalRef.provider': 1, 'externalRef.id': 1 },
  {
    unique: true,
    partialFilterExpression: {
      'externalRef.provider': { $exists: true, $ne: null },
      'externalRef.id': { $exists: true, $ne: null },
    },
  }
);

module.exports = model('Activity', activitySchema);
