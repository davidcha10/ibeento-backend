const axios = require('axios');

const UNSPLASH_BASE_URL = 'https://api.unsplash.com';
const PEXELS_BASE_URL = 'https://api.pexels.com/v1';

function normalizeQuery(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeSourceList(value) {
  const requested = Array.isArray(value)
    ? value
    : String(value || '')
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean);
  const allowed = new Set(['unsplash', 'pexels']);
  const unique = [];
  for (const source of requested) {
    if (!allowed.has(source) || unique.includes(source)) continue;
    unique.push(source);
  }
  return unique.length ? unique : ['pexels', 'unsplash'];
}

function clampPerPage(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 12;
  return Math.max(1, Math.min(24, Math.trunc(num)));
}

function clampPage(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 1;
  return Math.max(1, Math.trunc(num));
}

async function searchUnsplash(query, options = {}) {
  const accessKey = String(process.env.UNSPLASH_ACCESS_KEY || '').trim();
  if (!accessKey) {
    return { results: [], unavailable: { source: 'unsplash', reason: 'missing_api_key' } };
  }

  const perPage = clampPerPage(options.perPage);
  const page = clampPage(options.page);

  const response = await axios.get(`${UNSPLASH_BASE_URL}/search/photos`, {
    headers: {
      Authorization: `Client-ID ${accessKey}`,
      'Accept-Version': 'v1',
    },
    params: {
      query,
      page,
      per_page: perPage,
      content_filter: 'high',
      orientation: 'landscape',
    },
    timeout: 12000,
  });

  const items = Array.isArray(response?.data?.results) ? response.data.results : [];
  return {
    results: items.map((item) => ({
      source: 'unsplash',
      externalId: String(item?.id || '').trim(),
      previewUrl: String(item?.urls?.small || item?.urls?.thumb || '').trim(),
      fullUrl: String(item?.urls?.regular || item?.urls?.full || item?.urls?.small || '').trim(),
      width: Number.isFinite(Number(item?.width)) ? Number(item.width) : null,
      height: Number.isFinite(Number(item?.height)) ? Number(item.height) : null,
      authorName: String(item?.user?.name || '').trim(),
      authorUrl: String(item?.user?.links?.html || '').trim(),
      sourcePageUrl: String(item?.links?.html || '').trim(),
      alt: String(item?.alt_description || item?.description || '').trim(),
      downloadTrackingUrl: String(item?.links?.download_location || '').trim(),
    })).filter((item) => item.previewUrl && item.fullUrl),
  };
}

async function searchPexels(query, options = {}) {
  const apiKey = String(process.env.PEXELS_API_KEY || '').trim();
  if (!apiKey) {
    return { results: [], unavailable: { source: 'pexels', reason: 'missing_api_key' } };
  }

  const perPage = clampPerPage(options.perPage);
  const page = clampPage(options.page);

  const response = await axios.get(`${PEXELS_BASE_URL}/search`, {
    headers: {
      Authorization: apiKey,
    },
    params: {
      query,
      page,
      per_page: perPage,
      orientation: 'landscape',
      locale: 'en-US',
      size: 'large',
    },
    timeout: 12000,
  });

  const items = Array.isArray(response?.data?.photos) ? response.data.photos : [];
  return {
    results: items.map((item) => ({
      source: 'pexels',
      externalId: String(item?.id || '').trim(),
      previewUrl: String(item?.src?.medium || item?.src?.small || item?.src?.tiny || '').trim(),
      fullUrl: String(item?.src?.large || item?.src?.large2x || item?.src?.original || item?.src?.medium || '').trim(),
      width: Number.isFinite(Number(item?.width)) ? Number(item.width) : null,
      height: Number.isFinite(Number(item?.height)) ? Number(item.height) : null,
      authorName: String(item?.photographer || '').trim(),
      authorUrl: String(item?.photographer_url || '').trim(),
      sourcePageUrl: String(item?.url || '').trim(),
      alt: '',
      downloadTrackingUrl: '',
    })).filter((item) => item.previewUrl && item.fullUrl),
  };
}

function mapAxiosError(err, source) {
  const status = Number(err?.response?.status || 0);
  const details = typeof err?.response?.data === 'string'
    ? err.response.data
    : err?.response?.data?.errors || err?.response?.data?.error || err?.message || 'unknown_error';
  return {
    source,
    status: status || undefined,
    message: Array.isArray(details) ? details.join(', ') : String(details || 'unknown_error'),
  };
}

async function searchActivityImages(rawQuery, options = {}) {
  const query = normalizeQuery(rawQuery);
  if (!query) {
    const error = new Error('Search query is required');
    error.status = 400;
    throw error;
  }

  const sources = normalizeSourceList(options.sources);
  const perPage = clampPerPage(options.perPage);
  const page = clampPage(options.page);

  const runners = {
    unsplash: () => searchUnsplash(query, { perPage, page }),
    pexels: () => searchPexels(query, { perPage, page }),
  };

  const settled = await Promise.allSettled(
    sources.map(async (source) => ({ source, payload: await runners[source]() }))
  );

  const results = [];
  const unavailableSources = [];
  const errors = [];

  settled.forEach((item, index) => {
    if (item.status === 'fulfilled') {
      const payload = item.value?.payload || {};
      if (payload.unavailable) unavailableSources.push(payload.unavailable);
      if (Array.isArray(payload.results)) results.push(...payload.results);
      return;
    }

    const source = sources[index] || 'unknown';
    errors.push(mapAxiosError(item.reason, source));
  });

  return {
    query,
    results,
    meta: {
      sources,
      unavailableSources,
      errors,
      perPage,
      page,
    },
  };
}

module.exports = {
  searchActivityImages,
};
