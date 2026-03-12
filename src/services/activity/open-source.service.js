const TOURISM_TYPE_IDS = new Set([
  'Q570116', // tourist attraction
  'Q697295', // shrine
  'Q4895393', // landmark
  'Q4989906', // monument
  'Q860861', // sculpture
]);

function buildHeaders() {
  return { 'User-Agent': 'TripPlanner/1.0 (open-data-preview)' };
}

const OPEN_DATA_FETCH_TIMEOUT_MS = Math.max(
  5000,
  Number(process.env.OPEN_DATA_FETCH_TIMEOUT_MS || 45000)
);
const OPEN_DATA_FETCH_RETRIES = Math.max(
  0,
  Number(process.env.OPEN_DATA_FETCH_RETRIES || 2)
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractFetchErrorCode(err) {
  return (
    err?.cause?.code ||
    err?.code ||
    err?.cause?.name ||
    null
  );
}

function isRetryableFetchFailure(err) {
  const code = String(extractFetchErrorCode(err) || '');
  if (code) {
    const transientCodes = new Set([
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'EAI_AGAIN',
      'ENOTFOUND',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_SOCKET',
      'UND_ERR_ABORTED',
      'ABORT_ERR',
      'TimeoutError',
    ]);
    if (transientCodes.has(code)) return true;
  }
  const msg = String(err?.message || '').toLowerCase();
  return msg.includes('fetch failed') || msg.includes('network');
}

async function fetchWithRetry(url, options = {}, retryOptions = {}) {
  const retries = Number.isFinite(Number(retryOptions?.retries))
    ? Math.max(0, Number(retryOptions.retries))
    : OPEN_DATA_FETCH_RETRIES;
  const timeoutMs = Number.isFinite(Number(retryOptions?.timeoutMs))
    ? Math.max(1000, Number(retryOptions.timeoutMs))
    : OPEN_DATA_FETCH_TIMEOUT_MS;
  const retryStatusSet = new Set(
    Array.isArray(retryOptions?.retryStatuses)
      ? retryOptions.retryStatuses.map((s) => Number(s))
      : [429, 500, 502, 503, 504]
  );
  let attempt = 0;
  let waitMs = 1200;
  let lastErr = null;

  while (attempt <= retries) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (retryStatusSet.has(Number(res.status)) && attempt < retries) {
        await sleep(waitMs);
        waitMs = Math.min(8000, Math.round(waitMs * 1.5));
        attempt += 1;
        continue;
      }
      return res;
    } catch (err) {
      clearTimeout(timeout);
      lastErr = err;
      if (attempt >= retries || !isRetryableFetchFailure(err)) {
        throw err;
      }
      await sleep(waitMs);
      waitMs = Math.min(8000, Math.round(waitMs * 1.5));
      attempt += 1;
    }
  }

  throw lastErr || new Error('fetch failed');
}

function normalizeLocationSource(source, fallback = 'manual') {
  const s = String(source || '').trim().toLowerCase();
  if (!s) return fallback;
  if (s.startsWith('nominatim')) return 'nominatim';
  if (s === 'wikidata') return 'wikidata';
  if (s === 'manual') return 'manual';
  return fallback;
}

function slugify(input = '') {
  const base = String(input)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (base) return base;
  return `item-${Date.now()}`;
}

function claimFileNames(entity, property) {
  const claims = entity?.claims?.[property];
  if (!Array.isArray(claims)) return [];
  return claims
    .map((c) => c?.mainsnak?.datavalue?.value)
    .filter((v) => typeof v === 'string' && v.trim().length > 0)
    .map((v) => v.trim());
}

function claimStrings(entity, property) {
  const claims = entity?.claims?.[property];
  if (!Array.isArray(claims)) return [];
  return claims
    .map((c) => c?.mainsnak?.datavalue?.value)
    .filter((v) => typeof v === 'string' && v.trim().length > 0)
    .map((v) => v.trim());
}

function claimMonolingualTexts(entity, property) {
  const claims = entity?.claims?.[property];
  if (!Array.isArray(claims)) return [];
  return claims
    .map((c) => c?.mainsnak?.datavalue?.value)
    .filter((v) => v && typeof v.text === 'string' && v.text.trim().length > 0)
    .map((v) => ({
      language: String(v.language || '').toLowerCase(),
      text: v.text.trim(),
    }));
}

function isLikelyNonPhotoFileName(fileName = '') {
  const s = String(fileName).toLowerCase();
  return (
    s.includes('map') ||
    s.includes('flag') ||
    s.includes('logo') ||
    s.includes('coat of arms') ||
    s.includes('locator') ||
    s.includes('diagram') ||
    s.endsWith('.svg')
  );
}

const FILE_NOISE_KEYWORDS = [
  'map',
  'flag',
  'logo',
  'coat of arms',
  'locator',
  'diagram',
  'icon',
  'route',
  'line',
  'station sign',
  'subway',
  'metro',
  'plan',
  'floorplan',
  'ticket',
];

const TOKEN_STOPWORDS = new Set([
  'the', 'and', 'of', 'in', 'to', 'at', 'for', 'on', 'by',
  'tokyo', 'city', 'park', 'museum', 'tower', 'temple', 'shrine',
]);

