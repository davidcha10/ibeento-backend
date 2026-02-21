const mongoose = require('mongoose');

const { Schema } = mongoose;

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

function normalizeNameKey(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

const ActivityCategorySchema = new Schema(
  {
    slug: { type: String, required: true, unique: true, trim: true, lowercase: true },
    name: { type: String, required: true, trim: true },
    source: { type: String, default: null, trim: true, lowercase: true },
    externalId: { type: String, default: null, trim: true },
    names: {
      type: Map,
      of: String,
      default: {},
    },
    slugs: {
      type: Map,
      of: String,
      default: {},
    },
    // Normalized key used to prevent duplicates like "Theme Park" vs "theme  park".
    nameKey: { type: String, trim: true, lowercase: true, select: false },
    icon: { type: String, default: null },
    order: { type: Number, default: 0 },
    group: { type: String, enum: ['culture', 'entertainment', 'food_drinks', 'nature', 'shopping', 'wellness' ,'transport', 'other'], default: 'other' },
    defaultDurationMin: {
      minMinutes: { type: Number, required: true, min: 5, max: 1440 },
      maxMinutes: { type: Number, required: true, min: 5, max: 1440 },
      source: {
        type: String,
        enum: ['manual', 'provider', 'derived'],
        default: 'manual',
      },
    },
    tagsTypes: [{ type: Schema.Types.ObjectId, ref: 'ServiceTag' }],
    isActive: { type: Boolean, default: true },
  },
  {
    timestamps: true,
  }
);

ActivityCategorySchema.index({ nameKey: 1 }, { unique: true, sparse: true });
ActivityCategorySchema.index({ source: 1, externalId: 1 }, { unique: true, sparse: true });

ActivityCategorySchema.pre('validate', function normalizeFields(next) {
  if (this.name) this.name = String(this.name).trim();
  this.slug = slugify(this.slug || this.name || '');
  this.nameKey = normalizeNameKey(this.name || '');
  if (this.source) this.source = String(this.source).trim().toLowerCase();
  if (this.externalId) this.externalId = String(this.externalId).trim().toUpperCase();

  const inputNames = this.names && typeof this.names === 'object'
    ? Object.fromEntries(this.names)
    : {};
  const normalizedNames = {};
  for (const [locale, value] of Object.entries(inputNames)) {
    const safeLocale = String(locale || '').trim();
    const safeValue = String(value || '').trim();
    if (!safeLocale || !safeValue) continue;
    normalizedNames[safeLocale] = safeValue;
  }
  if (!normalizedNames.en && this.name) normalizedNames.en = this.name;
  this.names = normalizedNames;

  const inputSlugs = this.slugs && typeof this.slugs === 'object'
    ? Object.fromEntries(this.slugs)
    : {};
  const normalizedSlugs = {};
  for (const [locale, value] of Object.entries(inputSlugs)) {
    const safeLocale = String(locale || '').trim();
    const safeSlug = slugify(value || '');
    if (!safeLocale || !safeSlug) continue;
    normalizedSlugs[safeLocale] = safeSlug;
  }
  for (const [locale, value] of Object.entries(normalizedNames)) {
    if (!normalizedSlugs[locale]) {
      const fallback = slugify(value);
      if (fallback) normalizedSlugs[locale] = fallback;
    }
  }
  if (!normalizedSlugs.en && this.slug) normalizedSlugs.en = this.slug;
  this.slugs = normalizedSlugs;

  const d = this.defaultDurationMin;
  if (
    d &&
    Number.isFinite(Number(d.minMinutes)) &&
    Number.isFinite(Number(d.maxMinutes)) &&
    Number(d.minMinutes) > Number(d.maxMinutes)
  ) {
    this.invalidate(
      'defaultDurationMin.maxMinutes',
      'defaultDurationMin.maxMinutes must be >= minMinutes'
    );
  }

  next();
});

ActivityCategorySchema.pre('findOneAndUpdate', function normalizeUpdate(next) {
  const update = this.getUpdate() || {};
  const nextName = (update.name || update.$set?.name || '').toString();
  const nextSlug = (update.slug || update.$set?.slug || '').toString();
  const nextNames = update.names || update.$set?.names;
  const nextSlugs = update.slugs || update.$set?.slugs;

  const $set = {
    ...(update.$set || {}),
  };

  if (nextName) {
    $set.name = nextName.trim();
    $set.nameKey = normalizeNameKey(nextName);
  }

  if (nextSlug || nextName) {
    $set.slug = slugify(nextSlug || nextName);
  }

  if (nextNames && typeof nextNames === 'object') {
    const normalizedNames = {};
    for (const [locale, value] of Object.entries(nextNames)) {
      const safeLocale = String(locale || '').trim();
      const safeValue = String(value || '').trim();
      if (!safeLocale || !safeValue) continue;
      normalizedNames[safeLocale] = safeValue;
    }
    if (Object.keys(normalizedNames).length) {
      $set.names = normalizedNames;
    }
  }

  if (nextSlugs && typeof nextSlugs === 'object') {
    const normalizedSlugs = {};
    for (const [locale, value] of Object.entries(nextSlugs)) {
      const safeLocale = String(locale || '').trim();
      const safeSlug = slugify(value || '');
      if (!safeLocale || !safeSlug) continue;
      normalizedSlugs[safeLocale] = safeSlug;
    }
    if (Object.keys(normalizedSlugs).length) {
      $set.slugs = normalizedSlugs;
    }
  }

  this.setUpdate({
    ...update,
    $set,
  });
  next();
});

module.exports = mongoose.model('ActivityCategory', ActivityCategorySchema);
