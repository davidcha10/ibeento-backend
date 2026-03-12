// models/Activity.js
const { Schema, model, Types } = require('mongoose');

function slugify(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function toPlainLocaleMap(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  if (raw instanceof Map) return Object.fromEntries(raw.entries());
  return { ...raw };
}

function sanitizeLocaleStringMap(raw = {}, { slug = false } = {}) {
  const input = toPlainLocaleMap(raw);
  const out = {};
  for (const [localeRaw, valueRaw] of Object.entries(input)) {
    const locale = String(localeRaw || '').trim();
    if (!locale) continue;
    const value = slug ? slugify(valueRaw || '') : String(valueRaw || '').trim();
    if (!value) continue;
    out[locale] = value;
  }
  return out;
}

function firstLocaleValue(mapObj = {}) {
  for (const value of Object.values(mapObj || {})) {
    const normalized = String(value || '').trim();
    if (normalized) return normalized;
  }
  return '';
}

function normalizeLocalizedNames(rawNames = {}, fallbackName = '') {
  const names = sanitizeLocaleStringMap(rawNames, { slug: false });
  const safeFallback = String(fallbackName || '').trim();
  if (!names.en && safeFallback) names.en = safeFallback;
  return names;
}

function normalizeLocalizedSlugs(rawSlugs = {}, namesObj = {}, fallbackSlug = '') {
  const slugs = sanitizeLocaleStringMap(rawSlugs, { slug: true });
  for (const [locale, value] of Object.entries(namesObj || {})) {
    const safeLocale = String(locale || '').trim();
    if (!safeLocale || slugs[safeLocale]) continue;
    const derived = slugify(value || '');
    if (derived) slugs[safeLocale] = derived;
  }
  const safeFallback = slugify(fallbackSlug || '');
  if (!slugs.en && safeFallback) slugs.en = safeFallback;
  return slugs;
}

const activitySchema = new Schema({

    name: { type: String, required: true, trim: true },
    names: {
      type: Map,
      of: String,
      default: {},
    },
    slug: { type: String, required: true, unique: true, trim: true },
    slugs: {
      type: Map,
      of: String,
      default: {},
    },
    description: { type: String, trim: true },
    type: {
      type: String,
      enum: ['accommodation', 'experience', 'food_drinks', 'transport', 'practical_services', 'place'],
      default: 'experience',
      index: true,
    },
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

    // External reference is mandatory for all activities.
    externalRef: {
      provider: {
        type: String,
        enum: ['wikidata', 'google', 'manual'],
        trim: true,
        required: true,
      },
      id: { type: String, trim: true },
      url: { type: String, trim: true },
    },

    ownership: {
      mode: {
        type: String,
        enum: ['global', 'business_unit'],
        default: 'global',
        index: true,
      },
      businessUnitId: { type: Types.ObjectId, ref: 'BusinessUnit', default: null, index: true },
      createdFromServiceId: { type: Types.ObjectId, ref: 'Service', default: null },
    },

    orphanCleanup: {
      pendingDeletion: { type: Boolean, default: false, index: true },
      deleteAfterAt: { type: Date, default: null, index: true },
      sourceServiceId: { type: Types.ObjectId, ref: 'Service', default: null },
      replacementActivityId: { type: Types.ObjectId, ref: 'Activity', default: null },
      replacementActivityName: { type: String, trim: true, default: null },
      lastNotifiedAt: { type: Date, default: null },
      reason: { type: String, trim: true, default: null },
    },

}, { timestamps: true });

activitySchema.pre('validate', function (next) {
  const namesSeed = sanitizeLocaleStringMap(this.names, { slug: false });
  const slugsSeed = sanitizeLocaleStringMap(this.slugs, { slug: true });

  const currentName = String(this.name || '').trim();
  const derivedName = currentName || String(namesSeed.en || firstLocaleValue(namesSeed) || '').trim();
  if (derivedName) this.name = derivedName;

  const normalizedNames = normalizeLocalizedNames(namesSeed, derivedName);
  this.names = normalizedNames;

  const currentSlug = slugify(this.slug || '');
  const derivedSlug =
    currentSlug ||
    String(slugsSeed.en || firstLocaleValue(slugsSeed) || '').trim() ||
    slugify(derivedName);
  if (derivedSlug) this.slug = derivedSlug;

  const normalizedSlugs = normalizeLocalizedSlugs(slugsSeed, normalizedNames, derivedSlug);
  this.slugs = normalizedSlugs;

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

activitySchema.pre('findOneAndUpdate', function normalizeUpdate(next) {
  const update = this.getUpdate() || {};
  const hasOperators = Object.keys(update).some((key) => key.startsWith('$'));
  const target = hasOperators ? { ...(update.$set || {}) } : { ...update };

  if (Object.prototype.hasOwnProperty.call(target, 'name')) {
    target.name = String(target.name || '').trim();
  }

  if (Object.prototype.hasOwnProperty.call(target, 'slug')) {
    target.slug = slugify(target.slug || target.name || '');
  }

  const hasNames = Object.prototype.hasOwnProperty.call(target, 'names');
  const hasSlugs = Object.prototype.hasOwnProperty.call(target, 'slugs');

  let normalizedNames = null;
  if (hasNames) {
    normalizedNames = normalizeLocalizedNames(target.names, target.name || '');
    target.names = normalizedNames;
  }

  if (hasSlugs) {
    target.slugs = normalizeLocalizedSlugs(target.slugs, normalizedNames || {}, target.slug || '');
  } else if (hasNames) {
    target.slugs = normalizeLocalizedSlugs({}, normalizedNames || {}, target.slug || '');
  }

  if (hasOperators) {
    this.setUpdate({
      ...update,
      $set: target,
    });
  } else {
    this.setUpdate(target);
  }

  next();
});

activitySchema.methods.getDisplayName = function getDisplayName(locale) {
  if (this.names && this.names.get && this.names.get(locale)) {
    return this.names.get(locale);
  }
  return this.name;
};

activitySchema.methods.getDisplaySlug = function getDisplaySlug(locale) {
  if (this.slugs && this.slugs.get && this.slugs.get(locale)) {
    return this.slugs.get(locale);
  }
  return this.slug;
};

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
      'externalRef.provider': { $type: 'string' },
      'externalRef.id': { $type: 'string' },
    },
  }
);
activitySchema.index({ 'ownership.mode': 1, 'ownership.businessUnitId': 1, active: 1 });
activitySchema.index({ 'orphanCleanup.pendingDeletion': 1, 'orphanCleanup.deleteAfterAt': 1 });

module.exports = model('Activity', activitySchema);