function commonsFileUrl(fileName = '') {
  // Special:FilePath returns a stable direct file URL (or redirect) for Commons filenames.
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(fileName)}`;
}

function normalizeFileTitleToName(title = '') {
  const t = String(title).trim();
  return t.toLowerCase().startsWith('file:') ? t.slice(5).trim() : t;
}

async function fetchCommonsCategoryFileNames(categoryName, limit = 30) {
  if (!categoryName) return [];

  const categoryTitle = categoryName.startsWith('Category:')
    ? categoryName
    : `Category:${categoryName}`;

  const url = new URL('https://commons.wikimedia.org/w/api.php');
  url.searchParams.set('action', 'query');
  url.searchParams.set('format', 'json');
  url.searchParams.set('origin', '*');
  url.searchParams.set('list', 'categorymembers');
  url.searchParams.set('cmtitle', categoryTitle);
  url.searchParams.set('cmtype', 'file');
  url.searchParams.set('cmlimit', String(Math.max(10, Math.min(limit, 50))));

  const res = await fetchWithRetry(url.toString(), { headers: buildHeaders() });
  if (!res.ok) return [];

  const json = await res.json();
  const members = Array.isArray(json?.query?.categorymembers)
    ? json.query.categorymembers
    : [];

  return members
    .map((m) => normalizeFileTitleToName(m?.title || ''))
    .filter(Boolean);
}

async function fetchCommonsSearchFileNames(query, limit = 30) {
  const q = String(query || '').trim();
  if (!q) return [];

  const url = new URL('https://commons.wikimedia.org/w/api.php');
  url.searchParams.set('action', 'query');
  url.searchParams.set('format', 'json');
  url.searchParams.set('origin', '*');
  url.searchParams.set('list', 'search');
  url.searchParams.set('srsearch', q);
  url.searchParams.set('srnamespace', '6'); // File namespace
  url.searchParams.set('srlimit', String(Math.max(10, Math.min(limit, 50))));

  const res = await fetchWithRetry(url.toString(), { headers: buildHeaders() });
  if (!res.ok) return [];

  const json = await res.json();
  const rows = Array.isArray(json?.query?.search) ? json.query.search : [];
  return rows
    .map((r) => normalizeFileTitleToName(r?.title || ''))
    .filter(Boolean);
}

function normalizeTextForMatch(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim();
}

function extractMeaningfulTokens(value = '') {
  return normalizeTextForMatch(value)
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !TOKEN_STOPWORDS.has(t));
}

function categoryFileRelevanceScore(fileName, label, categoryHints = []) {
  const fileNorm = normalizeTextForMatch(fileName);
  if (!fileNorm) return -10;

  let score = 0;
  const labelNorm = normalizeTextForMatch(label);
  const labelTokens = extractMeaningfulTokens(label);

  if (labelNorm && fileNorm.includes(labelNorm)) score += 6;

  let tokenHits = 0;
  for (const t of labelTokens) {
    if (fileNorm.includes(t)) tokenHits += 1;
  }
  score += Math.min(tokenHits, 4) * 2;

  const hintTokens = extractMeaningfulTokens(categoryHints.join(' '));
  let hintHits = 0;
  for (const t of hintTokens) {
    if (fileNorm.includes(t)) hintHits += 1;
  }
  score += Math.min(hintHits, 2);

  for (const bad of FILE_NOISE_KEYWORDS) {
    if (fileNorm.includes(bad)) score -= 6;
  }
  if (fileNorm.endsWith(' svg')) score -= 8;

  return score;
}

function buildAddressFromEntity(entity, label, locationHint = '') {
  const entries = claimMonolingualTexts(entity, 'P6375'); // street address
  const addresses = {};
  for (const e of entries) {
    if (!e.language || !e.text) continue;
    if (!addresses[e.language]) addresses[e.language] = e.text;
  }

  const enAddress =
    addresses.en ||
    addresses['en-us'] ||
    addresses['en-gb'] ||
    addresses['en-ca'] ||
    null;
  return {
    // Keep only a real address value from Wikidata (English variants).
    address: enAddress || null,
    addresses,
  };
}

function looksEnglishEnough(value = '') {
  const s = String(value || '').trim();
  if (!s) return false;
  const latinLetters = (s.match(/[A-Za-z]/g) || []).length;
  return latinLetters >= 3;
}

function buildAddressFromNominatimAddressObj(addressObj = {}) {
  const pick = (...keys) => {
    for (const key of keys) {
      const v = addressObj?.[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  };

  const houseNumber = pick('house_number');
  const road = pick('road', 'street');
  const locality = pick('neighbourhood', 'suburb', 'quarter', 'city_district');
  const suburb = pick('suburb', 'neighbourhood', 'quarter', 'city_district');
  const city = pick('city', 'town', 'village', 'municipality');
  const state = pick('state', 'region', 'state_district', 'county');
  const postcode = pick('postcode');
  const country = pick('country');

  const primary =
    (houseNumber && locality)
      ? `${houseNumber} ${locality}`
      : ((houseNumber && road) ? `${houseNumber} ${road}` : (locality || road));

  const parts = [
    primary,
    suburb || null,
    city || null,
    state || null,
    postcode || null,
    country || null,
  ].filter(Boolean);
  const seen = new Set();
  const deduped = [];
  for (const part of parts) {
    const key = normalizeTextForMatch(part);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(part);
  }
  return deduped.join(', ');
}

function countAddressParts(value = '') {
  return String(value || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean).length;
}

function pickBestNominatimAddress(addressFromObj = '', displayName = '') {
  const obj = String(addressFromObj || '').trim();
  const display = String(displayName || '').trim();
  const displayOk = display && looksEnglishEnough(display);
  if (!obj) return displayOk ? display : '';
  if (!displayOk) return obj;

  const objParts = countAddressParts(obj);
  const displayParts = countAddressParts(display);

  // Prefer structured postal-like address unless it is too short.
  if (objParts >= 3) return obj;
  if (displayParts >= objParts + 2) return display;
  if (display.length >= obj.length + 30) return display;
  return obj;
}

function pickNominatimEnglishName(nominatim = null) {
  if (!nominatim || typeof nominatim !== 'object') return null;

  const namedetails = nominatim.namedetails && typeof nominatim.namedetails === 'object'
    ? nominatim.namedetails
    : {};

  const candidates = [
    namedetails['name:en'],
    namedetails['official_name:en'],
    namedetails.int_name,
    namedetails.name,
    nominatim.name,
  ]
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter(Boolean);

  for (const value of candidates) {
    if (looksEnglishEnough(value)) return value;
  }

  const firstDisplayPart = typeof nominatim.displayName === 'string'
    ? String(nominatim.displayName).split(',')[0].trim()
    : '';
  if (firstDisplayPart && looksEnglishEnough(firstDisplayPart)) {
    return firstDisplayPart;
  }

  return null;
}

function isStrongNominatimPoiMatch(label = '', row = null) {
  if (!row || typeof row !== 'object') return false;
  const labelNorm = normalizeTextForMatch(label);
  if (!labelNorm) return false;

  const directCandidates = [
    row.name,
    row.displayName,
    row.addressEn,
  ]
    .filter((v) => typeof v === 'string' && v.trim())
    .map((v) => normalizeTextForMatch(v));

  if (directCandidates.some((v) => v && (v.includes(labelNorm) || labelNorm.includes(v)))) {
    return true;
  }

  const labelTokens = extractMeaningfulTokens(label);
  if (!labelTokens.length) return false;

  const candidateTokens = new Set(
    directCandidates
      .flatMap((v) => extractMeaningfulTokens(v))
      .filter(Boolean)
  );

  let hits = 0;
  for (const t of labelTokens) {
    if (candidateTokens.has(t)) hits += 1;
  }

  // Require at least one strong token hit for short labels, two for longer names.
  if (labelTokens.length <= 2) return hits >= 1;
  return hits >= 2;
}

function haversineMeters(aLat, aLng, bLat, bLng) {
  const toRad = (d) => (Number(d) * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

async function buildWikimediaMedia(entity, options = {}) {
  if (!entity) return { cover: null, images: [] };
  const label = entity?.labels?.en?.value || '';
  const locationHint = String(options?.locationHint || '').trim();
  const relatedEntities = Array.isArray(options?.relatedEntities)
    ? options.relatedEntities.filter(Boolean)
    : [];

  const preferred = claimFileNames(entity, 'P18'); // image
  const supporting = [
    ...claimFileNames(entity, 'P2716'), // collage image
    ...claimFileNames(entity, 'P3451'), // night image
    ...claimFileNames(entity, 'P4291'), // panoramic view
    ...claimFileNames(entity, 'P8592'), // aerial view
  ];

  const commonsCategories = claimStrings(entity, 'P373'); // Commons category
  let fromCategory = [];
  for (const cat of commonsCategories.slice(0, 2)) {
    const files = await fetchCommonsCategoryFileNames(cat, 40);
    // Keep only files that are likely related to the specific POI.
    const ranked = files
      .filter((f) => !isLikelyNonPhotoFileName(f))
      .map((f) => ({
        file: f,
        score: categoryFileRelevanceScore(f, label, commonsCategories),
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.file)
      .slice(0, 20);

    // If strict relevance ranking yields nothing, keep a conservative fallback
    // so POIs with sparse naming patterns still get media.
    const fallback = ranked.length
      ? ranked
      : files
          .filter((f) => !isLikelyNonPhotoFileName(f))
          .slice(0, 20);

    fromCategory.push(...fallback);
    if (fromCategory.length >= 40) break;
  }

  // Fallback 1: If this POI has few media, try the immediate parent entities (P361).
  // Useful for child POIs that inherit better media coverage via their parent complex.
  let fromParents = [];
  for (const parentEntity of relatedEntities.slice(0, 2)) {
    const parentPreferred = claimFileNames(parentEntity, 'P18');
    const parentSupporting = [
      ...claimFileNames(parentEntity, 'P2716'),
      ...claimFileNames(parentEntity, 'P3451'),
      ...claimFileNames(parentEntity, 'P4291'),
      ...claimFileNames(parentEntity, 'P8592'),
    ];
    const parentCategories = claimStrings(parentEntity, 'P373');
    fromParents.push(
      ...parentPreferred.map(normalizeFileTitleToName),
      ...parentSupporting.map(normalizeFileTitleToName)
    );
    for (const parentCat of parentCategories.slice(0, 1)) {
      const files = await fetchCommonsCategoryFileNames(parentCat, 20);
      const ranked = files
        .filter((f) => !isLikelyNonPhotoFileName(f))
        .map((f) => ({
          file: f,
          score: categoryFileRelevanceScore(f, label, [...commonsCategories, ...parentCategories]),
        }))
        .sort((a, b) => b.score - a.score)
        .map((x) => x.file)
        .slice(0, 10);
      fromParents.push(...ranked);
    }
  }

  // Fallback 2: Commons textual search by POI name (+ location hint).
  let fromSearch = [];
  const labelTokens = extractMeaningfulTokens(label);
  const searchQueries = [
    locationHint ? `${label} ${locationHint}` : label,
    label,
  ].filter(Boolean);
  for (const searchQuery of searchQueries) {
    const files = await fetchCommonsSearchFileNames(searchQuery, 30);
    const ranked = files
      .filter((f) => !isLikelyNonPhotoFileName(f))
      .map((f) => {
        const score = categoryFileRelevanceScore(f, label, commonsCategories);
        const fileNorm = normalizeTextForMatch(f);
        const tokenHits = labelTokens.reduce(
          (acc, t) => (fileNorm.includes(t) ? acc + 1 : acc),
          0
        );
        return { file: f, score, tokenHits };
      })
      .filter((x) => x.tokenHits > 0 || x.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return b.tokenHits - a.tokenHits;
      })
      .map((x) => x.file)
      .slice(0, 20);
    fromSearch.push(...ranked);
    if (fromSearch.length >= 40) break;
  }

  const all = Array.from(
    new Set([
      ...preferred.map(normalizeFileTitleToName),
      ...supporting.map(normalizeFileTitleToName),
      ...fromCategory,
      ...fromParents,
      ...fromSearch,
    ])
  ).slice(0, 60);
  if (!all.length) return { cover: null, images: [] };

  const photos = all.filter((f) => !isLikelyNonPhotoFileName(f));
  const ordered = photos.length ? [...photos, ...all.filter((f) => !photos.includes(f))] : all;
  const selected = ordered.slice(0, 10);
  const coverFile = photos[0] || selected[0] || null;

  return {
    cover: coverFile ? commonsFileUrl(coverFile) : null,
    images: selected.map((fileName, idx) => ({
      url: commonsFileUrl(fileName),
      type: 'image',
      caption: 'Wikimedia Commons',
      order: idx,
    })),
  };
}

function wikidataTypeIds(entity) {
  const claims = entity?.claims?.P31 || [];
  return claims
    .map((c) => c?.mainsnak?.datavalue?.value?.id)
    .filter(Boolean);
}

function parseQidFromUri(uri = '') {
  const m = String(uri).match(/\/entity\/(Q\d+)$/);
  return m ? m[1] : null;
}

function includesNormalized(haystack = '', needle = '') {
  const h = normalizeTextForMatch(haystack);
  const n = normalizeTextForMatch(needle);
  if (!h || !n) return false;
  return h.includes(n);
}

function getEntityCoordinate(entity) {
  const claims = entity?.claims?.P625;
  const value = Array.isArray(claims)
    ? claims[0]?.mainsnak?.datavalue?.value
    : null;
  if (!value) return null;
  const lat = Number(value.latitude);
  const lng = Number(value.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function resolveRadiusByLocationType(locationType) {
  if (locationType === 'city') return 20;
  if (locationType === 'neighborhood') return 10;
  if (locationType === 'province') return 80;
  if (locationType === 'region') return 80;
  if (locationType === 'country') return 150;
  return 20;
}

function dedupeCandidatesByIdOrSlug(rows = []) {
  const dedup = new Map();
  for (const row of rows) {
    if (!row) continue;
    const key =
      (row.externalId && `id:${String(row.externalId)}`) ||
      (row.slug && `slug:${String(row.slug)}`) ||
      null;
    if (!key) continue;
    if (!dedup.has(key)) dedup.set(key, row);
  }
  return Array.from(dedup.values());
}

function dropChildrenWhenParentPresent(rows = []) {
  const idSet = new Set(
    rows
      .map((r) => String(r?.externalId || r?._preview?.placeId || '').trim())
      .filter(Boolean)
  );

  return rows.filter((r) => {
    const parents = Array.isArray(r?._preview?.partOfIds) ? r._preview.partOfIds : [];
    if (!parents.length) return true;
    return !parents.some((pid) => idSet.has(String(pid).trim()));
  });
}

function wikidataClaimIds(entity, prop) {
  const claims = entity?.claims?.[prop] || [];
  return claims
    .map((c) => c?.mainsnak?.datavalue?.value?.id)
    .filter(Boolean)
    .map((id) => String(id).toUpperCase());
}

async function searchPoiWithNominatim(query, limit = 5) {
  try {
    const q = String(query || '').trim();
    if (!q) return [];

    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('q', q);
    url.searchParams.set('limit', String(Math.max(1, Math.min(limit, 10))));
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('namedetails', '1');
    url.searchParams.set('accept-language', 'en');

    const res = await fetchWithRetry(url.toString(), {
      headers: {
        ...buildHeaders(),
        Accept: 'application/json',
      },
    });
    if (!res.ok) return [];

    const json = await res.json();
    const rows = Array.isArray(json) ? json : [];
    return rows
      .map((row) => {
        const lat = Number(row?.lat);
        const lng = Number(row?.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

        const displayName =
          typeof row.display_name === 'string' ? row.display_name.trim() : '';
        const fromObj = buildAddressFromNominatimAddressObj(row.address || {});
        const candidate = pickBestNominatimAddress(fromObj, displayName);

        return {
          source: 'nominatim_search',
          lat,
          lng,
          addressEn: candidate && looksEnglishEnough(candidate) ? candidate : null,
          rawAddress: row.address || {},
          displayName: displayName || null,
          osmType: row.osm_type || null,
          osmId: row.osm_id != null ? String(row.osm_id) : null,
          class: row.class || null,
          type: row.type || null,
          addresstype: row.addresstype || null,
          placeRank: Number.isFinite(Number(row.place_rank)) ? Number(row.place_rank) : null,
          importance: Number.isFinite(Number(row.importance)) ? Number(row.importance) : null,
          name: typeof row.name === 'string' ? row.name.trim() : null,
          namedetails: row.namedetails && typeof row.namedetails === 'object' ? row.namedetails : {},
        };
      })
      .filter(Boolean);
  } catch (_err) {
    return [];
  }
}

async function reverseWithNominatim(lat, lng) {
  try {
    const safeLat = Number(lat);
    const safeLng = Number(lng);
    if (!Number.isFinite(safeLat) || !Number.isFinite(safeLng)) return null;

    const url = new URL('https://nominatim.openstreetmap.org/reverse');
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('lat', String(safeLat));
    url.searchParams.set('lon', String(safeLng));
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('namedetails', '1');
    url.searchParams.set('accept-language', 'en');

    const res = await fetchWithRetry(url.toString(), {
      headers: {
        ...buildHeaders(),
        Accept: 'application/json',
      },
    });
    if (!res.ok) return null;

    const json = await res.json();
    if (!json || typeof json !== 'object') return null;

    const displayName =
      typeof json.display_name === 'string' ? json.display_name.trim() : '';
    const fromObj = buildAddressFromNominatimAddressObj(json.address || {});
    const candidate = pickBestNominatimAddress(fromObj, displayName);

    return {
      source: 'nominatim_reverse',
      lat: safeLat,
      lng: safeLng,
      addressEn: candidate && looksEnglishEnough(candidate) ? candidate : null,
      rawAddress: json.address || {},
      displayName: displayName || null,
      osmType: json.osm_type || null,
      osmId: json.osm_id != null ? String(json.osm_id) : null,
      class: json.class || null,
      type: json.type || null,
      addresstype: json.addresstype || null,
      placeRank: Number.isFinite(Number(json.place_rank)) ? Number(json.place_rank) : null,
      importance: Number.isFinite(Number(json.importance)) ? Number(json.importance) : null,
      name: typeof json.name === 'string' ? json.name.trim() : null,
      namedetails: json.namedetails && typeof json.namedetails === 'object' ? json.namedetails : {},
    };
  } catch (_err) {
    return null;
  }
}

async function resolveNominatimAddressForPoi({ label, locationHint, coord, maxDistanceMeters = 300 }) {
  const query = locationHint ? `${label}, ${locationHint}` : label;
  const searchRows = await searchPoiWithNominatim(query, 5);
  const stronglyMatchedRows = searchRows.filter((row) => isStrongNominatimPoiMatch(label, row));

  let best = null;
  const hasCoord =
    coord &&
    Number.isFinite(Number(coord.lat)) &&
    Number.isFinite(Number(coord.lng));

  if (hasCoord) {
    // When we have coordinates, only trust candidates that actually match the POI label.
    for (const row of stronglyMatchedRows) {
      const d = haversineMeters(coord.lat, coord.lng, row.lat, row.lng);
      if (d > maxDistanceMeters) continue;

      const withDistance = {
        ...row,
        matchDistanceMeters: Math.round(d),
      };
      if (!best) {
        best = withDistance;
        continue;
      }

      const bestImportance = Number.isFinite(Number(best.importance)) ? Number(best.importance) : -1;
      const rowImportance = Number.isFinite(Number(withDistance.importance))
        ? Number(withDistance.importance)
        : -1;

      if (rowImportance > bestImportance) {
        best = withDistance;
        continue;
      }
      if (rowImportance === bestImportance && withDistance.matchDistanceMeters < best.matchDistanceMeters) {
        best = withDistance;
      }
    }
  } else if (stronglyMatchedRows.length) {
    // No base coordinate from provider. Use best search candidate only if it matches POI label.
    best = [...stronglyMatchedRows].sort((a, b) => {
      const impA = Number.isFinite(Number(a.importance)) ? Number(a.importance) : -1;
      const impB = Number.isFinite(Number(b.importance)) ? Number(b.importance) : -1;
      return impB - impA;
    })[0];
  }

  if (best) return best;
  if (hasCoord) return reverseWithNominatim(coord.lat, coord.lng);
  return null;
}

function isLikelyTourismEntity(entity) {
  const typeIds = wikidataTypeIds(entity);
  if (!typeIds.length) return false;

  // Explicit exclusion currently known to leak noise
  if (typeIds.includes('Q16917')) return false; // hospital

  return typeIds.some((t) => TOURISM_TYPE_IDS.has(t));
}

async function wikidataSearchEntities(query, limit = 20) {
  const url = new URL('https://www.wikidata.org/w/api.php');
  url.searchParams.set('action', 'wbsearchentities');
  url.searchParams.set('format', 'json');
  url.searchParams.set('origin', '*');
  url.searchParams.set('language', 'en');
  url.searchParams.set('uselang', 'en');
  url.searchParams.set('type', 'item');
  url.searchParams.set('search', query);
  url.searchParams.set('limit', String(limit));

  const res = await fetchWithRetry(url.toString(), { headers: buildHeaders() });
  if (!res.ok) return [];
  const json = await res.json();
  return Array.isArray(json?.search) ? json.search : [];
}

async function wikidataGetEntitiesRaw(ids = [], options = {}) {
  const clean = Array.from(new Set(ids.filter(Boolean)));
  if (!clean.length) return {};
  const out = {};
  const chunkSize = 40;
  const requestedLanguages = Array.isArray(options?.languages)
    ? options.languages.map((value) => String(value || '').trim()).filter(Boolean).join('|')
    : String(options?.languages || '').trim();
  const languages = requestedLanguages || 'en';

  for (let i = 0; i < clean.length; i += chunkSize) {
    const chunk = clean.slice(i, i + chunkSize);
    const url = new URL('https://www.wikidata.org/w/api.php');
    url.searchParams.set('action', 'wbgetentities');
    url.searchParams.set('format', 'json');
    url.searchParams.set('origin', '*');
    url.searchParams.set('languages', languages);
    url.searchParams.set('props', 'labels|descriptions|claims|sitelinks');
    url.searchParams.set('ids', chunk.join('|'));

    const res = await fetchWithRetry(url.toString(), { headers: buildHeaders() });
    if (!res.ok) continue;
    const json = await res.json();
    const entities = json?.entities || {};
    Object.assign(out, entities);
  }

  return out;
}

async function wikidataSparqlAroundTouristAttractions({
  lng,
  lat,
  radiusKm = 20,
  limit = 100,
  offset = 0,
  rootClassIds = ['Q570116'],
}) {
  const safeLng = Number(lng);
  const safeLat = Number(lat);
  const safeRadius = Number(radiusKm);
  const safeLimit = Number(limit);
  const safeOffset = Number(offset);

  if (
    !Number.isFinite(safeLng) ||
    !Number.isFinite(safeLat) ||
    !Number.isFinite(safeRadius) ||
    !Number.isFinite(safeLimit) ||
    !Number.isFinite(safeOffset)
  ) {
    return [];
  }
  const safeRootClassIds = Array.from(
    new Set(
      (Array.isArray(rootClassIds) ? rootClassIds : [rootClassIds])
        .map((x) => String(x || '').trim().toUpperCase())
        .filter((x) => /^Q\d+$/.test(x))
    )
  );
  if (!safeRootClassIds.length) return [];

  const query = `
