const googlePlacesService = require('../google-places.service');

const GOOGLE_CACHE_TTL_DAYS = 30;
const GOOGLE_CACHE_TTL_MS = GOOGLE_CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;

function addGoogleCacheExpiry(baseDate = new Date()) {
  const base = baseDate instanceof Date && !Number.isNaN(baseDate.getTime()) ? baseDate : new Date();
  return new Date(base.getTime() + GOOGLE_CACHE_TTL_MS);
}

function validGeoPoint(raw) {
  return (
    raw?.type === 'Point' &&
    Array.isArray(raw?.coordinates) &&
    raw.coordinates.length === 2 &&
    Number.isFinite(Number(raw.coordinates[0])) &&
    Number.isFinite(Number(raw.coordinates[1]))
  );
}

function activityHasCanonicalData(activity = {}) {
  const hasCanonicalName =
    !!String(activity?.name || '').trim() &&
    String(activity?.nameSource || '').trim().toLowerCase() !== 'google_cache';
  const hasCanonicalGeo =
    validGeoPoint(activity?.location?.geo) &&
    String(activity?.location?.geoSource || '').trim().toLowerCase() !== 'google_cache';
  const hasCanonicalAddress =
    !!String(activity?.location?.address || '').trim() &&
    String(activity?.location?.addressSource || '').trim().toLowerCase() !== 'google_cache';

  return hasCanonicalName && hasCanonicalGeo && hasCanonicalAddress;
}

function isGoogleCacheExpired(activity = {}, now = new Date()) {
  const expiresAt = activity?.googleCache?.expiresAt
    ? new Date(activity.googleCache.expiresAt)
    : null;
  return !!expiresAt && !Number.isNaN(expiresAt.getTime()) && expiresAt <= now;
}

function basePriorityByReviews(reviews) {
  const r = Math.max(0, Math.floor(Number(reviews) || 0));
  if (r >= 500000) return 100;
  if (r < 1000) return interpolate(r, 0, 1000, 0, 30);
  if (r < 10000) return interpolate(r, 1000, 10000, 30, 45);
  if (r < 25000) return interpolate(r, 10000, 25000, 45, 55);
  if (r < 50000) return interpolate(r, 25000, 50000, 55, 60);
  if (r < 100000) return interpolate(r, 50000, 100000, 60, 80);
  if (r < 250000) return interpolate(r, 100000, 250000, 80, 90);
  return interpolate(r, 250000, 500000, 90, 100);
}

function ratingMultiplier(rating) {
  const safeRating = Number(rating);
  if (!Number.isFinite(safeRating) || safeRating <= 0) return 1;
  return Math.max(0.55, Math.min(1.3, 1 + ((safeRating - 4) * 0.15)));
}

function interpolate(value, start, end, startOut, endOut) {
  if (end === start) return startOut;
  const ratio = Math.max(0, Math.min(1, (value - start) / (end - start)));
  return startOut + ((endOut - startOut) * ratio);
}

function calculatePriorityFromGoogleCache(googleCache = {}, trendBoost = 0) {
  const reviews = Number(googleCache?.reviewsCount || 0);
  const rating = Number(googleCache?.ratingAvg || 0);
  const base = basePriorityByReviews(reviews);
  const weighted = base * ratingMultiplier(rating);
  const boost = Number.isFinite(Number(trendBoost)) ? Number(trendBoost) : 0;
  return Math.max(0, Math.min(100, Math.round(weighted + boost)));
}

function buildGoogleCachePayload(place = {}, options = {}) {
  const now = options.now instanceof Date && !Number.isNaN(options.now.getTime()) ? options.now : new Date();
  const placeId = String(place?.placeId || '').trim();
  if (!placeId) return null;

  const firstPhoto = Array.isArray(place?.photos) ? place.photos[0] : null;
  const photoUrl = String(place?.photoUrl || firstPhoto?.url || '').trim() || undefined;

  return {
    placeId,
    status: 'active',
    fetchedAt: now,
    expiresAt: addGoogleCacheExpiry(now),
    refreshCount: Math.max(0, Number(options.previousRefreshCount || 0)),
    name: String(place?.name || '').trim() || undefined,
    formattedAddress: String(place?.formattedAddress || '').trim() || undefined,
    geo: validGeoPoint(place?.geo) ? place.geo : undefined,
    ratingAvg: Number.isFinite(Number(place?.ratingAvg)) ? Number(place.ratingAvg) : undefined,
    reviewsCount: Number.isFinite(Number(place?.reviewsCount)) ? Number(place.reviewsCount) : undefined,
    businessStatus: String(place?.businessStatus || '').trim() || undefined,
    types: Array.isArray(place?.types) ? place.types.map((type) => String(type || '').trim()).filter(Boolean) : [],
    photoUrl,
    googleMapsUri: String(place?.googleMapsUri || '').trim() || undefined,
    openingHours: place?.openingHours || undefined,
    timeZone: String(place?.timeZone || '').trim() || undefined,
    fieldMask: Array.isArray(place?.fieldMask)
      ? place.fieldMask
      : String(place?.fieldMask || '').split(',').map((field) => field.trim()).filter(Boolean),
    lastError: undefined,
  };
}

function buildGoogleCachePurgeUpdate(now = new Date()) {
  return {
    $set: {
      'googleCache.status': 'expired',
      'googleCache.lastPurgeAt': now,
    },
    $unset: {
      'googleCache.name': '',
      'googleCache.formattedAddress': '',
      'googleCache.geo': '',
      'googleCache.ratingAvg': '',
      'googleCache.reviewsCount': '',
      'googleCache.businessStatus': '',
      'googleCache.types': '',
      'googleCache.googleMapsUri': '',
      'googleCache.openingHours': '',
      'googleCache.timeZone': '',
      'googleCache.fieldMask': '',
      'googleCache.lastError': '',
    },
  };
}

async function refreshGoogleCacheByPlaceId(placeId, previousCache = {}) {
  const place = await googlePlacesService.getPlaceCacheDetails(placeId);
  if (!place?.placeId) return null;
  return {
    ...buildGoogleCachePayload(place, {
      previousRefreshCount: Number(previousCache?.refreshCount || 0) + 1,
    }),
    lastRefreshAt: new Date(),
  };
}

module.exports = {
  GOOGLE_CACHE_TTL_DAYS,
  GOOGLE_CACHE_TTL_MS,
  addGoogleCacheExpiry,
  activityHasCanonicalData,
  buildGoogleCachePayload,
  buildGoogleCachePurgeUpdate,
  calculatePriorityFromGoogleCache,
  isGoogleCacheExpired,
  refreshGoogleCacheByPlaceId,
  validGeoPoint,
};
