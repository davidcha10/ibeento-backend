const googlePlacesService = require('../services/google-places.service');
const City = require('../models/City');
const Region = require('../models/Region');
const Country = require('../models/Country');
const Zone = require('../models/Zone');
const {
  findTaxonomyByQid,
  resolveZoneDisplayTypeLabel
} = require('../services/zones/zone-type-taxonomy.service');
const { models } = require('mongoose');

// Idiomas soportados para nombres/slugs de lugares.
// Puedes ajustar esta lista según necesidades reales.
const SUPPORTED_LOCALES = [
  'en',    // Inglés
  'zh-CN', // Chino simplificado
  'es',    // Español
  'de',    // Alemán
  'fr',    // Francés
  'ja',    // Japonés
  'ru',    // Ruso
  'it',    // Italiano
  'pt',    // Portugués
  'ar',    // Árabe
  'ko',    // Coreano
  'nl',    // Neerlandés
  'sv',    // Sueco
  'pl',    // Polaco
  'hi',    // Hindi
  'id',    // Indonesio
  'tr',    // Turco
  'th',    // Tailandés
  'vi',    // Vietnamita
  'uk',    // Ucraniano
  'he',    // Hebreo
];

// Helper simple para generar slugs a partir de un nombre.
// - Para textos con letras latinas: normaliza a ASCII y deja solo [a-z0-9-].
// - Para textos sin letras latinas (chino, japonés, árabe, etc.): conserva los caracteres
//   y solo limpia espacios y algunos signos de puntuación.
function slugifyName(value) {
  if (!value) return '';
  const raw = String(value).trim();
  if (!raw) return '';

  // ¿Contiene letras latinas?
  const hasLatin = /[A-Za-z]/.test(raw);

  if (hasLatin) {
    return raw
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // quitar acentos
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-') // todo lo que no sea alfanumérico -> '-'
      .replace(/^-+|-+$/g, ''); // recortar guiones al inicio/fin
  }

  // Sin letras latinas: mantenemos los caracteres originales (chino, japonés, etc.)
  // y solo normalizamos espacios y cierta puntuación.
  return raw
    .normalize('NFKC')
    .replace(/\s+/g, '-') // espacios -> guion
    .replace(/[、，。,\.！？!?:;'"()【】\[\]{}]/g, '') // quitar algunos signos de puntuación comunes
    .replace(/^-+|-+$/g, '');
}


function buildNamesAndSlugs(detailsByLang, level, fallbackName = null, options = {}) {
  const countryNameOpt = options.countryName || null;
  const regionNameOpt = options.regionName || null;

  const names = {};
  const slugs = {};

  if (detailsByLang && typeof detailsByLang === 'object') {
    for (const [lang, det] of Object.entries(detailsByLang)) {
      if (!det) continue;

      let raw = null;
      if (level === 'country') raw = det.country;
      else if (level === 'region') raw = det.region;
      else if (level === 'city') raw = det.city;

      if (!raw) continue;
      const value = String(raw).trim();
      if (!value) continue;

      names[lang] = value;

      let slugBase = value;
      if (level === 'region') {
        // region-country
        slugBase = `${value}-${countryNameOpt || ''}`;
      } else if (level === 'city') {
        // city-region-country
        slugBase = `${value}-${regionNameOpt || ''}-${countryNameOpt || ''}`;
      }
      slugs[lang] = slugifyName(slugBase);
    }
  }

  // Si tenemos un fallbackName y no se usó en ningún idioma, lo guardamos al menos en 'en' como respaldo.
  if (fallbackName && !Object.values(names).includes(fallbackName)) {
    const safe = String(fallbackName).trim();
    if (safe) {
      if (!names.en) {
        names.en = safe;

        let slugBase = safe;
        if (level === 'region') {
          slugBase = `${safe}-${countryNameOpt || ''}`;
        } else if (level === 'city') {
          slugBase = `${safe}-${regionNameOpt || ''}-${countryNameOpt || ''}`;
        }
        slugs.en = slugifyName(slugBase);
      }
    }
  }

  const primaryName =
    names.en ||
    names.es ||
    fallbackName ||
    Object.values(names)[0] ||
    null;

  return { name: primaryName, names, slugs };
}

function buildNamesAndSlugsFromLabels(labelsByLang = {}, level, fallbackName = null, options = {}) {
  const countryNameOpt = options.countryName || null;
  const regionNameOpt = options.regionName || null;

  const names = {};
  const slugs = {};

  for (const locale of SUPPORTED_LOCALES) {
    const label = labelsByLang[locale];
    if (!label) continue;
    const value = String(label).trim();
    if (!value) continue;
    names[locale] = value;

    let slugBase = value;
    if (level === 'region') {
      slugBase = `${value}-${countryNameOpt || ''}`;
    } else if (level === 'city') {
      slugBase = `${value}-${regionNameOpt || ''}-${countryNameOpt || ''}`;
    }
    slugs[locale] = slugifyName(slugBase);
  }

  if (fallbackName && !Object.values(names).includes(fallbackName)) {
    const safe = String(fallbackName).trim();
    if (safe && !names.en) {
      names.en = safe;
      let slugBase = safe;
      if (level === 'region') {
        slugBase = `${safe}-${countryNameOpt || ''}`;
      } else if (level === 'city') {
        slugBase = `${safe}-${regionNameOpt || ''}-${countryNameOpt || ''}`;
      }
      slugs.en = slugifyName(slugBase);
    }
  }

  const primaryName =
    names.en ||
    fallbackName ||
    names.es ||
    Object.values(names)[0] ||
    null;

  return { name: primaryName, names, slugs };
}

const wikidataSubclassCache = new Map();
const wikidataTypeResolveCache = new Map();
const wikidataTypeCodeResolveCache = new Map();
const wikidataTimeZoneCache = new Map();
const geoTimeZoneCache = new Map();
let wikidataBackoffUntil = 0;

const GENERIC_TYPE_CODES = new Set([
  'country',
  'region',
  'city',
  'neighborhood',
  'administrative_territorial_entity',
]);

function parseWikidataNumericAmount(amount) {
  if (amount == null) return null;
  const n = Number(String(amount).replace('+', ''));
  return Number.isFinite(n) ? n : null;
}

function isIanaRegionTimeZone(value) {
  const s = String(value || '').trim();
  if (!s) return false;
  // Solo formato tipo America/Bogota, Europe/Madrid, Asia/Tokyo...
  // Excluye UTC+xx y Etc/*
  if (s.startsWith('Etc/')) return false;
  return /^[A-Za-z_]+(?:\/[A-Za-z0-9_\-+]+)+$/.test(s);
}

function extractIanaFromWikidataEntityText(entity) {
  if (!entity) return null;

  const candidates = [];
  const labels = entity?.labels || {};
  for (const v of Object.values(labels)) {
    if (v?.value) candidates.push(String(v.value));
  }

  const aliases = entity?.aliases || {};
  for (const list of Object.values(aliases)) {
    for (const a of list || []) {
      if (a?.value) candidates.push(String(a.value));
    }
  }

  for (const raw of candidates) {
    const text = String(raw || '').trim();
    if (!text) continue;
    if (isIanaRegionTimeZone(text)) return text;
    // Captura si viene embebido, ej: "Japan Standard Time (Asia/Tokyo)"
    const match = text.match(/([A-Za-z_]+\/[A-Za-z0-9_\-+]+)/);
    if (match && isIanaRegionTimeZone(match[1])) return match[1];
  }

  return null;
}

function getWikidataCoordinates(entity) {
  const coord = getWikidataClaimValue(entity, 'P625');
  const lat = Number(coord?.latitude);
  const lng = Number(coord?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

async function resolveTimeZoneFromCoordinates(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  if (geoTimeZoneCache.has(key)) return geoTimeZoneCache.get(key);

  try {
    const url =
      'https://api.open-meteo.com/v1/forecast' +
      `?latitude=${encodeURIComponent(lat)}` +
      `&longitude=${encodeURIComponent(lng)}` +
      '&current=temperature_2m';
    const res = await fetch(url, {
      headers: { 'User-Agent': 'TripPlannerSeed/1.0 (contact@example.com)' }
    });
    const data = await res.json();
    const tz = data?.timezone;
    const finalTz = isIanaRegionTimeZone(tz) ? String(tz).trim() : null;
    geoTimeZoneCache.set(key, finalTz);
    return finalTz;
  } catch (_err) {
    geoTimeZoneCache.set(key, null);
    return null;
  }
}

async function resolveWikidataTimeZoneQid(qid) {
  const key = String(qid || '').toUpperCase();
  if (!key) return null;
  if (wikidataTimeZoneCache.has(key)) return wikidataTimeZoneCache.get(key);

  try {
    const entities = await wikidataGetEntities([key]);
    const entity = entities?.[key];
    if (!entity) {
      wikidataTimeZoneCache.set(key, null);
      return null;
    }

    const ianaFromText = extractIanaFromWikidataEntityText(entity);
    if (ianaFromText) {
      wikidataTimeZoneCache.set(key, ianaFromText);
      return ianaFromText;
    }

    // P2907: UTC offset (quantity). Ej: +9
    const offsetClaims = entity?.claims?.P2907 || [];
    const offsetValues = offsetClaims
      .map((c) => parseWikidataNumericAmount(c?.mainsnak?.datavalue?.value?.amount))
      .filter((n) => Number.isFinite(n));

    if (offsetValues.length) {
      // Con P2907 solo tenemos offset, no una zona IANA regional exacta.
      wikidataTimeZoneCache.set(key, null);
      return null;
    }

    // P8885 a veces viene como "UTC+9"
    const utcCode = getWikidataClaimValue(entity, 'P8885');
    if (utcCode && isIanaRegionTimeZone(utcCode)) {
      const normalized = String(utcCode).trim();
      wikidataTimeZoneCache.set(key, normalized);
      return normalized;
    }
  } catch (_err) {
    // Silencioso: timezone no debe romper resolución de lugar.
  }

  wikidataTimeZoneCache.set(key, null);
  return null;
}

async function getWikidataTimeZoneIana(entity) {
  const tzQids = getWikidataClaimsIds(entity, 'P421');
  if (!tzQids.length) return null;
  for (const qid of tzQids) {
    const resolved = await resolveWikidataTimeZoneQid(qid);
    if (resolved) return resolved;
  }
  return null;
}

function classifyWikidataTypes(typeIds = []) {
  return { type: 'city', typeCode: null };
}

function normalizeTaxonomyCanonicalType(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  const allowed = new Set([
    'country',
    'region',
    'province',
    'emirate',
    'city',
    'town',
    'village',
    'commune',
    'neighborhood',
    'locality',
    'district',
    'subdistrict',
  ]);
  if (allowed.has(raw)) return raw;
  return null;
}

async function classifyWikidataTypesFromTaxonomy(typeIds = []) {
  const candidates = [];
  for (let idx = 0; idx < typeIds.length; idx += 1) {
    const id = typeIds[idx];
    const qid = String(id || '').toUpperCase();
    if (!qid) continue;
    const doc = await findTaxonomyByQid(qid);
    if (!doc || doc.active === false) continue;
    const normalizedType = normalizeTaxonomyCanonicalType(doc.canonicalType);
    if (!normalizedType) continue;
    candidates.push({
      type: normalizedType,
      typeCode: doc.typeCode || null,
      priority: Number.isFinite(doc.priority) ? doc.priority : 100,
      idx
    });
  }
  if (!candidates.length) return null;

  candidates.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    const aIsGeneric = GENERIC_TYPE_CODES.has(String(a.typeCode || ''));
    const bIsGeneric = GENERIC_TYPE_CODES.has(String(b.typeCode || ''));
    if (aIsGeneric !== bIsGeneric) return aIsGeneric ? 1 : -1;
    return a.idx - b.idx;
  });

  return { type: candidates[0].type, typeCode: candidates[0].typeCode };
}

async function getWikidataSubclassParents(qid) {
  if (wikidataSubclassCache.has(qid)) return wikidataSubclassCache.get(qid);
  const entities = await wikidataGetEntities([qid]);
  const entity = entities?.[qid];
  const parents = getWikidataClaimsIds(entity, 'P279');
  wikidataSubclassCache.set(qid, parents);
  return parents;
}

async function resolveTypeCategoryBySubclass(typeId, maxDepth = 4) {
  if (wikidataTypeResolveCache.has(typeId)) return wikidataTypeResolveCache.get(typeId);
  if (isWikidataBackoffActive()) return null;

  const visited = new Set();
  let frontier = [typeId];
  let depth = 0;

  while (frontier.length && depth <= maxDepth) {
    const next = [];
    for (const id of frontier) {
      if (!id || visited.has(id)) continue;
      visited.add(id);

      const taxonomyDoc = await findTaxonomyByQid(id);
      const taxonomyType = normalizeTaxonomyCanonicalType(taxonomyDoc?.canonicalType);
      if (taxonomyType) {
        wikidataTypeResolveCache.set(typeId, taxonomyType);
        return taxonomyType;
      }

      const parents = await getWikidataSubclassParents(id);
      for (const parentId of parents) {
        if (!visited.has(parentId)) next.push(parentId);
      }
    }
    frontier = next;
    depth += 1;
  }

  wikidataTypeResolveCache.set(typeId, null);
  return null;
}

async function resolveTypeCodeFromTaxonomy(typeId, category) {
  const qid = String(typeId || '').toUpperCase();
  if (!qid || !category) return null;
  const doc = await findTaxonomyByQid(qid);
  if (!doc || doc.active === false) return null;
  const taxonomyType = normalizeTaxonomyCanonicalType(doc.canonicalType);
  if (!taxonomyType || taxonomyType !== category) return null;
  return doc.typeCode || null;
}

async function resolveTypeCodeBySubclass(typeId, category, maxDepth = 4) {
  if (!typeId || !category) return null;
  const key = `${String(category)}:${String(typeId).toUpperCase()}`;
  if (wikidataTypeCodeResolveCache.has(key)) return wikidataTypeCodeResolveCache.get(key);
  if (isWikidataBackoffActive()) return null;

  const visited = new Set();
  let frontier = [String(typeId).toUpperCase()];
  let depth = 0;
  const candidates = [];

  while (frontier.length && depth <= maxDepth) {
    const next = [];
    for (const id of frontier) {
      if (!id || visited.has(id)) continue;
      visited.add(id);

      const code = await resolveTypeCodeFromTaxonomy(id, category);
      if (code) {
        candidates.push({ code, depth });
      }

      const parents = await getWikidataSubclassParents(id);
      for (const parentId of parents) {
        if (!visited.has(parentId)) next.push(parentId);
      }
    }
    frontier = next;
    depth += 1;
  }

  if (candidates.length) {
    // Prefer specific codes (e.g. district) over generic ones
    // even if generic appears one level earlier.
    const specific = candidates.filter((c) => !GENERIC_TYPE_CODES.has(c.code));
    const pool = specific.length ? specific : candidates;
    pool.sort((a, b) => a.depth - b.depth || a.code.localeCompare(b.code));
    const best = pool[0].code;
    wikidataTypeCodeResolveCache.set(key, best);
    return best;
  }

  wikidataTypeCodeResolveCache.set(key, null);
  return null;
}

async function resolveTypeQidByCode(typeIds = [], category = null, targetCode = null, maxDepth = 4) {
  if (!Array.isArray(typeIds) || !typeIds.length || !category || !targetCode) return null;

  const matches = [];
  let bestSteps = null;

  for (let typeIndex = 0; typeIndex < typeIds.length; typeIndex += 1) {
    const rawId = typeIds[typeIndex];
    const startId = String(rawId || '').toUpperCase();
    if (!startId) continue;

    const directTaxonomyCode = await resolveTypeCodeFromTaxonomy(startId, category);
    if (directTaxonomyCode && directTaxonomyCode === targetCode) {
      matches.push({ qid: startId, steps: 0, typeIndex });
      bestSteps = 0;
      break;
    }

    const visited = new Set();
    let frontier = [startId];
    let depth = 0;
    let localMatch = null;

    while (frontier.length && depth <= maxDepth) {
      if (bestSteps != null && depth > bestSteps) break;
      const next = [];
      for (const id of frontier) {
        if (!id || visited.has(id)) continue;
        visited.add(id);

        const taxonomyCode = await resolveTypeCodeFromTaxonomy(id, category);
        if (taxonomyCode && taxonomyCode === targetCode) {
          localMatch = { qid: id, steps: depth, typeIndex };
          break;
        }

        const parents = await getWikidataSubclassParents(id);
        for (const parentId of parents) {
          if (!visited.has(parentId)) next.push(parentId);
        }
      }
      if (localMatch) break;
      frontier = next;
      depth += 1;
    }
    if (localMatch) {
      matches.push(localMatch);
      if (bestSteps == null || localMatch.steps < bestSteps) {
        bestSteps = localMatch.steps;
      }
      if (bestSteps === 0) break;
    }
  }

  if (!matches.length) return null;
  matches.sort((a, b) => {
    if (a.steps !== b.steps) return a.steps - b.steps;
    if (a.typeIndex !== b.typeIndex) return a.typeIndex - b.typeIndex;
    return String(a.qid || '').localeCompare(String(b.qid || ''));
  });
  return { qid: matches[0].qid, steps: matches[0].steps };
}

async function classifyWikidataTypesBySubclass(typeIds = []) {
  for (const id of typeIds) {
    const category = await resolveTypeCategoryBySubclass(id);
    if (!category) continue;

    // Resolve type code from taxonomy (direct or via P279 traversal).
    let typeCode = await resolveTypeCodeFromTaxonomy(id, category);
    if (!typeCode) {
      typeCode = await resolveTypeCodeBySubclass(id, category);
    }

    return { type: category, typeCode: typeCode || null };
  }
  return null;
}

// Rule: walk P31 -> P279 and choose the best match prioritizing fewer steps.
// Ties are resolved by original P31 order, then taxonomy priority.
async function findFirstTaxonomyMatch(typeIds = [], maxDepth = 6) {
  if (!Array.isArray(typeIds) || !typeIds.length) return null;

  const toUpperQid = (value) => String(value || '').toUpperCase();
  const buildPathToNode = (parentByChild, endQid) => {
    const path = [];
    let current = toUpperQid(endQid);
    while (current) {
      path.push(current);
      current = parentByChild.get(current) || null;
    }
    return path.reverse();
  };
  const buildTaxonomyCandidatesFromPath = (pathQids = []) =>
    pathQids
      .slice(0, -1)
      .map((qid, idx) => ({ qid: toUpperQid(qid), steps: idx }))
      .filter((row) => /^Q\d+$/.test(String(row.qid || '')));

  const matches = [];
  let bestSteps = null;

  for (let typeIndex = 0; typeIndex < typeIds.length; typeIndex += 1) {
    const rawId = typeIds[typeIndex];
    const startId = toUpperQid(rawId);
    if (!startId) continue;

    const visited = new Set();
    const parentByChild = new Map([[startId, null]]);
    let frontier = [startId];
    let depth = 0;
    let localBest = null;

    while (frontier.length && depth <= maxDepth) {
      if (bestSteps != null && depth > bestSteps) break;

      const next = [];
      for (const id of frontier) {
        if (!id || visited.has(id)) continue;
        visited.add(id);

        const taxonomyDoc = await findTaxonomyByQid(id);
        const normalizedType = normalizeTaxonomyCanonicalType(taxonomyDoc?.canonicalType);
        if (taxonomyDoc && taxonomyDoc.active !== false && normalizedType) {
          const pathQids = buildPathToNode(parentByChild, id);
          const candidate = {
            type: normalizedType,
            typeCode: taxonomyDoc.typeCode || null,
            matchedQid: toUpperQid(id),
            matchedSteps: depth,
            taxonomyId: taxonomyDoc?._id || null,
            wikidataName: taxonomyDoc?.wikidataName || null,
            taxonomyCandidates: buildTaxonomyCandidatesFromPath(pathQids),
            priority: Number.isFinite(Number(taxonomyDoc?.priority)) ? Number(taxonomyDoc.priority) : 100,
            typeIndex,
          };
          if (
            !localBest ||
            candidate.matchedSteps < localBest.matchedSteps ||
            (candidate.matchedSteps === localBest.matchedSteps && candidate.priority < localBest.priority)
          ) {
            localBest = candidate;
          }
          continue;
        }

        if (bestSteps != null && depth >= bestSteps) {
          continue;
        }

        const parents = await getWikidataSubclassParents(id);
        for (const parentIdRaw of parents) {
          const parentId = toUpperQid(parentIdRaw);
          if (!parentId) continue;
          if (!parentByChild.has(parentId)) {
            parentByChild.set(parentId, id);
          }
          if (!visited.has(parentId)) next.push(parentId);
        }
      }
      if (localBest) break;
      frontier = next;
      depth += 1;
    }

    if (localBest) {
      matches.push(localBest);
      if (bestSteps == null || localBest.matchedSteps < bestSteps) {
        bestSteps = localBest.matchedSteps;
      }
      if (bestSteps === 0) break;
    }
  }

  if (!matches.length) return null;

  matches.sort((a, b) => {
    if (a.matchedSteps !== b.matchedSteps) return a.matchedSteps - b.matchedSteps;
    if (a.typeIndex !== b.typeIndex) return a.typeIndex - b.typeIndex;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return String(a.matchedQid || '').localeCompare(String(b.matchedQid || ''));
  });

  const best = matches[0];
  return {
    type: best.type,
    typeCode: best.typeCode,
    matchedQid: best.matchedQid,
    matchedSteps: best.matchedSteps,
    taxonomyId: best.taxonomyId,
    wikidataName: best.wikidataName,
    taxonomyCandidates: Array.isArray(best.taxonomyCandidates) ? best.taxonomyCandidates : [],
  };
}

async function resolveBestTypeCodeForCategory(typeIds = [], category = null, currentTypeCode = null) {
  if (!category) return currentTypeCode || null;

  const candidates = [];
  if (currentTypeCode) candidates.push(currentTypeCode);

  for (const id of typeIds) {
    const taxonomyCode = await resolveTypeCodeFromTaxonomy(id, category);
    if (taxonomyCode) candidates.push(taxonomyCode);

    const bySubclass = await resolveTypeCodeBySubclass(id, category);
    if (bySubclass) candidates.push(bySubclass);
  }

  const unique = [...new Set(candidates.filter(Boolean))];
  if (!unique.length) return null;

  const specific = unique.find((code) => !GENERIC_TYPE_CODES.has(code));
  return specific || unique[0];
}

async function classifyWikidataTypesWithFallback(typeIds = [], fallbackToLoose = false) {
  // First try strict first-match rule (P31 order + P279 climb).
  let classified = await findFirstTaxonomyMatch(typeIds);
  if (classified) return { ...classified, taxonomyCandidates: classified.taxonomyCandidates || [] };

  // Legacy fallback path, kept for resilience.
  classified = await classifyWikidataTypesFromTaxonomy(typeIds);
  if (!classified && !isWikidataBackoffActive()) {
    try {
      classified = await classifyWikidataTypesBySubclass(typeIds);
    } catch (_err) {
      classified = null;
    }
  }
  if (classified) return { ...classified, taxonomyCandidates: [] };
  if (!fallbackToLoose) return null;
  const loose = classifyWikidataTypes(typeIds);
  return { ...loose, taxonomyCandidates: [] };
}

function getWikidataLabels(entity) {
  const labels = entity?.labels || {};
  const out = {};
  for (const locale of SUPPORTED_LOCALES) {
    const value = labels?.[locale]?.value;
    if (value) out[locale] = value;
  }
  return out;
}

function getWikidataLabelEn(entity) {
  return entity?.labels?.en?.value || null;
}

function getWikidataClaimsIds(entity, prop) {
  const claims = entity?.claims?.[prop] || [];
  return claims
    .map((c) => {
      const raw = c?.mainsnak?.datavalue?.value?.id;
      if (!raw) return null;
      const str = String(raw);
      const match = str.match(/(Q\d+)/i);
      return match ? match[1].toUpperCase() : str;
    })
    .filter(Boolean);
}

function getWikidataClaimValue(entity, prop) {
  const claims = entity?.claims?.[prop] || [];
  const value = claims?.[0]?.mainsnak?.datavalue?.value;
  return value ?? null;
}

function parseWikidataNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }
  if (typeof value === 'object' && value !== null) {
    const amount = value.amount ?? value.value;
    if (amount !== undefined) {
      const num = Number(String(amount).replace('+', ''));
      return Number.isFinite(num) ? num : null;
    }
  }
  return null;
}

