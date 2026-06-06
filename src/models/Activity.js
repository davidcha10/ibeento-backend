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

    name: { type: String, trim: true },
    nameSource: {
      type: String,
      enum: ['manual', 'source_claim', 'ai', 'open_data', 'google_cache'],
      default: 'manual',
      index: true,
    },
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
    visibility: {
      type: String,
      enum: ['public', 'imported_private', 'admin_review', 'hidden'],
      default: 'public',
      index: true,
    },

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
        enum: ['wikidata', 'nominatim', 'manual', 'google_cache'],
        default: 'manual',
      },
      geo: {
        type: { type: String, enum: ['Point'] },
        coordinates: { type: [Number], index: '2dsphere' } // [lng, lat]
      },
      geoSource: {
        type: String,
        enum: ['wikidata', 'nominatim', 'manual', 'google_cache'],
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

    accessHint: {
      requirement: {
        type: String,
        enum: [
          'unknown',
          'free',
          'ticket_required',
          'ticket_optional',
          'reservation_required',
          'reservation_recommended',
          'pay_on_site',
          'guided_service_available',
          'not_accessible',
        ],
        default: 'unknown',
      },
      priceIndication: {
        currency: { type: String, trim: true, uppercase: true },
        priceFrom: { type: Number },
        priceTo: { type: Number },
        note: { type: String, trim: true },
        purchaseUrl: { type: String, trim: true },
        rules: [{
          id: { type: String, trim: true },
          label: { type: String, trim: true },
          priceFrom: { type: Number },
          priceTo: { type: Number },
          unit: {
            type: String,
            enum: ['person', 'group', 'entry', 'night', 'other'],
          },
          conditions: {
            ageMin: { type: Number },
            ageMax: { type: Number },
            nationalityMode: { type: String, enum: ['all', 'include', 'exclude'], default: 'all' },
            nationalityCountryCodes: [{ type: String, trim: true, uppercase: true }],
            residencyMode: { type: String, enum: ['all', 'include', 'exclude'], default: 'all' },
            residencyCountryCodes: [{ type: String, trim: true, uppercase: true }],
            season: { type: String, enum: ['all', 'low', 'high', 'regular'], default: 'all' },
            dateRanges: [{
              start: { type: String, trim: true },
              end: { type: String, trim: true },
            }],
          },
          active: { type: Boolean, default: true },
        }],
      },
      message: { type: String, trim: true },
      confidence: {
        type: String,
        enum: ['high', 'medium', 'low'],
        default: 'low',
      },
      source: {
        type: String,
        enum: ['manual', 'ai', 'official', 'provider', 'wikidata', 'unknown'],
        default: 'unknown',
      },
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
        prioritySource: {
          type: String,
          enum: ['manual', 'category', 'google_cache_user_trend', 'user_trend', 'unknown'],
          default: 'unknown',
        },
        priorityFormulaVersion: { type: String, trim: true },

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
        enum: ['wikidata', 'google', 'manual', 'osm', 'official', 'social', 'social_import'],
        trim: true,
        required: true,
      },
      id: { type: String, trim: true },
      url: { type: String, trim: true },
    },

    sourceClaims: [{
      source: {
        type: String,
        enum: ['instagram', 'tiktok', 'social_import', 'wikidata', 'osm', 'official', 'manual', 'ai', 'unknown'],
        default: 'unknown',
        index: true,
      },
      url: { type: String, trim: true },
      externalId: { type: String, trim: true },
      extractedName: { type: String, trim: true },
      extractedContext: { type: String, trim: true },
      evidenceText: { type: String, trim: true },
      confidence: { type: Number, min: 0, max: 1 },
      status: {
        type: String,
        enum: ['pending', 'accepted', 'rejected', 'merged'],
        default: 'pending',
        index: true,
      },
      importedAt: { type: Date, default: Date.now },
      reviewedAt: { type: Date },
      reviewedBy: { type: Types.ObjectId, ref: 'User' },
      notes: { type: String, trim: true },
      socialProfile: {
        platform: { type: String, trim: true },
        handle: { type: String, trim: true },
        url: { type: String, trim: true },
        displayName: { type: String, trim: true },
        biography: { type: String, trim: true },
        category: { type: String, trim: true },
        externalUrl: { type: String, trim: true },
        isBusinessLike: { type: Boolean, default: false },
        fetchedAt: { type: Date },
      },
    }],

    googleCache: {
      placeId: { type: String, trim: true },
      status: {
        type: String,
        enum: ['active', 'expired', 'refresh_failed'],
        default: 'active',
        index: true,
      },
      fetchedAt: { type: Date },
      expiresAt: { type: Date, index: true },
      lastRefreshAt: { type: Date },
      lastPurgeAt: { type: Date },
      refreshCount: { type: Number, default: 0 },
      lastError: { type: String, trim: true },
      name: { type: String, trim: true },
      formattedAddress: { type: String, trim: true },
      geo: {
        type: { type: String, enum: ['Point'] },
        coordinates: { type: [Number] },
      },
      ratingAvg: { type: Number },
      reviewsCount: { type: Number },
      businessStatus: { type: String, trim: true },
      types: [{ type: String, trim: true }],
      photoUrl: { type: String, trim: true },
      coverUrl: { type: String, trim: true },
      googleMapsUri: { type: String, trim: true },
      openingHours: Schema.Types.Mixed,
      timeZone: { type: String, trim: true },
      fieldMask: [{ type: String, trim: true }],
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

  const googleCacheName = String(this.googleCache?.name || '').trim();

  // Require at least one of name or googleCache.name
  if (!derivedName && !googleCacheName) {
    return next(new Error('Activity must have a name or googleCache.name'));
  }

  const normalizedNames = normalizeLocalizedNames(namesSeed, derivedName);
  this.names = normalizedNames;

  const currentSlug = slugify(this.slug || '');
  const derivedSlug =
    currentSlug ||
    String(slugsSeed.en || firstLocaleValue(slugsSeed) || '').trim() ||
    slugify(derivedName) ||
    slugify(googleCacheName);
  if (derivedSlug) this.slug = derivedSlug;

  const normalizedSlugs = normalizeLocalizedSlugs(slugsSeed, normalizedNames, derivedSlug);
  this.slugs = normalizedSlugs;

  const coords = this?.location?.geo?.coordinates;
  const type = this?.location?.geo?.type;
  const cacheCoords = this?.googleCache?.geo?.coordinates;
  const cacheType = this?.googleCache?.geo?.type;
  const visibility = String(this?.visibility || '').trim();

  const valid =
    type === 'Point' &&
    Array.isArray(coords) &&
    coords.length === 2 &&
    Number.isFinite(Number(coords[0])) &&
    Number.isFinite(Number(coords[1]));
  // Accept googleCache.geo as valid geo regardless of visibility
  // (social imports get geo from Google Places, not from zone resolution)
  const validGoogleCache =
    cacheType === 'Point' &&
    Array.isArray(cacheCoords) &&
    cacheCoords.length === 2 &&
    Number.isFinite(Number(cacheCoords[0])) &&
    Number.isFinite(Number(cacheCoords[1]));

  if (!valid && !validGoogleCache) {
    return next(new Error('location.geo (Point with [lng, lat]) is required'));
  }
  return next();
});

// Computed display fields: use googleCache as fallback when name/media not yet curated
activitySchema.set('toJSON', {
  virtuals: true,
  transform(doc, ret) {
    ret.displayName = ret.name || ret.googleCache?.name || '';
    ret.displayPhoto = ret.media?.cover || ret.media?.images?.[0]?.url || ret.googleCache?.photoUrl || null;
    return ret;
  },
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
activitySchema.index({ 'sourceClaims.source': 1, 'sourceClaims.status': 1, active: 1 });
activitySchema.index({ visibility: 1, active: 1, 'audit.status': 1 });
activitySchema.index({ 'googleCache.expiresAt': 1, 'googleCache.status': 1 });
activitySchema.index({ 'location.geo': '2dsphere' });
activitySchema.index({ 'googleCache.geo': '2dsphere' }, { sparse: true });
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
activitySchema.index(
  { 'googleCache.placeId': 1 },
  {
    unique: true,
    partialFilterExpression: {
      'googleCache.placeId': { $type: 'string' },
    },
  }
);

module.exports = model('Activity', activitySchema);