SELECT ?item ?itemLabel ?rootClass (MIN(?distRaw) AS ?dist) (COUNT(DISTINCT ?article) AS ?sitelinks) WHERE {
  SERVICE wikibase:around {
    ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:center "Point(${safeLng} ${safeLat})"^^geo:wktLiteral .
    bd:serviceParam wikibase:radius "${safeRadius}" .
    bd:serviceParam wikibase:distance ?distRaw .
  }

  VALUES ?rootClass { ${safeRootClassIds.map((qid) => `wd:${qid}`).join(' ')} }
  ?item wdt:P31/wdt:P279* ?rootClass .
  FILTER NOT EXISTS { ?item wdt:P31 wd:Q4167410 }

  OPTIONAL {
    ?article schema:about ?item ;
             schema:isPartOf [ wikibase:wikiGroup "wikipedia" ] .
  }

  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,es,ja". }
}
GROUP BY ?item ?itemLabel ?rootClass
ORDER BY DESC(?sitelinks) ASC(?dist)
LIMIT ${safeLimit}
OFFSET ${Math.max(0, Math.floor(safeOffset))}
`.trim();

  const res = await fetchWithRetry('https://query.wikidata.org/sparql', {
    method: 'POST',
    headers: {
      ...buildHeaders(),
      Accept: 'application/sparql-results+json',
      'Content-Type': 'application/sparql-query',
    },
    body: query,
  });

  if (!res.ok) {
    return [];
  }
  const json = await res.json();
  return Array.isArray(json?.results?.bindings) ? json.results.bindings : [];
}

async function wikidataEntitiesMatchAnyRootClass(entityIds = [], rootClassIds = []) {
  const ids = Array.from(
    new Set(
      (Array.isArray(entityIds) ? entityIds : [])
        .map((x) => String(x || '').trim().toUpperCase())
        .filter((x) => /^Q\d+$/.test(x))
    )
  );
  const roots = Array.from(
    new Set(
      (Array.isArray(rootClassIds) ? rootClassIds : [])
        .map((x) => String(x || '').trim().toUpperCase())
        .filter((x) => /^Q\d+$/.test(x))
    )
  );
  if (!ids.length || !roots.length) return new Set();

  const matches = new Set();
  const chunkSize = 30;

  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const query = `