function normalizeCommonsFileName(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  return raw.toLowerCase().startsWith('file:') ? raw.slice(5).trim() : raw;
}

function isUsableCoverFileName(fileName) {
  const s = String(fileName || '').trim().toLowerCase();
  if (!s) return false;
  if (s.endsWith('.svg')) return false;
  if (s.includes('map') || s.includes('flag') || s.includes('logo') || s.includes('coat of arms')) {
    return false;
  }
  return true;
}

function commonsFileUrl(fileName) {
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(fileName)}`;
}

function getWikidataCoverUrl(entity) {
  if (!entity) return null;
  const candidates = [
    getWikidataClaimValue(entity, 'P18'),
    getWikidataClaimValue(entity, 'P2716'),
    getWikidataClaimValue(entity, 'P3451'),
    getWikidataClaimValue(entity, 'P4291'),
    getWikidataClaimValue(entity, 'P8592'),
  ]
    .map(normalizeCommonsFileName)
    .filter(Boolean);

  const picked = candidates.find(isUsableCoverFileName) || candidates[0] || null;
  return picked ? commonsFileUrl(picked) : null;
}

function inferAdminLevel(type, typeCode) {
  if (type === 'country') return 0;

  if (type === 'region') {
    switch (typeCode) {
      case 'state':
      case 'province':
      case 'region':
      case 'autonomous_community':
      case 'republic':
      case 'administrative_territorial_entity':
        return 2;
      case 'sub_region':
        return 3;
      case 'department':
      case 'prefecture':
      case 'county':
      case 'oblast':
      case 'governorate':
      case 'metropolis':
        return 4;
      case 'arrondissement':
        return 5;
      case 'district':
        return 5;
      case 'canton':
        return 6;
      default:
        return 2;
    }
  }

  if (type === 'province') {
    return 2;
  }

  if (type === 'emirate') {
    return 2;
  }

  if (type === 'commune') {
    return 6;
  }

  if (type === 'subdistrict') {
    return 8;
  }

  if (type === 'town') {
    return 8;
  }

  if (type === 'city') {
    switch (typeCode) {
      case 'municipality':
      case 'commune':
        return 6;
      case 'special_wards':
        return 7;
      case 'city':
      case 'town':
      case 'village':
      case 'hamlet':
      default:
        return 8;
    }
  }

  if (type === 'neighborhood') {
    switch (typeCode) {
      case 'district':
      case 'borough':
      case 'ward':
        return 7;
      case 'neighborhood':
      case 'suburb':
      case 'locality':
      case 'commune':
      case 'parish':
      default:
        return 9;
    }
  }

  if (type === 'district') {
    switch (typeCode) {
      case 'arrondissement':
      case 'district':
        return 5;
      case 'borough':
      case 'ward':
        return 7;
      case 'neighborhood':
      case 'suburb':
      case 'locality':
      case 'commune':
      case 'parish':
      default:
        return 9;
    }
  }

  return null;
}

function normalizeTypeCode(type, typeCode, typeIds = []) {
  if (!typeCode) return typeCode;
  if (String(typeCode).startsWith('wikidata:')) return null;
  return typeCode;
}

function assertNoGenericAdministrativeTypeCode({ typeCode, entityName, entityQid }) {
  const normalizedCode = String(typeCode || '').trim().toLowerCase();
  if (normalizedCode !== 'administrative_territorial_entity') return false;

  const safeName = String(entityName || '').trim() || 'Unknown entity';
  const safeQid = String(entityQid || '').trim().toUpperCase() || 'UNKNOWN_QID';
  // Do not block persistence; keep generic type and taxonomyCandidates for later audit.
  console.warn(
    `[locations.controller] generic taxonomy fallback kept for review: "${safeName}" (${safeQid}) -> administrative_territorial_entity`
  );
  return true;
}

function normalizeSearchTerm(term) {
  if (!term) return '';
  const normalized = term.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return normalized.trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildAccentInsensitiveRegex(term) {
  if (!term) return null;
  const map = {
    a: 'aáàäâãå',
    e: 'eéèëê',
    i: 'iíìïî',
    o: 'oóòöôõ',
    u: 'uúùüû',
    n: 'nñ',
    c: 'cç',
    y: 'yýÿ'
  };
  const chars = Array.from(term);
  const pattern = chars
    .map((ch) => {
      const lower = ch.toLowerCase();
      const group = map[lower];
      if (!group) return escapeRegExp(ch);
      return `[${group}${group.toUpperCase()}]`;
    })
    .join('');
  return new RegExp(`^${pattern}`, 'i');
}

function isWikidataBackoffActive() {
  return Date.now() < wikidataBackoffUntil;
}

async function readJsonResponse(res, label) {
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 429) {
      wikidataBackoffUntil = Date.now() + 60_000;
    }
    throw new Error(`[${label}] HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const text = await res.text();
    throw new Error(`[${label}] Non-JSON response: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function wikidataSearch(term, limit = 8, language = 'en') {
  if (isWikidataBackoffActive()) return [];
  const url =
    'https://www.wikidata.org/w/api.php' +
    `?action=wbsearchentities&search=${encodeURIComponent(term)}` +
    `&language=${encodeURIComponent(language)}` +
    `&format=json&limit=${limit}&origin=*`;

  const res = await fetch(url, { headers: { 'User-Agent': 'TripPlannerSeed/1.0 (contact@example.com)' } });
  const data = await readJsonResponse(res, 'wikidataSearch');
  return data?.search || [];
}

async function wikidataGetEntities(ids = []) {
  if (!ids.length) return {};
  if (isWikidataBackoffActive()) return {};
  const url =
    'https://www.wikidata.org/w/api.php' +
    `?action=wbgetentities&ids=${encodeURIComponent(ids.join('|'))}` +
    '&props=labels|aliases|claims&format=json&origin=*';
  const res = await fetch(url, { headers: { 'User-Agent': 'TripPlannerSeed/1.0 (contact@example.com)' } });
  const data = await readJsonResponse(res, 'wikidataGetEntities');
  return data?.entities || {};
}

async function wikidataSuggest(term, limit = 8) {
  const languages = ['en', 'es'];
  const normalizedTerm = normalizeSearchTerm(term);
  const termsToSearch = normalizedTerm && normalizedTerm !== term ? [term, normalizedTerm] : [term];

  const searches = [];
  for (const lang of languages) {
    for (const t of termsToSearch) {
      searches.push(wikidataSearch(t, limit, lang));
    }
  }

  const searchBatches = await Promise.all(searches);
  const searchResults = searchBatches.flat().reduce((acc, item) => {
    if (!item || !item.id) return acc;
    if (acc.some((existing) => existing.id === item.id)) return acc;
    acc.push(item);
    return acc;
  }, []);

  const ids = searchResults.map((r) => r.id).filter(Boolean);
  const entities = await wikidataGetEntities(ids);

  const results = [];
  for (const r of searchResults) {
    const entity = entities?.[r.id];
    const typeIds = getWikidataClaimsIds(entity, 'P31');
    if (!typeIds.length) continue;

    let classified = null;
    let classificationError = false;
    try {
      classified = await classifyWikidataTypesWithFallback(typeIds, false);
    } catch (_err) {
      classificationError = true;
    }
    if (!classified) {
      if (classificationError) {
        results.push({
          label: r.label,
          placeId: r.id,
          type: undefined,
          typeCode: undefined,
          source: 'wikidata',
          _raw: { id: r.id, typeIds }
        });
      }
      continue;
    }

    results.push({
      label: r.label,
      placeId: r.id,
      type: classified.type,
      typeCode: classified.typeCode,
      source: 'wikidata',
      _raw: { id: r.id, typeIds }
    });
  }

  return results;
}

async function enrichWikidataSuggestionsWithContext(suggestions = [], maxToEnrich = 3) {
  if (!Array.isArray(suggestions) || !suggestions.length) return suggestions;

  const capped = suggestions.slice(0, Math.max(0, maxToEnrich));
  const qids = capped
    .map((s) => String(s?.placeId || '').toUpperCase())
    .filter((id) => /^Q\d+$/.test(id));

  if (!qids.length) return suggestions;

  const entities = await wikidataGetEntities(qids);
  const entityCache = new Map(Object.entries(entities || {}));

  const getEntityCached = async (qid) => {
    const normalized = String(qid || '').toUpperCase();
    if (!/^Q\d+$/.test(normalized)) return null;
    if (entityCache.has(normalized)) return entityCache.get(normalized) || null;
    const fetched = await wikidataGetEntities([normalized]);
    const entity = fetched?.[normalized] || null;
    entityCache.set(normalized, entity);
    return entity;
  };

  const enrichOne = (item) => {
    return item;
  };

  const enrichedPrefix = [];
  for (const item of capped) {
    const qid = String(item?.placeId || '').toUpperCase();
    if (!/^Q\d+$/.test(qid)) {
      enrichedPrefix.push(item);
      continue;
    }

    const entity = await getEntityCached(qid);
    if (!entity) {
      enrichedPrefix.push(item);
      continue;
    }

    const hierarchy = [];
    const visited = new Set([qid]);
    let currentEntity = entity;
    let countryQid = getWikidataClaimsIds(entity, 'P17')?.[0] || null;

    // Follow P131 chain upwards to build a readable admin chain.
    for (let depth = 0; depth < 8; depth += 1) {
      const parentQid = getWikidataClaimsIds(currentEntity, 'P131')?.[0] || null;
      if (!parentQid || visited.has(parentQid)) break;
      visited.add(parentQid);

      const parentEntity = await getEntityCached(parentQid);
      if (!parentEntity) break;

      const parentName = getWikidataLabelEn(parentEntity);
      if (parentName) {
        hierarchy.push({ name: parentName, externalId: parentQid });
      }

      if (!countryQid) {
        countryQid = getWikidataClaimsIds(parentEntity, 'P17')?.[0] || null;
      }
      currentEntity = parentEntity;
    }

    let country = undefined;
    if (countryQid) {
      const countryEntity = await getEntityCached(countryQid);
      const countryName = countryEntity ? getWikidataLabelEn(countryEntity) : null;
      if (countryName) {
        country = { name: countryName, externalId: countryQid };
        const hasCountryInHierarchy = hierarchy.some(
          (entry) => String(entry?.externalId || '').toUpperCase() === String(countryQid).toUpperCase()
        );
        if (!hasCountryInHierarchy) {
          hierarchy.push({ name: countryName, externalId: countryQid });
        }
      }
    }

    const region = hierarchy.length ? hierarchy[0] : undefined;
    const adminChain = hierarchy.map((entry) => entry.name).filter(Boolean);

    enrichedPrefix.push({
      ...item,
      region,
      country,
      adminChain,
      adminChainLabel: adminChain.join(', '),
    });
  }

  if (capped.length === suggestions.length) return enrichedPrefix;
  return [...enrichedPrefix, ...suggestions.slice(capped.length)];
}

/**
 * Llama a getPlaceDetails en varios idiomas y devuelve un mapa { lang: details }.
 */
async function fetchDetailsInAllLangs(placeId) {
  const entries = await Promise.all(
    SUPPORTED_LOCALES.map(async (lang) => {
      try {
        const det = await googlePlacesService.getPlaceDetails(placeId, { languageCode: lang });
        return [lang, det];
      } catch (err) {
        console.error(
          `[locations.controller] getPlaceDetails error for lang ${lang}:`,
          err
        );
        return [lang, null];
      }
    })
  );

  const detailsByLang = {};
  for (const [lang, det] of entries) {
    if (det) {
      detailsByLang[lang] = det;
    }
  }
  return detailsByLang;
}

exports.suggest = async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    const q = (req.query.q || '').trim();
    if (!q) return res.json([]);

    const limit = Math.min(parseInt(req.query.limit, 10) || 8, 20);
    const includeExternal = req.query.includeExternal === 'true';
    const wikidataContextMax = Math.min(Number(req.query.wikidataContextMax) || 3, 5);

    // 1) Siempre buscamos primero en BD
    const normalizedQ = normalizeSearchTerm(q);
    const regex = new RegExp(`^${escapeRegExp(q)}`, 'i');
    const normalizedRegex = normalizedQ && normalizedQ !== q
      ? new RegExp(`^${escapeRegExp(normalizedQ)}`, 'i')
      : null;
    const accentRegex = buildAccentInsensitiveRegex(q);
    const nameRegexes = [regex, normalizedRegex, accentRegex].filter(Boolean);
    const nameQuery = nameRegexes.length > 1
      ? { $or: nameRegexes.map((r) => ({ name: r })) }
      : { name: nameRegexes[0] || regex };

    const zoneDocs = await Zone.find({
      ...nameQuery,
      active: true,
    })
      .limit(limit)
      .populate('parentCountryId', 'name externalId')
      .populate('parentZoneId', 'name externalId taxonomySnapshot type canonicalType')
      .collation({ locale: 'en', strength: 1 })
      .lean();

    const ancestryIds = Array.from(
      new Set(
        zoneDocs
          .flatMap((z) => (Array.isArray(z?.ancestry) ? z.ancestry : []))
          .map((id) => String(id))
      )
    );

    const ancestryDocs = ancestryIds.length
      ? await Zone.find({ _id: { $in: ancestryIds } })
          .select('name externalId taxonomySnapshot type canonicalType')
          .lean()
      : [];

    const ancestryById = new Map(ancestryDocs.map((doc) => [String(doc._id), doc]));

    const getCanonicalType = (zone) =>
      zone?.taxonomySnapshot?.canonicalType ||
      zone?.canonicalType ||
      zone?.taxonomySnapshot?.type ||
      zone?.type ||
      null;

    const buildAdminChain = (zone) => {
      const chain = [];
      const ancestry = Array.isArray(zone?.ancestry) ? zone.ancestry : [];
      for (const aid of ancestry) {
        const ancestor = ancestryById.get(String(aid));
        if (ancestor?.name) chain.push(ancestor.name);
      }
      const parentZoneName = zone?.parentZoneId?.name;
      if (parentZoneName && (chain.length === 0 || chain[chain.length - 1] !== parentZoneName)) {
        chain.push(parentZoneName);
      }
      const countryName = zone?.parentCountryId?.name;
      if (countryName && !chain.includes(countryName)) {
        chain.push(countryName);
      }
      return chain;
    };

    const dbExternalIds = new Set(
      zoneDocs
        .map((doc) => doc?.externalId)
        .filter(Boolean)
        .map((id) => String(id))
    );

    const dbSuggestions = zoneDocs.map((z) => {
      const canonicalType = String(getCanonicalType(z) || 'zone').toLowerCase();
      const type = canonicalType;
      const chain = buildAdminChain(z);
      const country = z?.parentCountryId?.name
        ? { name: z.parentCountryId.name, externalId: z.parentCountryId.externalId || null }
        : undefined;
      const region = z?.parentZoneId?.name
        ? { name: z.parentZoneId.name, externalId: z.parentZoneId.externalId || null }
        : undefined;

      return {
        label: z.name,
        type,
        canonicalType,
        _id: z._id,
        externalId: z.externalId || undefined,
        source: 'db',
        region,
        country,
        adminChain: chain,
        adminChainLabel: chain.join(', '),
      };
    });

    // === MODO POR DEFECTO (includeExternal = false) ===
    if (!includeExternal) {
      return res.json(dbSuggestions.slice(0, limit));
    }

    // === MODO includeExternal = true ===
    // Usamos BD + Wikidata, evitando duplicados
    let wikidataSuggestions = [];
    try {
      // Pull a wider candidate set from Wikidata, then trim in the final merge.
      const wikidataFetchLimit = Math.min(Math.max(limit * 3, 15), 50);
      wikidataSuggestions = await wikidataSuggest(q, wikidataFetchLimit);
    } catch (wdErr) {
      console.error('[locations.controller] suggest Wikidata error:', wdErr);
      wikidataSuggestions = [];
    }

    const existingLabels = new Set(
      dbSuggestions.map((s) => `${(s.label || '').toLowerCase().trim()}|${s.type || ''}`)
    );

    const uniqueWikidataSuggestions = (wikidataSuggestions || []).filter((s) => {
      if (dbExternalIds.has(String(s.placeId))) return false;
      const key = `${(s.label || '').toLowerCase().trim()}|${s.type || ''}`;
      if (!key) return false;
      if (existingLabels.has(key)) return false;
      existingLabels.add(key);
      return true;
    });

    if (!uniqueWikidataSuggestions.length) {
      return res.json(dbSuggestions.slice(0, limit));
    }

    // In "search on web" mode, reserve more room for external matches so
    // alternative entities (e.g. same name in different places) are visible.
    const preferredWiki = limit >= 5 ? 3 : (limit >= 3 ? 2 : 1);
    const maxWiki = Math.min(uniqueWikidataSuggestions.length, preferredWiki);
    const dbCount = Math.max(0, limit - maxWiki);
    let selectedWiki = uniqueWikidataSuggestions.slice(0, maxWiki);

    try {
      selectedWiki = await enrichWikidataSuggestionsWithContext(selectedWiki, wikidataContextMax);
    } catch (ctxErr) {
      console.error('[locations.controller] suggest Wikidata context enrichment error:', ctxErr);
    }

    const combined = [
      ...dbSuggestions.slice(0, dbCount),
      ...selectedWiki,
    ];
    return res.json(combined);
  } catch (err) {
    console.error('[locations.controller] suggest error:', err);
    return next(err);
  }
};


exports.resolve = async (req, res, next) => {
  try {
    const { placeId, type, source } = req.body || {};

    if (!placeId) {
      return res.status(400).json({ message: 'placeId is required' });
    }

    if (source === 'wikidata' || /^Q\d+$/i.test(placeId)) {
      const [locationResult, zonesSyncResult] = await Promise.allSettled([
        resolveWikidataPlace(placeId, type || null),
        syncWikidataZoneHierarchy(placeId),
      ]);

      if (locationResult.status === 'rejected') {
        throw locationResult.reason;
      }

      if (zonesSyncResult.status === 'rejected') {
        console.error('[locations.controller] zone hierarchy sync failed:', zonesSyncResult.reason);
      }

      const resolved = locationResult.value || {};
      const normalizedQid = String(placeId || '').toUpperCase();
      let selectedLabel = null;
      if (/^Q\d+$/.test(normalizedQid)) {
        try {
          const selectedEntityMap = await wikidataGetEntities([normalizedQid]);
          const selectedEntity = selectedEntityMap?.[normalizedQid] || null;
          selectedLabel = selectedEntity ? (getWikidataLabelEn(selectedEntity) || null) : null;
        } catch (labelErr) {
          console.error('[locations.controller] resolve label enrichment failed:', labelErr);
        }
      }

      return res.json({
        ...resolved,
        label: selectedLabel || resolved.label,
      });
    }

    // Obtenemos detalles en varios idiomas
    const detailsByLang = await fetchDetailsInAllLangs(placeId);
    console.log(detailsByLang);



    // Elegimos un detalle principal para lógica de tipo y país
    const mainDetails =
      detailsByLang.en ||
      detailsByLang.es ||
      Object.values(detailsByLang)[0];

    if (!mainDetails) {
      return res
        .status(404)
        .json({ message: 'Place not found or could not be resolved in any language' });
    }

    const cityName = (mainDetails.city || '').trim() || null;
    const regionName = (mainDetails.region || '').trim() || null;
    const countryName = (mainDetails.country || '').trim() || null;
    const countryIso =
      (mainDetails.countryIso || '').trim().toUpperCase() || null;

    if (!countryName && !countryIso) {
      // Si ni siquiera pudimos extraer país, devolvemos lo que tengamos de Google
      return res.status(400).json({
        message: 'Could not resolve country from place details',
        details: mainDetails,
      });
    }

    // 1) Aseguramos COUNTRY (con nombres/slugs en varios idiomas)
    const countryDoc = await ensureCountry(countryName, countryIso, detailsByLang);

    // 2) Aseguramos REGION (si aplica)
    let regionDoc = null;
    if (regionName) {
      regionDoc = await ensureRegion(regionName, countryDoc, detailsByLang);
    }

    // 3) Aseguramos CITY (si aplica)
    let cityDoc = null;
    if (cityName) {
      cityDoc = await ensureCity(cityName, countryDoc, regionDoc, detailsByLang);
    }

    // 4) Determinamos el tipo lógico final: city | region | country
    let finalType = type || null;
    if (!finalType) {
      if (cityDoc) finalType = 'city';
      else if (regionDoc) finalType = 'region';
      else finalType = 'country';
    }

    // 5) Construimos el objeto Location que el front espera
    let locationId = null;
    let label = null;

    if (finalType === 'city' && cityDoc) {
      locationId = cityDoc._id;
      label = cityDoc.name;
    } else if (finalType === 'region' && regionDoc) {
      locationId = regionDoc._id;
      label = regionDoc.name;
    } else {
      // Fallback a country
      locationId = countryDoc._id;
      label = countryDoc.name;
      finalType = 'country';
    }

    const location = {
      _id: locationId,
      type: finalType,
      label,
      // Enviamos los objetos completos de región y país para que el front tenga contexto
      region: regionDoc,
      country: countryDoc,
    };

    return res.json(location);
  } catch (err) {
    console.error('[locations.controller] resolve error:', err);
    return next(err);
  }
};

async function findExistingZoneByExternalQid(qid) {
  const normalized = String(qid || '').toUpperCase();
  if (!/^Q\d+$/.test(normalized)) return null;
  const zone = await Zone.findOne({ source: 'wikidata', externalId: normalized })
    .select('_id name taxonomySnapshot type externalId ancestry parentCountryId')
    .lean();
  if (!zone) return null;
  return {
    ...zone,
    type: zoneSnapshotType(zone),
  };
}

async function buildWikidataHierarchyChainToCountry(startQid, maxDepth = 12) {
  const start = String(startQid || '').toUpperCase();
  if (!/^Q\d+$/.test(start)) {
    return {
      chain: [],
      anchorParentZoneDoc: null,
      anchoredByExistingParent: false,
    };
  }

  const visited = new Set();
  const chain = [];
  let currentId = start;
  let fallbackCountryId = null;
  let anchorParentZoneDoc = null;
  let anchoredByExistingParent = false;

  for (let depth = 0; depth < maxDepth && currentId; depth += 1) {
    if (visited.has(currentId)) break;
    visited.add(currentId);

    const entities = await wikidataGetEntities([currentId]);
    const entity = entities?.[currentId];
    if (!entity) break;

    chain.push(entity);

    const countryIdClaim = getWikidataClaimsIds(entity, 'P17')?.[0] || null;
    if (!fallbackCountryId && countryIdClaim) {
      fallbackCountryId = countryIdClaim;
    }

    const typeIds = getWikidataClaimsIds(entity, 'P31');
    const classified = (await classifyWikidataTypesWithFallback(typeIds, true)) || { type: 'city', typeCode: null };
    if (classified.type === 'country') {
      break;
    }

    const parentId = getWikidataClaimsIds(entity, 'P131')?.[0] || null;
    if (parentId) {
      const existingParent = await findExistingZoneByExternalQid(parentId);
      if (existingParent) {
        anchorParentZoneDoc = existingParent;
        anchoredByExistingParent = true;
        break;
      }
      currentId = parentId;
      continue;
    }

    if (fallbackCountryId && !visited.has(fallbackCountryId)) {
      const existingCountryAnchor = await findExistingZoneByExternalQid(fallbackCountryId);
      if (existingCountryAnchor) {
        anchorParentZoneDoc = existingCountryAnchor;
        anchoredByExistingParent = true;
        break;
      }
      currentId = fallbackCountryId;
      fallbackCountryId = null;
      continue;
    }

    break;
  }

  const hasCountry = await (async () => {
    for (const entity of chain) {
      const typeIds = getWikidataClaimsIds(entity, 'P31');
      const classified = (await classifyWikidataTypesWithFallback(typeIds, true)) || { type: 'city', typeCode: null };
      if (classified.type === 'country') return true;
    }
    return false;
  })();

  if (!anchorParentZoneDoc && !hasCountry && fallbackCountryId && !visited.has(fallbackCountryId)) {
    const entities = await wikidataGetEntities([fallbackCountryId]);
    const countryEntity = entities?.[fallbackCountryId];
    if (countryEntity) chain.push(countryEntity);
  }

  return {
    chain,
    anchorParentZoneDoc,
    anchoredByExistingParent,
  };
}

function buildZoneNamesAndSlugs(labelsByLang = {}, fallbackName = null) {
  const names = {};
  const slugs = {};

  for (const [locale, value] of Object.entries(labelsByLang || {})) {
    if (typeof value !== 'string') continue;
    const clean = value.trim();
    if (!clean) continue;
    names[locale] = clean;
    slugs[locale] = slugifyName(clean);
  }

  const baseName =
    names.en ||
    fallbackName ||
    Object.values(names)[0] ||
    null;

  if (baseName && !names.en) {
    names.en = baseName;
    slugs.en = slugs.en || slugifyName(baseName);
  }

  return { name: baseName, names, slugs };
}

function objectIdEq(a, b) {
  if (!a || !b) return false;
  return String(a) === String(b);
}

function zoneSnapshotType(zone) {
  return zone?.taxonomySnapshot?.canonicalType || zone?.taxonomySnapshot?.type || zone?.canonicalType || zone?.type || null;
}

function zoneSnapshotTypeCode(zone) {
  return zone?.taxonomySnapshot?.typeCode || zone?.typeCode || null;
}

function zoneSnapshotTypeQid(zone) {
  return zone?.taxonomySnapshot?.qid || zone?.taxonomySnapshot?.typeQid || zone?.qid || zone?.typeQid || null;
}

async function ensureZoneFromWikidataEntity(entity, parentZoneDoc = null, parentCountryZoneDoc = null) {
  if (!entity) return null;

  const externalId = entity?.id ? String(entity.id).toUpperCase() : null;
  if (!externalId) return null;

  const labels = getWikidataLabels(entity);
  const nameEn = getWikidataLabelEn(entity);
  const { name: finalName, names, slugs } = buildZoneNamesAndSlugs(labels, nameEn || externalId);
  if (!finalName) return null;

  const typeIds = getWikidataClaimsIds(entity, 'P31');
  const classified = (await classifyWikidataTypesWithFallback(typeIds, true)) || { type: 'region', typeCode: null };
  const taxonomyCandidates = Array.isArray(classified?.taxonomyCandidates)
    ? classified.taxonomyCandidates
        .map((row) => ({
          qid: String(row?.qid || '').toUpperCase(),
          steps: Number.isFinite(Number(row?.steps)) ? Number(row.steps) : 0,
        }))
        .filter((row) => /^Q\d+$/.test(row.qid))
    : [];
  const normalizedTypeCode = normalizeTypeCode(classified.type, classified.typeCode, typeIds);
  const resolvedTypeCode = normalizedTypeCode || classified.typeCode || null;
  const isGenericAdministrativeFallback = assertNoGenericAdministrativeTypeCode({
    typeCode: resolvedTypeCode,
    entityName: finalName,
    entityQid: externalId
  });
  const canonicalTypeForSnapshot = isGenericAdministrativeFallback ? null : classified.type;
  const resolvedTypeMatch = await resolveTypeQidByCode(typeIds, classified.type, resolvedTypeCode);
  const resolvedTypeQid =
    classified?.matchedQid ||
    resolvedTypeMatch?.qid ||
    null;
  const resolvedTypeSteps =
    Number.isFinite(Number(classified?.matchedSteps))
      ? Number(classified.matchedSteps)
      : (Number.isFinite(Number(resolvedTypeMatch?.steps)) ? Number(resolvedTypeMatch.steps) : null);
  const resolvedTaxonomyDoc = resolvedTypeQid ? await findTaxonomyByQid(resolvedTypeQid) : null;

  const countryQidContext =
    (classified.type === 'country' ? externalId : null) ||
    (parentCountryZoneDoc?.externalId ? String(parentCountryZoneDoc.externalId).toUpperCase() : null);
  const displayTypeLabel = isGenericAdministrativeFallback
    ? null
    : await resolveZoneDisplayTypeLabel({
      qid: resolvedTypeQid,
      typeCode: resolvedTypeCode,
      canonicalType: classified.type,
      countryQid: countryQidContext,
      locale: 'en',
    });

  const explicitAdminLevel = parseWikidataNumber(getWikidataClaimValue(entity, 'P274'));
  const inferredAdminLevel = inferAdminLevel(classified.type, normalizedTypeCode || classified.typeCode);
  const desiredAdminLevel = Number.isFinite(explicitAdminLevel)
    ? explicitAdminLevel
    : (Number.isFinite(inferredAdminLevel) ? inferredAdminLevel : null);

  const coords = getWikidataCoordinates(entity);
  const geo = coords ? { type: 'Point', coordinates: [coords.lng, coords.lat] } : null;
  const cover = getWikidataCoverUrl(entity);

  const ancestry = parentZoneDoc ? [...(parentZoneDoc.ancestry || []), parentZoneDoc._id] : [];
  const level = ancestry.length + 1;

  let desiredParentCountryId = parentCountryZoneDoc?._id || parentZoneDoc?.parentCountryId || null;
  if (classified.type === 'country' && !desiredParentCountryId) {
    // países raíz apuntan a sí mismos como parentCountryId
    desiredParentCountryId = null;
  }

  let doc = await Zone.findOne({ source: 'wikidata', externalId });
  if (!doc) {
    const siblingQuery = {
      parentZoneId: parentZoneDoc?._id || null,
      slug: slugs.en || slugifyName(finalName),
    };
    doc = await Zone.findOne(siblingQuery);
  }

  if (!doc) {
    doc = await Zone.create({
      parentZoneId: parentZoneDoc?._id || null,
      parentCountryId: desiredParentCountryId,
      ancestry,
      name: finalName,
      names,
      officialName: null,
      officialNames: {},
      slug: slugs.en || slugifyName(finalName),
      slugs,
      taxonomySnapshot: {
        canonicalType: canonicalTypeForSnapshot,
        typeCode: resolvedTypeCode,
        qid: resolvedTypeQid || null,
        taxonomyId: resolvedTaxonomyDoc?._id || null,
        taxonomyCandidates,
        displayTypeLabel: displayTypeLabel || null,
        wikidataName: resolvedTaxonomyDoc?.wikidataName || null,
        numberOfSteps: resolvedTypeSteps,
        auditStatus: 'pending',
      },
      level,
      adminLevel: desiredAdminLevel,
      source: 'wikidata',
      externalId,
      cover: cover || null,
      geo: geo || undefined,
      active: true,
      priority: 100,
    });
  } else {
    let changed = false;

    if (!objectIdEq(doc.parentZoneId, parentZoneDoc?._id || null)) {
      doc.parentZoneId = parentZoneDoc?._id || null;
      changed = true;
    }
    if (!objectIdEq(doc.parentCountryId, desiredParentCountryId)) {
      doc.parentCountryId = desiredParentCountryId;
      changed = true;
    }
    if (JSON.stringify(doc.ancestry || []) !== JSON.stringify(ancestry)) {
      doc.ancestry = ancestry;
      changed = true;
    }
    if (doc.level !== level) {
      doc.level = level;
      changed = true;
    }
    if (!doc.name) {
      doc.name = finalName;
      changed = true;
    }
    doc.taxonomySnapshot = doc.taxonomySnapshot || {};
    if (isGenericAdministrativeFallback) {
      if (zoneSnapshotType(doc) != null) {
        doc.taxonomySnapshot.canonicalType = null;
        changed = true;
      }
      if (doc.taxonomySnapshot.displayTypeLabel != null) {
        doc.taxonomySnapshot.displayTypeLabel = null;
        changed = true;
      }
    } else if ((!zoneSnapshotType(doc) || zoneSnapshotType(doc) === 'zone') && classified.type) {
      doc.taxonomySnapshot.canonicalType = classified.type;
      changed = true;
    }
    const currentSteps = Number.isFinite(Number(doc?.taxonomySnapshot?.numberOfSteps))
      ? Number(doc.taxonomySnapshot.numberOfSteps)
      : null;
    const betterBySteps =
      Number.isFinite(Number(resolvedTypeSteps)) &&
      (
        currentSteps == null ||
        Number(resolvedTypeSteps) < currentSteps
      );
    const shouldRefreshTypeByQuality =
      betterBySteps ||
      (
        resolvedTypeQid &&
        zoneSnapshotTypeQid(doc) &&
        String(zoneSnapshotTypeQid(doc)).toUpperCase() !== String(resolvedTypeQid).toUpperCase() &&
        Number.isFinite(Number(resolvedTypeSteps))
      );

    if (
      resolvedTypeCode &&
      (
        !zoneSnapshotTypeCode(doc) ||
        String(zoneSnapshotTypeCode(doc)).startsWith('wikidata:') ||
        (GENERIC_TYPE_CODES.has(String(zoneSnapshotTypeCode(doc))) && !GENERIC_TYPE_CODES.has(String(resolvedTypeCode))) ||
        shouldRefreshTypeByQuality
      )
    ) {
      doc.taxonomySnapshot.typeCode = resolvedTypeCode;
      changed = true;
    }
    if ((!zoneSnapshotTypeQid(doc) || shouldRefreshTypeByQuality) && resolvedTypeQid) {
      doc.taxonomySnapshot.qid = resolvedTypeQid;
      changed = true;
    }
    if ((!doc.taxonomySnapshot.taxonomyId || shouldRefreshTypeByQuality) && resolvedTaxonomyDoc?._id) {
      doc.taxonomySnapshot.taxonomyId = resolvedTaxonomyDoc._id;
      changed = true;
    }
    if ((!doc.taxonomySnapshot.displayTypeLabel || shouldRefreshTypeByQuality) && displayTypeLabel) {
      doc.taxonomySnapshot.displayTypeLabel = displayTypeLabel;
      changed = true;
    }
    if ((!doc.taxonomySnapshot.wikidataName || shouldRefreshTypeByQuality) && resolvedTaxonomyDoc?.wikidataName) {
      doc.taxonomySnapshot.wikidataName = resolvedTaxonomyDoc.wikidataName;
      changed = true;
    }
    const shouldRefreshCandidates =
      doc?.taxonomySnapshot?.taxonomyCandidates == null ||
      betterBySteps ||
      shouldRefreshTypeByQuality ||
      resolvedTypeSteps === 0;
    if (shouldRefreshCandidates) {
      const currentCandidates = Array.isArray(doc?.taxonomySnapshot?.taxonomyCandidates)
        ? doc.taxonomySnapshot.taxonomyCandidates
        : [];
      if (JSON.stringify(currentCandidates) !== JSON.stringify(taxonomyCandidates)) {
        doc.taxonomySnapshot.taxonomyCandidates = taxonomyCandidates;
        changed = true;
      }
    }
    if ((doc.taxonomySnapshot.numberOfSteps == null || betterBySteps) && resolvedTypeSteps != null) {
      doc.taxonomySnapshot.numberOfSteps = resolvedTypeSteps;
      changed = true;
    }
    if (!doc.taxonomySnapshot.auditStatus) {
      doc.taxonomySnapshot.auditStatus = 'pending';
      changed = true;
    }
    if (doc.adminLevel == null && desiredAdminLevel != null) {
      doc.adminLevel = desiredAdminLevel;
      changed = true;
    }
    if (!doc.source) {
      doc.source = 'wikidata';
      changed = true;
    }
    if (!doc.externalId) {
      doc.externalId = externalId;
      changed = true;
    }
    if (!doc.cover && cover) {
      doc.cover = cover;
      changed = true;
    }
    if ((!doc.slug || !String(doc.slug).trim()) && finalName) {
      doc.slug = slugs.en || slugifyName(finalName);
      changed = true;
    }
    if ((!doc.names || !Object.keys(doc.names || {}).length) && Object.keys(names || {}).length) {
      doc.names = names;
      changed = true;
    }
    if ((!doc.slugs || !Object.keys(doc.slugs || {}).length) && Object.keys(slugs || {}).length) {
      doc.slugs = slugs;
      changed = true;
    }
    if ((!doc.geo || !Array.isArray(doc.geo?.coordinates) || doc.geo.coordinates.length !== 2) && geo) {
      doc.geo = geo;
      changed = true;
    }

    if (changed) {
      await doc.save();
    }
  }

  if (classified.type === 'country' && !doc.parentCountryId) {
    doc.parentCountryId = doc._id;
    await doc.save();
  }

  return doc;
}

async function syncWikidataZoneHierarchy(startQid) {
  const chainResult = await buildWikidataHierarchyChainToCountry(startQid);
  const chain = chainResult?.chain || [];
  if (!chain.length) return null;

  // chain viene de hoja -> padre -> ... -> país. Guardamos de país hacia abajo.
  const ordered = [...chain].reverse();
  let parentZoneDoc = chainResult?.anchorParentZoneDoc || null;
  let countryZoneDoc = null;

  if (zoneSnapshotType(parentZoneDoc) === 'country') {
    countryZoneDoc = parentZoneDoc;
  } else if (parentZoneDoc?.parentCountryId) {
    countryZoneDoc = await Zone.findById(parentZoneDoc.parentCountryId)
      .select('_id externalId taxonomySnapshot type')
      .lean();
  }

  let leafZoneDoc = null;

  for (const entity of ordered) {
    const zoneDoc = await ensureZoneFromWikidataEntity(entity, parentZoneDoc, countryZoneDoc);
    if (!zoneDoc) continue;

    if (!countryZoneDoc && zoneSnapshotType(zoneDoc) === 'country') {
      countryZoneDoc = zoneDoc;
    }
    parentZoneDoc = zoneDoc;
    leafZoneDoc = zoneDoc;
  }

  return {
    startQid: String(startQid || '').toUpperCase(),
    levelsSaved: ordered.length,
    anchoredByExistingParent: !!chainResult?.anchoredByExistingParent,
    anchorParentZoneId: chainResult?.anchorParentZoneDoc?._id || null,
    countryZoneId: countryZoneDoc?._id || null,
    leafZoneId: leafZoneDoc?._id || null,
  };
}

// Reusable helper for other controllers/services that need to materialize
// missing zones from a Wikidata QID chain.
exports.syncZoneHierarchyByQid = async (qid) => syncWikidataZoneHierarchy(qid);


async function ensureCountry(name, iso2, detailsByLang) {
  const query = {};
  if (iso2) {
    query.iso2 = iso2;
  } else if (name) {
    query.name = name;
  }

  let doc = await Country.findOne(query);

  if (!doc && name) {
    const { name: baseName, names, slugs } = buildNamesAndSlugs(
      detailsByLang,
      'country',
      name
    );
    const finalName = names.en || baseName;

    const baseSlug =
      (slugs && (slugs.en || slugs.es)) ||
      slugifyName(finalName || name);

    doc = await Country.create({
      name: finalName,
      slug: baseSlug,
      iso2: iso2 || undefined,
      // Solo guardamos names/slugs si hay algo útil
      ...(Object.keys(names).length ? { names } : {}),
      ...(Object.keys(slugs).length ? { slugs } : {}),
    });
  }

  return doc;
}

async function ensureRegion(name, countryDoc, detailsByLang) {
  if (!name || !countryDoc) return null;

  // Construimos nombres/slugs multi-idioma para la región
  const { name: baseName, names, slugs } = buildNamesAndSlugs(
    detailsByLang,
    'region',
    name,
    { countryName: countryDoc?.name }
  );
  const finalName = names.en || baseName;

  const query = {
    name: finalName,
    countryId: countryDoc._id,
  };

  let doc = await Region.findOne(query);

  if (!doc) {
    // Slug principal: region-country (ej: antioquia-colombia)
    const baseSlug =
      (slugs && (slugs.en || slugs.es)) ||
      slugifyName(`${finalName || name}-${countryDoc?.name || ''}`);

    doc = await Region.create({
      name: finalName,
      slug: baseSlug,
      countryId: countryDoc._id,
      country: countryDoc._id,
      ...(Object.keys(names).length ? { names } : {}),
      ...(Object.keys(slugs).length ? { slugs } : {}),
    });
  }

  return doc;
}

async function ensureCity(name, countryDoc, regionDoc, detailsByLang) {
  if (!name || !countryDoc) return null;

  // Construimos nombres/slugs multi-idioma para la ciudad
  const { name: baseName, names, slugs } = buildNamesAndSlugs(
    detailsByLang,
    'city',
    name,
    { countryName: countryDoc?.name, regionName: regionDoc?.name }
  );
  const finalName = names.en || baseName;

  const query = {
    name: finalName,
    countryId: countryDoc._id,
  };

  if (regionDoc) {
    query.regionId = regionDoc._id;
  }

  let doc = await City.findOne(query);

  if (!doc) {
    // Slug principal: city-region-country (ej: medellin-antioquia-colombia)
    const baseSlug =
      (slugs && (slugs.en || slugs.es)) ||
      slugifyName(`${finalName || name}-${regionDoc?.name || ''}-${countryDoc?.name || ''}`);

    doc = await City.create({
      name: finalName,
      slug: baseSlug,
      countryId: countryDoc._id,
      country: countryDoc._id,
      regionId: regionDoc ? regionDoc._id : undefined,
      region: regionDoc ? regionDoc._id : undefined,
      ...(Object.keys(names).length ? { names } : {}),
      ...(Object.keys(slugs).length ? { slugs } : {}),
    });
  }

  return doc;
};

async function ensureCountryFromWikidata(entity, parentCountryDoc = null) {
  if (!entity) return null;
  const labels = getWikidataLabels(entity);
  const externalId = entity?.id ? String(entity.id) : null;
  const nameEn = getWikidataLabelEn(entity);
  const iso2 = (getWikidataClaimValue(entity, 'P297') || '').toString().toUpperCase() || null;
  const iso3 = (getWikidataClaimValue(entity, 'P298') || '').toString().toUpperCase() || null;
  const typeIds = getWikidataClaimsIds(entity, 'P31');
  const classifiedRaw = (await classifyWikidataTypesWithFallback(typeIds, true)) || { type: 'country', typeCode: null };
  const classified = {
    type: 'country',
    typeCode: classifiedRaw.type === 'country' ? classifiedRaw.typeCode : null
  };
  const normalizedTypeCode = normalizeTypeCode('country', classified.typeCode, typeIds);
  assertNoGenericAdministrativeTypeCode({
    typeCode: normalizedTypeCode || classified.typeCode || null,
    entityName: nameEn || labels.en || externalId || 'Unknown country',
    entityQid: externalId
  });
  const inferredAdminLevel = inferAdminLevel('country', normalizedTypeCode || classified.typeCode);
  const cover = getWikidataCoverUrl(entity);

  const { name: finalName, names, slugs } = buildNamesAndSlugsFromLabels(
    labels,
    'country',
    nameEn || labels.en
  );
  if (!finalName) return null;

  let doc = null;
  if (externalId) {
    doc = await Country.findOne({ source: 'wikidata', externalId });
  }
  if (!doc && iso2) {
    doc = await Country.findOne({ iso2 });
  }
  if (!doc) {
    doc = await Country.findOne({ name: finalName });
  }
  if (!doc) {
    const baseSlug = (slugs && (slugs.en || slugs.es)) || slugifyName(finalName);
    doc = await Country.create({
      name: finalName,
      slug: baseSlug,
      iso2: iso2 || undefined,
      iso3: iso3 || undefined,
      typeCode: normalizedTypeCode || classified.typeCode || undefined,
      adminLevel: Number.isFinite(inferredAdminLevel) ? inferredAdminLevel : null,
      parentCountryId: parentCountryDoc?._id || null,
      cover: cover || undefined,
      source: externalId ? 'wikidata' : undefined,
      externalId: externalId || undefined,
      ...(Object.keys(names).length ? { names } : {}),
      ...(Object.keys(slugs).length ? { slugs } : {}),
    });
  } else {
    let changed = false;
    if ((!doc.typeCode || doc.typeCode.startsWith('wikidata:')) && (normalizedTypeCode || classified.typeCode)) {
      doc.typeCode = normalizedTypeCode || classified.typeCode;
      changed = true;
    }
    if (doc.adminLevel == null && Number.isFinite(inferredAdminLevel)) {
      doc.adminLevel = inferredAdminLevel;
      changed = true;
    }
    if (!doc.parentCountryId && parentCountryDoc?._id) {
      doc.parentCountryId = parentCountryDoc._id;
      changed = true;
    }
    if (!doc.source && externalId) {
      doc.source = 'wikidata';
      changed = true;
    }
    if (!doc.externalId && externalId) {
      doc.externalId = externalId;
      changed = true;
    }
    if (!doc.cover && cover) {
      doc.cover = cover;
      changed = true;
    }
    if (changed) await doc.save();
  }
  return doc;
}

async function ensureRegionFromWikidata(entity, countryDoc) {
  if (!entity || !countryDoc) return null;
  const labels = getWikidataLabels(entity);
  const externalId = entity?.id ? String(entity.id) : null;
  const nameEn = getWikidataLabelEn(entity);
  const adminLevel = parseWikidataNumber(getWikidataClaimValue(entity, 'P274'));
  const typeIds = getWikidataClaimsIds(entity, 'P31');
  const classifiedRaw = (await classifyWikidataTypesWithFallback(typeIds, true)) || { type: 'region', typeCode: null };
  const classified = {
    type: 'region',
    typeCode: classifiedRaw.type === 'region' ? classifiedRaw.typeCode : null
  };
  const normalizedTypeCode = normalizeTypeCode('region', classified.typeCode, typeIds);
  assertNoGenericAdministrativeTypeCode({
    typeCode: normalizedTypeCode || classified.typeCode || null,
    entityName: nameEn || labels.en || externalId || 'Unknown region',
    entityQid: externalId
  });
  const inferredAdminLevel = inferAdminLevel('region', normalizedTypeCode || classified.typeCode);
  const cover = getWikidataCoverUrl(entity);
  const { name: finalName, names, slugs } = buildNamesAndSlugsFromLabels(
    labels,
    'region',
    nameEn || labels.en,
    { countryName: countryDoc?.name }
  );
  if (!finalName) return null;

  const query = externalId
    ? { source: 'wikidata', externalId }
    : { name: finalName, countryId: countryDoc._id };
  let doc = await Region.findOne(query);
  if (!doc) {
    const baseSlug =
      (slugs && (slugs.en || slugs.es)) ||
      slugifyName(`${finalName}-${countryDoc?.name || ''}`);
    doc = await Region.create({
      name: finalName,
      slug: baseSlug,
      countryId: countryDoc._id,
      adminLevel: Number.isFinite(adminLevel) ? adminLevel : (Number.isFinite(inferredAdminLevel) ? inferredAdminLevel : null),
      typeCode: normalizedTypeCode || classified.typeCode || undefined,
      cover: cover || undefined,
      source: externalId ? 'wikidata' : undefined,
      externalId: externalId || undefined,
      ...(Object.keys(names).length ? { names } : {}),
      ...(Object.keys(slugs).length ? { slugs } : {}),
    });
  } else {
    let changed = false;
    if ((!doc.typeCode || doc.typeCode.startsWith('wikidata:')) && (normalizedTypeCode || classified.typeCode)) {
      doc.typeCode = normalizedTypeCode || classified.typeCode;
      changed = true;
    }
    const desiredAdmin = Number.isFinite(adminLevel) ? adminLevel : (Number.isFinite(inferredAdminLevel) ? inferredAdminLevel : null);
    if (doc.adminLevel == null && desiredAdmin != null) {
      doc.adminLevel = desiredAdmin;
      changed = true;
    }
    if (!doc.source && externalId) {
      doc.source = 'wikidata';
      changed = true;
    }
    if (!doc.externalId && externalId) {
      doc.externalId = externalId;
      changed = true;
    }
    if (!doc.cover && cover) {
      doc.cover = cover;
      changed = true;
    }
    if (changed) await doc.save();
  }
  return doc;
}

async function ensureCityFromWikidata(entity, countryDoc, regionDoc, typeCode = null) {
  if (!entity || !countryDoc) return null;
  const labels = getWikidataLabels(entity);
  const externalId = entity?.id ? String(entity.id) : null;
  const nameEn = getWikidataLabelEn(entity);
  const cover = getWikidataCoverUrl(entity);
  let timeZone = await getWikidataTimeZoneIana(entity);
  if (!timeZone) {
    const coord = getWikidataCoordinates(entity);
    if (coord) {
      timeZone = await resolveTimeZoneFromCoordinates(coord.lat, coord.lng);
    }
  }
  const adminLevel = parseWikidataNumber(getWikidataClaimValue(entity, 'P274'));
  const normalizedTypeCode = normalizeTypeCode('city', typeCode, getWikidataClaimsIds(entity, 'P31'));
  const inferredAdminLevel = inferAdminLevel('city', normalizedTypeCode || typeCode);
  const { name: finalName, names, slugs } = buildNamesAndSlugsFromLabels(
    labels,
    'city',
    nameEn || labels.en,
    { countryName: countryDoc?.name, regionName: regionDoc?.name }
  );
  if (!finalName) return null;

  const query = externalId
    ? { source: 'wikidata', externalId }
    : { name: finalName, countryId: countryDoc._id };
  if (regionDoc) query.regionId = regionDoc._id;

  let doc = await City.findOne(query);
  if (!doc && regionDoc) {
    // fallback: city exists without regionId, update to link region
    doc = await City.findOne({
      name: finalName,
      countryId: countryDoc._id,
      regionId: { $in: [null, undefined] }
    });
    if (doc) {
      doc.regionId = regionDoc._id;
      if ((!doc.typeCode || doc.typeCode.startsWith('wikidata:')) && (normalizedTypeCode || typeCode)) {
        doc.typeCode = normalizedTypeCode || typeCode;
      }
      const desiredAdmin = Number.isFinite(adminLevel) ? adminLevel : (Number.isFinite(inferredAdminLevel) ? inferredAdminLevel : null);
      if (doc.adminLevel == null && desiredAdmin != null) doc.adminLevel = desiredAdmin;
      if (!doc.source && externalId) doc.source = 'wikidata';
      if (!doc.externalId && externalId) doc.externalId = externalId;
      await doc.save();
    }
  }

  if (!doc) {
    const baseSlug =
      (slugs && (slugs.en || slugs.es)) ||
      slugifyName(`${finalName}-${regionDoc?.name || ''}-${countryDoc?.name || ''}`);
    doc = await City.create({
      name: finalName,
      slug: baseSlug,
      countryId: countryDoc._id,
      regionId: regionDoc ? regionDoc._id : undefined,
      cover: cover || undefined,
      timeZone: timeZone || undefined,
      typeCode: normalizedTypeCode || typeCode || undefined,
      adminLevel: Number.isFinite(adminLevel) ? adminLevel : (Number.isFinite(inferredAdminLevel) ? inferredAdminLevel : null),
      source: externalId ? 'wikidata' : undefined,
      externalId: externalId || undefined,
      ...(Object.keys(names).length ? { names } : {}),
      ...(Object.keys(slugs).length ? { slugs } : {}),
    });
  } else {
    let changed = false;
    if ((!doc.typeCode || doc.typeCode.startsWith('wikidata:')) && (normalizedTypeCode || typeCode)) {
      doc.typeCode = normalizedTypeCode || typeCode;
      changed = true;
    }
    const desiredAdmin = Number.isFinite(adminLevel) ? adminLevel : (Number.isFinite(inferredAdminLevel) ? inferredAdminLevel : null);
    if (doc.adminLevel == null && desiredAdmin != null) {
      doc.adminLevel = desiredAdmin;
      changed = true;
    }
    if (!doc.source && externalId) {
      doc.source = 'wikidata';
      changed = true;
    }
    if (!doc.externalId && externalId) {
      doc.externalId = externalId;
      changed = true;
    }
    if (!doc.cover && cover) {
      doc.cover = cover;
      changed = true;
    }
    if (!doc.timeZone && timeZone) {
      doc.timeZone = timeZone;
      changed = true;
    }
    if (changed) await doc.save();
  }
  return doc;
}

async function ensureNeighborhoodFromWikidata(entity, countryDoc, regionDoc, cityDoc, typeCode = null) {
  if (!entity || !countryDoc || !cityDoc) return null;
  const labels = getWikidataLabels(entity);
  const externalId = entity?.id ? String(entity.id) : null;
  const nameEn = getWikidataLabelEn(entity);
  const cover = getWikidataCoverUrl(entity);
  const adminLevel = parseWikidataNumber(getWikidataClaimValue(entity, 'P274'));
  const normalizedTypeCode = normalizeTypeCode('neighborhood', typeCode, getWikidataClaimsIds(entity, 'P31'));
  const inferredAdminLevel = inferAdminLevel('neighborhood', normalizedTypeCode || typeCode);
  const { name: finalName, names, slugs } = buildNamesAndSlugsFromLabels(
    labels,
    'city',
    nameEn || labels.en,
    { countryName: countryDoc?.name, regionName: regionDoc?.name }
  );
  if (!finalName) return null;

  const query = externalId
    ? { source: 'wikidata', externalId }
    : { name: finalName, countryId: countryDoc._id, cityId: cityDoc._id };
  let doc = await (models.Neighborhood || require('../models/Neighborhood')).findOne(query);

  if (!doc) {
    const baseSlug =
      (slugs && (slugs.en || slugs.es)) ||
      slugifyName(`${finalName}-${cityDoc?.name || ''}-${countryDoc?.name || ''}`);
    doc = await (models.Neighborhood || require('../models/Neighborhood')).create({
      name: finalName,
      slug: baseSlug,
      countryId: countryDoc._id,
      regionId: regionDoc ? regionDoc._id : undefined,
      cityId: cityDoc._id,
      cover: cover || undefined,
      typeCode: normalizedTypeCode || typeCode || undefined,
      adminLevel: Number.isFinite(adminLevel) ? adminLevel : (Number.isFinite(inferredAdminLevel) ? inferredAdminLevel : null),
      source: externalId ? 'wikidata' : undefined,
      externalId: externalId || undefined,
      ...(Object.keys(names).length ? { names } : {}),
      ...(Object.keys(slugs).length ? { slugs } : {}),
    });
  } else {
    let changed = false;
    if ((!doc.typeCode || doc.typeCode.startsWith('wikidata:')) && (normalizedTypeCode || typeCode)) {
      doc.typeCode = normalizedTypeCode || typeCode;
      changed = true;
    }
    const desiredAdmin = Number.isFinite(adminLevel) ? adminLevel : (Number.isFinite(inferredAdminLevel) ? inferredAdminLevel : null);
    if (doc.adminLevel == null && desiredAdmin != null) {
      doc.adminLevel = desiredAdmin;
      changed = true;
    }
    if (!doc.source && externalId) {
      doc.source = 'wikidata';
      changed = true;
    }
    if (!doc.externalId && externalId) {
      doc.externalId = externalId;
      changed = true;
    }
    if (!doc.cover && cover) {
      doc.cover = cover;
      changed = true;
    }
    if (changed) await doc.save();
  }
  return doc;
}

async function resolveWikidataRegionEntity(startEntity) {
  if (!startEntity) return null;
  let current = startEntity;
  for (let i = 0; i < 4; i++) {
    const typeIds = getWikidataClaimsIds(current, 'P31');
    const classified = await classifyWikidataTypesWithFallback(typeIds, false);
    if (classified?.type === 'region') return current;

    const parentId = getWikidataClaimsIds(current, 'P131')?.[0];
    if (!parentId) return null;
    const parents = await wikidataGetEntities([parentId]);
    const parent = parents?.[parentId];
    if (!parent) return null;
    current = parent;
  }
  return null;
}

async function resolveWikidataPlace(qid, typeOverride = null) {
  const entities = await wikidataGetEntities([qid]);
  const entity = entities?.[qid];
  if (!entity) {
    throw new Error('Wikidata entity not found');
  }

  const typeIds = getWikidataClaimsIds(entity, 'P31');
  const classified = (await classifyWikidataTypesWithFallback(typeIds, true)) || { type: 'city', typeCode: null };
  const finalType = typeOverride || classified.type;
  const isDistrictType = finalType === 'district';

  const countryIdQ = getWikidataClaimsIds(entity, 'P17')?.[0] || null;
  const regionIdQ = getWikidataClaimsIds(entity, 'P131')?.[0] || null;

  const relatedIds = [countryIdQ, regionIdQ].filter(Boolean);
  const related = relatedIds.length ? await wikidataGetEntities(relatedIds) : {};

  const countryEntity = countryIdQ ? related[countryIdQ] : null;
  const regionEntity = regionIdQ ? related[regionIdQ] : null;

  const baseCountryDoc = await ensureCountryFromWikidata(countryEntity || entity);
  let countryDoc = baseCountryDoc;
  let regionDoc = null;

  if (regionEntity) {
    const regionTypeIds = getWikidataClaimsIds(regionEntity, 'P31');
    const regionClassified = (await classifyWikidataTypesWithFallback(regionTypeIds, true)) || { type: 'region', typeCode: null };
    const isCountryLike = regionClassified.type === 'country';

    if (isCountryLike && baseCountryDoc) {
      // Example: England (constituent country) under UK
      countryDoc = await ensureCountryFromWikidata(regionEntity, baseCountryDoc);
    } else if (baseCountryDoc) {
      regionDoc = await ensureRegionFromWikidata(regionEntity, baseCountryDoc);
    }
  }

  if (countryDoc && !regionDoc) {
    const regionResolved = await resolveWikidataRegionEntity(entity);
    if (regionResolved) {
      regionDoc = await ensureRegionFromWikidata(regionResolved, countryDoc);
    }
  }

  let cityDoc = null;
  if (finalType === 'city' && countryDoc) {
    cityDoc = await ensureCityFromWikidata(entity, countryDoc, regionDoc, classified.typeCode || null);
  }

  let neighborhoodDoc = null;
  if ((finalType === 'neighborhood' || isDistrictType) && countryDoc) {
    // for neighborhood, ensure city first using parent if possible
    const cityEntityId = getWikidataClaimsIds(entity, 'P131')?.[0] || null;
    const cityEntities = cityEntityId ? await wikidataGetEntities([cityEntityId]) : {};
    const cityEntity = cityEntityId ? cityEntities[cityEntityId] : null;
    cityDoc = cityEntity ? await ensureCityFromWikidata(cityEntity, countryDoc, regionDoc, 'city') : null;
    if (cityDoc) {
      neighborhoodDoc = await ensureNeighborhoodFromWikidata(entity, countryDoc, regionDoc, cityDoc, classified.typeCode || null);
    }
  }

  let locationId = null;
  let label = null;
  let type = finalType;

  if ((finalType === 'neighborhood' || isDistrictType) && neighborhoodDoc) {
    locationId = neighborhoodDoc._id;
    label = neighborhoodDoc.name;
    type = isDistrictType ? 'district' : 'neighborhood';
  } else if (finalType === 'city' && cityDoc) {
    locationId = cityDoc._id;
    label = cityDoc.name;
  } else if (finalType === 'region' && regionDoc) {
    locationId = regionDoc._id;
    label = regionDoc.name;
  } else if (countryDoc) {
    locationId = countryDoc._id;
    label = countryDoc.name;
    type = 'country';
  }

  return {
    _id: locationId,
    type,
    label,
    region: regionDoc,
    country: countryDoc,
  };
}

// --- Helpers internos ---

/**
 * Adivinar tipo lógico 'city' | 'region' | 'country' a partir de los types de Google Places.
 * Ajusta este helper si tu servicio de Google ya normaliza los tipos de otra forma.
 */
function guessPlaceType(types = []) {
  if (!Array.isArray(types)) return 'city';

  const has = (t) => types.includes(t);

  if (has('locality') || has('postal_town')) return 'city';
  if (has('administrative_area_level_1') || has('administrative_area_level_2')) return 'region';
  if (has('country')) return 'country';

  // Fallback razonable
  return 'city';
}
