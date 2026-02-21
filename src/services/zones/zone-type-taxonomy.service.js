const ZoneTypeTaxonomy = require('../../models/ZoneTypeTaxonomy');

const CACHE_TTL_MS = 5 * 60 * 1000;
let cacheMap = new Map();
let cacheExpiresAt = 0;

function normalizeQid(value) {
  const raw = String(value || '').trim().toUpperCase();
  return /^Q\d+$/.test(raw) ? raw : null;
}

function normalizeIso2(value) {
  const raw = String(value || '').trim().toUpperCase();
  return raw.length === 2 ? raw : null;
}

function pickLocalizedLabel(labels, locale = 'en') {
  if (!labels) return null;
  const lc = String(locale || 'en').trim();
  if (!lc) return null;

  if (typeof labels.get === 'function') {
    return labels.get(lc) || labels.get('en') || null;
  }
  if (typeof labels === 'object') {
    return labels[lc] || labels.en || null;
  }
  return null;
}

function humanizeType(code) {
  return String(code || 'zone')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function capitalizeFirstLetter(value) {
  const raw = String(value || '').trim();
  if (!raw) return raw;
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

async function getTaxonomyMap() {
  const now = Date.now();
  if (cacheMap.size && now < cacheExpiresAt) {
    return cacheMap;
  }

  const docs = await ZoneTypeTaxonomy.find({ active: true })
    .sort({ priority: 1, qid: 1 })
    .lean();

  cacheMap = new Map(docs.map((doc) => [String(doc.qid).toUpperCase(), doc]));
  cacheExpiresAt = now + CACHE_TTL_MS;
  return cacheMap;
}

function invalidateTaxonomyCache() {
  cacheMap = new Map();
  cacheExpiresAt = 0;
}

async function findTaxonomyByQid(qid) {
  const normalized = normalizeQid(qid);
  if (!normalized) return null;
  const map = await getTaxonomyMap();
  return map.get(normalized) || null;
}

async function resolveZoneDisplayTypeLabel({
  qid,
  typeCode,
  canonicalType,
  countryIso2,
  countryQid,
  locale = 'en',
}) {
  const normalizedQid = normalizeQid(qid);
  const normalizedCountryQid = normalizeQid(countryQid);
  const normalizedIso2 = normalizeIso2(countryIso2);

  if (normalizedQid) {
    const doc = await findTaxonomyByQid(normalizedQid);
    if (doc) {
      const overrides = Array.isArray(doc.countryOverrides) ? doc.countryOverrides : [];
      const countrySpecific = overrides.find((item) => {
        const itemCountryQid = normalizeQid(item?.countryQid);
        const itemIso2 = normalizeIso2(item?.countryIso2);
        if (normalizedCountryQid && itemCountryQid && itemCountryQid === normalizedCountryQid) return true;
        if (normalizedIso2 && itemIso2 && itemIso2 === normalizedIso2) return true;
        return false;
      });

      const overrideLabel = pickLocalizedLabel(countrySpecific?.labels, locale);
      if (overrideLabel) return capitalizeFirstLetter(overrideLabel);

      const defaultLabel = pickLocalizedLabel(doc.labels, locale);
      if (defaultLabel) return capitalizeFirstLetter(defaultLabel);
    }
  }

  return capitalizeFirstLetter(humanizeType(typeCode || canonicalType || 'zone'));
}

module.exports = {
  findTaxonomyByQid,
  resolveZoneDisplayTypeLabel,
  invalidateTaxonomyCache,
};