SELECT DISTINCT ?item WHERE {
  VALUES ?item { ${chunk.map((qid) => `wd:${qid}`).join(' ')} }
  VALUES ?root { ${roots.map((qid) => `wd:${qid}`).join(' ')} }
  ?item wdt:P31/wdt:P279* ?root .
}
`.trim();

    const res = await fetchWithRetry('https://query.wikidata.org/sparql', {
      method: 'POST',
      headers: {
        ...buildHeaders(),
        Accept: 'application/sparql-results+json',
        'Content-Type': 'application/sparql-query',
      },
      body: query,
    });

    if (!res.ok) continue;
    const json = await res.json();
    const rows = Array.isArray(json?.results?.bindings) ? json.results.bindings : [];
    for (const row of rows) {
      const qid = parseQidFromUri(row?.item?.value || '');
      if (qid) matches.add(qid);
    }
  }

  return matches;
}

async function wikidataSparqlAroundByRootClasses({
  lng,
  lat,
  radiusKm = 20,
  targetCount = 50,
  rootClassIds = [],
  classTargetByRootId = {},
  refillBatchSize = 10,
  maxRounds = 4,
  maxConcurrency = 3,
  classChunkSize = 10,
}) {
  const classes = Array.from(
    new Set(
      (Array.isArray(rootClassIds) ? rootClassIds : [])
        .map((x) => String(x || '').trim().toUpperCase())
        .filter((x) => /^Q\d+$/.test(x))
    )
  );

  if (!classes.length) return { rows: [], fetchedRawRows: 0, rounds: 0, perClassStats: [] };

  const classEntities = await wikidataGetEntitiesRaw(classes);
  const chunkSize = Math.max(1, Math.floor(Number(classChunkSize) || 10));
  const classGroups = [];
  for (let i = 0; i < classes.length; i += chunkSize) {
    classGroups.push(classes.slice(i, i + chunkSize));
  }

  const rawClassTargetMap =
    classTargetByRootId instanceof Map
      ? classTargetByRootId
      : (classTargetByRootId && typeof classTargetByRootId === 'object'
        ? new Map(Object.entries(classTargetByRootId))
        : new Map());
  const classTargetMap = new Map();
  for (const qid of classes) {
    const rawTarget = Number(rawClassTargetMap.get(qid));
    if (!Number.isFinite(rawTarget) || rawTarget <= 0) continue;
    classTargetMap.set(qid, Math.max(1, Math.floor(rawTarget)));
  }
  const hasPerClassTargets = classTargetMap.size > 0;

  const safeTargetCount = Number(targetCount);
  const hasTargetCount = Number.isFinite(safeTargetCount) && safeTargetCount > 0;
  const target = hasTargetCount ? Math.max(1, Math.floor(safeTargetCount)) : null;
  const perClassAverageTarget = hasPerClassTargets
    ? Math.ceil(
        Array.from(classTargetMap.values()).reduce((acc, value) => acc + value, 0) / classTargetMap.size
      )
    : null;
  const perClassInitialLimit = hasPerClassTargets
    ? Math.max(3, Math.min(20, Math.ceil(perClassAverageTarget / 2)))
    : (hasTargetCount
      ? Math.max(5, Math.ceil(target / Math.min(classes.length, 10)))
      : Math.max(10, Math.min(30, Math.max(1, Number(refillBatchSize) || 10))));
  const perClassRefillLimit = hasPerClassTargets
    ? Math.max(1, Math.min(20, Math.floor(Number(refillBatchSize) || 10)))
    : Math.max(10, Math.min(30, Math.max(1, Number(refillBatchSize) || 10)));
  const offsets = new Map(classGroups.map((_, idx) => [`g:${idx}`, 0]));
  const perClassStats = classes.map((qid) => ({
    rootClassId: qid,
    rootClassLabel:
      classEntities?.[qid]?.labels?.en?.value ||
      classEntities?.[qid]?.labels?.es?.value ||
      classEntities?.[qid]?.labels?.ja?.value ||
      null,
    targetPerZone: classTargetMap.has(qid) ? classTargetMap.get(qid) : null,
    fetchedRows: 0,
    requests: 0,
  }));
  const statsByClass = new Map(perClassStats.map((s) => [s.rootClassId, s]));
  const allRows = [];
  let fetchedRawRows = 0;
  let rounds = 0;
  let queryRequests = 0;

  function getPendingClassesForGroup(group = []) {
    if (!hasPerClassTargets) return group;
    return group.filter((rootClassId) => {
      const targetForClass = classTargetMap.get(rootClassId);
      if (!Number.isFinite(Number(targetForClass))) return true;
      const stat = statsByClass.get(rootClassId);
      const fetched = Number(stat?.fetchedRows || 0);
      return fetched < targetForClass;
    });
  }

  function getRemainingPerClassTargetTotal() {
    if (!hasPerClassTargets) return null;
    let remaining = 0;
    for (const [rootClassId, targetForClass] of classTargetMap.entries()) {
      const stat = statsByClass.get(rootClassId);
      const fetched = Number(stat?.fetchedRows || 0);
      remaining += Math.max(0, targetForClass - fetched);
    }
    return remaining;
  }

  async function runWithConcurrency(items, mapper, concurrency) {
    const out = [];
    const max = Math.max(1, Number(concurrency) || 1);
    let cursor = 0;

    async function worker() {
      while (true) {
        const idx = cursor;
        cursor += 1;
        if (idx >= items.length) break;
        const row = await mapper(items[idx], idx);
        out.push(row);
      }
    }

    const workers = Array.from({ length: Math.min(max, items.length) }, () => worker());
    await Promise.all(workers);
    return out;
  }

  while (rounds < maxRounds) {
    const batchLimit = rounds === 0 ? perClassInitialLimit : perClassRefillLimit;
    const remainingPerClassTarget = getRemainingPerClassTargetTotal();
    if (hasPerClassTargets && Number(remainingPerClassTarget) <= 0) break;

    const roundResults = await runWithConcurrency(
      classGroups,
      async (group, groupIndex) => {
        const pendingClasses = getPendingClassesForGroup(group);
        if (!pendingClasses.length) {
          return {
            rootClassIds: group,
            rows: [],
          };
        }
        const offsetKey = `g:${groupIndex}`;
        const offset = offsets.get(offsetKey) || 0;
        const queryLimit = Math.max(1, batchLimit * Math.max(1, pendingClasses.length));
        queryRequests += 1;
        const rows = await wikidataSparqlAroundTouristAttractions({
          lng,
          lat,
          radiusKm,
          limit: queryLimit,
          offset,
          rootClassIds: pendingClasses,
        });

        const fetched = Array.isArray(rows) ? rows.length : 0;
        offsets.set(offsetKey, offset + fetched);

        for (const rootClassId of pendingClasses) {
          const stat = statsByClass.get(rootClassId);
          if (stat) stat.requests += 1;
        }

        return {
          rootClassIds: group,
          rows: Array.isArray(rows) ? rows : [],
        };
      },
      maxConcurrency
    );

    let roundAdded = 0;
    for (const result of roundResults) {
      const rows = Array.isArray(result?.rows) ? result.rows : [];
      fetchedRawRows += rows.length;
      roundAdded += rows.length;
      for (const row of rows) {
        const matchedRootClassId = parseQidFromUri(row?.rootClass?.value || '');
        if (matchedRootClassId) {
          const stat = statsByClass.get(matchedRootClassId);
          if (stat) stat.fetchedRows += 1;
        }
        allRows.push(row);
      }
    }

    rounds += 1;
    const remainingAfterRound = getRemainingPerClassTargetTotal();
    if (hasPerClassTargets && Number(remainingAfterRound) <= 0) break;
    if (target && allRows.length >= target) break;
    if (roundAdded === 0) break;
  }

  return {
    rows: allRows,
    fetchedRawRows,
    rounds,
    queryRequests,
    classGroupCount: classGroups.length,
    classChunkSize: chunkSize,
    perClassStats,
  };
}

function buildFallbackQueries(locationName) {
  return [
    `${locationName} tourist attractions`,
    `${locationName} landmarks`,
    `${locationName} museums`,
    locationName,
  ];
}

async function toCandidateFromEntity({ id, entity, fallbackLabel, distKm = null, locationHint = '', classIds = [], classLabels = [] }) {
  if (!entity && !fallbackLabel) return null;
  const wikidataLabelEn = entity?.labels?.en?.value
    ? String(entity.labels.en.value).trim()
    : '';
  const fallbackName = fallbackLabel ? String(fallbackLabel).trim() : '';
  const queryLabel = wikidataLabelEn || fallbackName || null;
  if (!queryLabel) return null;

  const sitelinksCount = entity?.sitelinks ? Object.keys(entity.sitelinks).length : 0;
  const partOfIds = wikidataClaimIds(entity, 'P361');
  const adminEntityIds = wikidataClaimIds(entity, 'P131');
  const adminParentId = adminEntityIds[0] || null;
  let relatedEntities = [];
  if (partOfIds.length) {
    const parentEntities = await wikidataGetEntitiesRaw(partOfIds.slice(0, 2));
    relatedEntities = partOfIds
      .slice(0, 2)
      .map((qid) => parentEntities?.[qid] || null)
      .filter(Boolean);
  }
  const media = await buildWikimediaMedia(entity, { relatedEntities, locationHint });
  let coord = getEntityCoordinate(entity);
  let geoSource = coord ? 'wikidata' : 'none';
  let geoConfidence = coord ? 'high' : 'none';
  const nominatim = await resolveNominatimAddressForPoi({
    label: queryLabel,
    locationHint,
    coord,
    maxDistanceMeters: 300,
  });
  const nominatimNameEn = !wikidataLabelEn ? pickNominatimEnglishName(nominatim) : null;
  const finalName = nominatimNameEn || wikidataLabelEn || fallbackName || null;
  if (!finalName) return null;

  if (!coord && nominatim && Number.isFinite(Number(nominatim.lat)) && Number.isFinite(Number(nominatim.lng))) {
    coord = {
      lat: Number(nominatim.lat),
      lng: Number(nominatim.lng),
    };
    geoSource = 'nominatim';
    geoConfidence = 'medium';
  }

  if (!coord) return null;

  const geo =
    coord && Number.isFinite(coord.lng) && Number.isFinite(coord.lat)
      ? { type: 'Point', coordinates: [coord.lng, coord.lat] }
      : null;

  const wikidataAddress = buildAddressFromEntity(entity, finalName, locationHint);
  const allowNominatimAddress = nominatim?.source === 'nominatim_search';
  const nominatimAddress =
    allowNominatimAddress
      ? (
          nominatim?.addressEn ||
          (typeof nominatim?.displayName === 'string' && looksEnglishEnough(nominatim.displayName)
            ? nominatim.displayName
            : null)
        )
      : null;
  const canonicalAddress = nominatimAddress || wikidataAddress.address || null;
  const canonicalAddressSource =
    nominatimAddress
      ? normalizeLocationSource(nominatim?.source, 'nominatim')
      : (wikidataAddress.address ? 'wikidata' : null);
  const addresses = {
    ...(wikidataAddress.addresses || {}),
    ...(nominatimAddress ? { en: nominatimAddress } : {}),
  };

  return {
    source: 'open_data_preview',
    externalId: id || null,
    name: finalName,
    slug: slugify(finalName),
    description: entity?.descriptions?.en?.value || '',
    location: geo
      ? {
          address: canonicalAddress,
          addresses,
          addressSource: canonicalAddressSource,
          geo,
          geoSource: normalizeLocationSource(geoSource, 'manual'),
          geoConfidence,
          nominatim: nominatim
            ? {
                osmType: nominatim.osmType,
                osmId: nominatim.osmId,
                class: nominatim.class,
                type: nominatim.type,
                addresstype: nominatim.addresstype,
                placeRank: nominatim.placeRank,
                importance: nominatim.importance,
                source: nominatim.source || null,
                matchDistanceMeters: nominatim.matchDistanceMeters ?? null,
                displayName: nominatim.displayName,
              }
            : undefined,
        }
      : {},
    ranking: {
      // Open-data bootstrap: reserve rating/reviews for real user feedback.
      ratingAvg: 0,
      reviewsCount: 0,
      priority: 0,
    },
    media,
    _preview: {
      provider: 'wikidata',
      placeId: id || null,
      sitelinksCount,
      typeIds: wikidataTypeIds(entity),
      classIds: Array.isArray(classIds) ? classIds : [],
      classLabels: Array.isArray(classLabels) ? classLabels : [],
      partOfIds,
      adminEntityIds,
      adminParentId,
      distanceKm: Number.isFinite(Number(distKm)) ? Number(distKm) : null,
      coordinates: coord
        ? { lat: coord.lat, lng: coord.lng }
        : null,
      nominatim: nominatim
        ? {
            importance: nominatim.importance,
            class: nominatim.class,
            type: nominatim.type,
            addresstype: nominatim.addresstype,
            placeRank: nominatim.placeRank,
          }
        : null,
    },
  };
}

const PRIORITY_SITELINKS_WEIGHT = 70;
const PRIORITY_IMPORTANCE_WEIGHT = 20;
const PRIORITY_DISTANCE_WEIGHT = 10;
const PRIORITY_SITELINKS_REF = 200; // log-normalization cap reference
const PRIORITY_DISTANCE_REF_KM = 20; // full distance penalty reached at this distance
const PRIORITY_IMPORTANCE_MIN = 0.05;
const PRIORITY_IMPORTANCE_RANGE = 0.35;

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

function applyPriorityScores(candidates = []) {
  const rows = Array.isArray(candidates) ? candidates : [];
  if (!rows.length) return rows;

  return rows.map((r) => {
    const sitelinks = Number(r?._preview?.sitelinksCount || 0);
    const importance = Number(r?._preview?.nominatim?.importance || 0);
    const distanceKm = Number(r?._preview?.distanceKm);

    // Fixed scale (not batch-relative) for stable scores across different result sets.
    const sitelinksScore = clamp01(
      Math.log1p(Math.max(0, sitelinks)) / Math.log1p(PRIORITY_SITELINKS_REF)
    );
    const importanceScore = clamp01(
      (importance - PRIORITY_IMPORTANCE_MIN) / PRIORITY_IMPORTANCE_RANGE
    );
    const distanceScore =
      Number.isFinite(distanceKm) && distanceKm >= 0
        ? clamp01(1 - distanceKm / PRIORITY_DISTANCE_REF_KM)
        : 0.5;

    const priority = Math.round(
      sitelinksScore * PRIORITY_SITELINKS_WEIGHT +
      importanceScore * PRIORITY_IMPORTANCE_WEIGHT +
      distanceScore * PRIORITY_DISTANCE_WEIGHT
    );

    return {
      ...r,
      ranking: {
        ...(r.ranking || {}),
        ratingAvg: 0,
        reviewsCount: 0,
        priority,
      },
    };
  });
}

async function mapWithConcurrency(items = [], concurrency = 4, mapper = async (x) => x) {
  const input = Array.isArray(items) ? items : [];
  const max = Math.max(1, Number(concurrency) || 1);
  if (!input.length) return [];

  const out = new Array(input.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= input.length) break;
      out[idx] = await mapper(input[idx], idx);
    }
  }

  const workers = Array.from({ length: Math.min(max, input.length) }, () => worker());
  await Promise.all(workers);
  return out;
}

function buildLightCandidateFromRow({ row, entity, classInfo }) {
  const qid = parseQidFromUri(row?.item?.value);
  if (!qid) return null;

  const fallbackName =
    row?.itemLabel?.value ||
    entity?.labels?.en?.value ||
    qid;
  const safeName = String(fallbackName || '').trim();
  if (!safeName) return null;

  const distKm = Number(row?.dist?.value || 0);
  const sitelinksCount = Number(row?.sitelinks?.value || 0);
  const coord = getEntityCoordinate(entity);

  return {
    source: 'open_data_preview',
    externalId: qid,
    name: safeName,
    slug: slugify(safeName),
    description: entity?.descriptions?.en?.value || '',
    _preview: {
      provider: 'wikidata',
      placeId: qid,
      sitelinksCount: Number.isFinite(sitelinksCount) ? sitelinksCount : 0,
      typeIds: wikidataTypeIds(entity),
      classIds: classInfo ? Array.from(classInfo.ids) : wikidataTypeIds(entity),
      classLabels: classInfo ? Array.from(classInfo.labels) : [],
      partOfIds: wikidataClaimIds(entity, 'P361'),
      adminEntityIds: wikidataClaimIds(entity, 'P131'),
      adminParentId: (wikidataClaimIds(entity, 'P131') || [])[0] || null,
      distanceKm: Number.isFinite(distKm) ? distKm : null,
      coordinates: coord ? { lat: coord.lat, lng: coord.lng } : null,
      nominatim: null,
    },
  };
}

async function wikidataTourismFallbackSearch(locationName, limit = 40) {
  const parsedLimit = Number(limit);
  const hasResultLimit = Number.isFinite(parsedLimit) && parsedLimit > 0;
  const resultLimit = hasResultLimit ? Math.max(1, Math.floor(parsedLimit)) : null;
  const queries = buildFallbackQueries(locationName);
  const rawResults = [];
  for (const q of queries) {
    const found = await wikidataSearchEntities(
      q,
      hasResultLimit ? Math.max(1, Math.min(resultLimit, 50)) : 50
    );
    console.log('[open-source] wikidataSearchEntities', {
      locationName,
      query: q,
      found: found.length,
    });
    rawResults.push(...found);
  }

  const uniqueById = new Map();
  for (const r of rawResults) {
    const id = r?.id;
    if (id && !uniqueById.has(id)) uniqueById.set(id, r);
  }

  const ids = Array.from(uniqueById.keys());
  console.log('[open-source] unique raw ids', {
    locationName,
    raw: rawResults.length,
    unique: ids.length,
  });
  const entities = await wikidataGetEntitiesRaw(ids);

  const candidates = [];
  const idsToProcess = hasResultLimit ? ids.slice(0, resultLimit) : ids;
  for (const id of idsToProcess) {
    const e = entities[id];
    if (!e) continue;
    if (!isLikelyTourismEntity(e)) continue;

      const row = await toCandidateFromEntity({
        id,
        entity: e,
        fallbackLabel: uniqueById.get(id)?.label || null,
        distKm: null,
        locationHint: locationName,
      });
    if (!row) continue;
    candidates.push(row);
    if (hasResultLimit && candidates.length >= resultLimit) break;
  }

  console.log('[open-source] filtered candidates', {
    locationName,
    candidates: candidates.length,
  });

  return applyPriorityScores(candidates)
    .sort((a, b) => (b.ranking?.priority || 0) - (a.ranking?.priority || 0))
    .slice(0, hasResultLimit ? resultLimit : candidates.length);
}

async function wikidataTourismSearch(locationInput, limit = 40, options = {}) {
  const searchStartMs = Date.now();
  const parsedLimit = Number(limit);
  const hasResultLimit = Number.isFinite(parsedLimit) && parsedLimit > 0;
  const resultLimit = hasResultLimit ? Math.max(1, Math.floor(parsedLimit)) : null;
  const ctx =
    typeof locationInput === 'string'
      ? { name: locationInput, type: 'city', externalId: null }
      : {
          name: locationInput?.name || '',
          type: locationInput?.type || 'city',
          externalId: locationInput?.externalId || null,
        };

  let center = null;
  if (ctx.externalId) {
    const centerLookupStartMs = Date.now();
    const entities = await wikidataGetEntitiesRaw([ctx.externalId]);
    center = getEntityCoordinate(entities?.[ctx.externalId]);
    console.log('[open-source][timing] center lookup', {
      locationName: ctx.name,
      externalId: ctx.externalId,
      ms: Date.now() - centerLookupStartMs,
      found: !!center,
    });
  }

  const rootClassIds = Array.from(
    new Set(
      (Array.isArray(options?.rootClassIds) ? options.rootClassIds : [])
        .map((x) => String(x || '').trim().toUpperCase())
        .filter((x) => /^Q\d+$/.test(x))
    )
  );
  const classTargetByRootId = options?.classTargetByRootId || {};

  let primaryRows = [];
  if (center) {
    const radiusKm = resolveRadiusByLocationType(ctx.type);
    const targetCount = hasResultLimit ? resultLimit : null;
    const enrichmentBuffer = hasResultLimit
      ? Math.max(5, Math.min(20, Math.ceil(resultLimit * 0.4)))
      : 0;
    const fetchTargetCount = hasResultLimit ? targetCount + enrichmentBuffer : null;
    const refillBatchSize = Number.isFinite(Number(options?.refillBatchSize))
      ? Math.max(1, Number(options.refillBatchSize))
      : 10;
    const maxBatchRounds = Number.isFinite(Number(options?.maxBatchRounds))
      ? Math.max(1, Number(options.maxBatchRounds))
      : 4;
    const maxConcurrency = Number.isFinite(Number(options?.classQueryConcurrency))
      ? Math.max(1, Number(options.classQueryConcurrency))
      : 3;
    const activeRootClassIds = rootClassIds.length ? rootClassIds : Array.from(TOURISM_TYPE_IDS);

    const entityCache = new Map();

    let sparqlMs = 0;
    let entitiesMs = 0;

    const buildCandidatesStartMs = Date.now();
    const sparqlBatchStartMs = Date.now();
    const sparqlResult = await wikidataSparqlAroundByRootClasses({
      lng: center.lng,
      lat: center.lat,
      radiusKm,
      targetCount: fetchTargetCount,
      rootClassIds: activeRootClassIds,
      classTargetByRootId,
      refillBatchSize,
      maxRounds: maxBatchRounds,
      maxConcurrency,
    });
    sparqlMs += Date.now() - sparqlBatchStartMs;

    const rawRows = Array.isArray(sparqlResult?.rows) ? sparqlResult.rows : [];
    const fetchedRawRows = Number(sparqlResult?.fetchedRawRows || rawRows.length || 0);
    const batchRounds = Number(sparqlResult?.rounds || 1);
    const queryRequests = Number(sparqlResult?.queryRequests || 0);
    const classGroupCount = Number(sparqlResult?.classGroupCount || 0);
    const classChunkSize = Number(sparqlResult?.classChunkSize || 0);
    const perClassStats = Array.isArray(sparqlResult?.perClassStats)
      ? sparqlResult.perClassStats
      : [];

    const batchQids = rawRows
      .map((r) => parseQidFromUri(r?.item?.value))
      .filter(Boolean);
    const missingQids = batchQids.filter((qid) => !entityCache.has(qid));

    if (missingQids.length) {
      const entitiesStartMs = Date.now();
      const fetchedEntities = await wikidataGetEntitiesRaw(missingQids);
      entitiesMs += Date.now() - entitiesStartMs;
      for (const qid of missingQids) {
        entityCache.set(qid, fetchedEntities[qid] || null);
      }
    }

    const candidatesPool = [];
    for (const row of rawRows) {
      const qid = parseQidFromUri(row?.item?.value);
      if (!qid) continue;
      const rowCandidate = buildLightCandidateFromRow({
        row,
        entity: entityCache.get(qid) || null,
        classInfo: null,
      });
      if (!rowCandidate) continue;
      candidatesPool.push(rowCandidate);
    }

    const filteredPool = dropChildrenWhenParentPresent(dedupeCandidatesByIdOrSlug(candidatesPool));
    const buildCandidatesMs = Date.now() - buildCandidatesStartMs;
    const enrichStartMs = Date.now();

    const shortlist = filteredPool
      .sort((a, b) => {
        const s = (b?._preview?.sitelinksCount || 0) - (a?._preview?.sitelinksCount || 0);
        if (s !== 0) return s;
        const da = Number.isFinite(Number(a?._preview?.distanceKm)) ? Number(a._preview.distanceKm) : 1e9;
        const db = Number.isFinite(Number(b?._preview?.distanceKm)) ? Number(b._preview.distanceKm) : 1e9;
        return da - db;
      })
      .slice(0, hasResultLimit ? fetchTargetCount : filteredPool.length);

    const enrichedShortlist = await mapWithConcurrency(shortlist, 4, async (lightRow) => {
      const qid = lightRow?.externalId || lightRow?._preview?.placeId || null;
      if (!qid) return null;
      return toCandidateFromEntity({
        id: qid,
        entity: entityCache.get(qid) || null,
        fallbackLabel: lightRow?.name || null,
        distKm: Number(lightRow?._preview?.distanceKm || 0),
        locationHint: ctx.name,
        classIds: Array.isArray(lightRow?._preview?.classIds) ? lightRow._preview.classIds : [],
        classLabels: Array.isArray(lightRow?._preview?.classLabels) ? lightRow._preview.classLabels : [],
      });
    });
    const enrichMs = Date.now() - enrichStartMs;

    const enrichedFiltered = dropChildrenWhenParentPresent(
      dedupeCandidatesByIdOrSlug(enrichedShortlist.filter(Boolean))
    );

    const classCounter = new Map();
    for (const row of enrichedFiltered) {
      const labels = Array.isArray(row?._preview?.classLabels) ? row._preview.classLabels : [];
      for (const label of labels) {
        if (!label) continue;
        classCounter.set(label, (classCounter.get(label) || 0) + 1);
      }
    }
    const topClasses = Array.from(classCounter.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([label, count]) => ({ label, count }));

    primaryRows = enrichedFiltered
      .sort((a, b) => (b._preview?.sitelinksCount || 0) - (a._preview?.sitelinksCount || 0))
      .slice(0, hasResultLimit ? resultLimit : enrichedFiltered.length);

    console.log('[open-source][timing] sparql pipeline', {
      locationName: ctx.name,
      externalId: ctx.externalId,
      type: ctx.type,
      radiusKm,
      rootClassCount: activeRootClassIds.length,
      classGroupCount,
      classChunkSize,
      queryRequests,
      sparqlMs,
      entitiesMs,
      buildCandidatesMs,
      enrichMs,
      rawRows: fetchedRawRows,
      processedRows: candidatesPool.length,
      batchRounds,
      perClassStats,
      poolBeforeFilter: candidatesPool.length,
      poolAfterFilter: filteredPool.length,
      shortlisted: shortlist.length,
      enrichedAfterFilter: enrichedFiltered.length,
      topClasses,
      finalRows: primaryRows.length,
    });
  }

  const missing = hasResultLimit ? Math.max(0, resultLimit - primaryRows.length) : null;
  let fallbackRows = [];
  const shouldRunFallback = hasResultLimit ? missing > 0 : primaryRows.length === 0;
  if (shouldRunFallback && ctx.name) {
    const fallbackStartMs = Date.now();
    fallbackRows = await wikidataTourismFallbackSearch(ctx.name, hasResultLimit ? missing : null);
    const fallbackMs = Date.now() - fallbackStartMs;
    console.log('[open-source][timing] fallback search', {
      locationName: ctx.name,
      missing: hasResultLimit ? missing : 'unbounded',
      fallbackRows: fallbackRows.length,
      fallbackMs,
    });
  }

  const merged = applyPriorityScores(
    dropChildrenWhenParentPresent(dedupeCandidatesByIdOrSlug([...primaryRows, ...fallbackRows]))
  )
    .sort((a, b) => (b.ranking?.priority || 0) - (a.ranking?.priority || 0))
    .slice(0, hasResultLimit ? resultLimit : primaryRows.length + fallbackRows.length);

  console.log('[open-source][timing] final candidates', {
    locationName: ctx.name,
    limit: hasResultLimit ? resultLimit : 'unbounded',
    totalMs: Date.now() - searchStartMs,
    primary: primaryRows.length,
    fallback: fallbackRows.length,
    returned: merged.length,
  });
  return merged;
}

async function wikidataSearchSingleActivityByText({
  term = '',
  locationInput = null,
  rootClassIds = [],
  limit = 8,
  preferredExternalId = null,
}) {
  const safeTerm = String(term || '').trim();
  const preferredId = String(preferredExternalId || '').trim().toUpperCase();
  if (!safeTerm && !/^Q\d+$/.test(preferredId)) return [];

  const ctx =
    typeof locationInput === 'string'
      ? { name: locationInput, type: 'city', externalId: null }
      : {
          name: locationInput?.name || '',
          type: locationInput?.type || 'city',
          externalId: locationInput?.externalId || null,
        };

  let center = null;
  if (ctx.externalId) {
    const entities = await wikidataGetEntitiesRaw([ctx.externalId]);
    center = getEntityCoordinate(entities?.[ctx.externalId]);
  }

  const safeRootClassIds = Array.from(
    new Set(
      (Array.isArray(rootClassIds) ? rootClassIds : [])
        .map((x) => String(x || '').trim().toUpperCase())
        .filter((x) => /^Q\d+$/.test(x))
    )
  );
  const roots = safeRootClassIds.length ? safeRootClassIds : Array.from(TOURISM_TYPE_IDS);
  const rootsSet = new Set(roots);

  const queries = Array.from(
    new Set(
      [
        safeTerm ? (ctx.name ? `${safeTerm} ${ctx.name}` : safeTerm) : null,
        safeTerm || null,
      ].filter(Boolean)
    )
  );

  const rawResults = [];
  for (const q of queries) {
    const found = await wikidataSearchEntities(q, Math.max(10, limit * 3));
    rawResults.push(...found);
  }

  const uniqueById = new Map();
  for (const r of rawResults) {
    const id = r?.id;
    if (id && !uniqueById.has(id)) uniqueById.set(id, r);
  }

  const ids = Array.from(uniqueById.keys()).slice(0, Math.max(20, limit * 6));
  if (/^Q\d+$/.test(preferredId) && !ids.includes(preferredId)) {
    ids.unshift(preferredId);
  }
  const entities = await wikidataGetEntitiesRaw(ids);
  const hierarchyMatches = await wikidataEntitiesMatchAnyRootClass(ids, roots);
  const radiusKm = resolveRadiusByLocationType(ctx.type);
  const maxDistanceKm = radiusKm * 1.5;

  const candidates = [];
  const broadCandidates = [];
  for (const id of ids) {
    const entity = entities[id];
    if (!entity) continue;

    const typeIds = wikidataTypeIds(entity);
    const label = entity?.labels?.en?.value || uniqueById.get(id)?.label || '';
    const description = entity?.descriptions?.en?.value || '';
    const textMatchScore =
      (safeTerm && includesNormalized(label, safeTerm) ? 2 : 0) +
      (safeTerm && includesNormalized(description, safeTerm) ? 1 : 0);
    const isPreferred = /^Q\d+$/.test(preferredId) && String(id).toUpperCase() === preferredId;
    if (!isPreferred && safeTerm && textMatchScore <= 0) continue;

    const directMatch = typeIds.some((x) => rootsSet.has(String(x).toUpperCase()));
    const hierarchyMatch = hierarchyMatches.has(String(id).toUpperCase());
    const classMatched = directMatch || hierarchyMatch;

    const coord = getEntityCoordinate(entity);
    let distKm = null;
    if (center && coord) {
      const distM = haversineMeters(center.lat, center.lng, coord.lat, coord.lng);
      distKm = Number((distM / 1000).toFixed(3));
      if (distKm > maxDistanceKm) continue;
    }

    const row = await toCandidateFromEntity({
      id,
      entity,
      fallbackLabel: label || null,
      distKm,
      locationHint: ctx.name,
      classIds: typeIds,
      classLabels: [],
    });
    if (!row) continue;
    row._preview = {
      ...(row._preview || {}),
      textMatchScore,
      isPreferredMatch: isPreferred,
      classMatched,
    };

    // Keep strict class-matched results as primary.
    if (classMatched || isPreferred) {
      candidates.push(row);
      continue;
    }

    // Keep a broad fallback pool for explicit search terms when strict class filters
    // return nothing (useful for valid POIs with atypical P31 trees).
    broadCandidates.push(row);
  }

  const baseList = candidates.length ? candidates : broadCandidates;
  return applyPriorityScores(dedupeCandidatesByIdOrSlug(baseList))
    .sort((a, b) => {
      const pa1 = a?._preview?.isPreferredMatch ? 1 : 0;
      const pb1 = b?._preview?.isPreferredMatch ? 1 : 0;
      if (pb1 !== pa1) return pb1 - pa1;
      const ta = Number(a?._preview?.textMatchScore || 0);
      const tb = Number(b?._preview?.textMatchScore || 0);
      if (tb !== ta) return tb - ta;
      const pa = Number(a?.ranking?.priority || 0);
      const pb = Number(b?.ranking?.priority || 0);
      if (pb !== pa) return pb - pa;
      const da = Number.isFinite(Number(a?._preview?.distanceKm)) ? Number(a._preview.distanceKm) : 1e9;
      const db = Number.isFinite(Number(b?._preview?.distanceKm)) ? Number(b._preview.distanceKm) : 1e9;
      return da - db;
    })
    .slice(0, Math.max(1, limit));
}

module.exports = {
  wikidataTourismSearch,
  wikidataSearchSingleActivityByText,
  wikidataSearchEntities,
  wikidataGetEntitiesRaw,
  wikidataSparqlAroundTouristAttractions,
  wikidataTypeIds,
  isLikelyTourismEntity,
};
