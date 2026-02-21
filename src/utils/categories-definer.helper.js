const ActivityCategory = require('../models/ActivityCategory');
const ServiceTag = require('../models/ServiceTag');

const WIKIDATA_GET_ENTITIES_URL = 'https://www.wikidata.org/w/api.php';
const WIKIDATA_BATCH_SIZE = 50;
const WIKIDATA_MAX_HOPS = 5;
const subclassParentsCache = new Map();

function normalizeTypeTags(typeTags = []) {
  return Array.from(
    new Set(
      (typeTags || [])
        .filter(Boolean)
        .map((t) =>
          String(t)
            .trim()
            .toLowerCase()
            .replace(/\s+/g, '-')
            .replace(/_/g, '-')
        )
    )
  );
}

function normalizeQids(qids = []) {
  return Array.from(
    new Set(
      (qids || [])
        .filter(Boolean)
        .map((q) => String(q).trim().toUpperCase())
        .filter((q) => /^Q\d+$/.test(q))
    )
  );
}

async function resolveServiceTagIdsFromTypeTags(typeTags = []) {
  const slugs = normalizeTypeTags(typeTags);
  if (!slugs.length) return [];

  const tags = await ServiceTag.find(
    { slug: { $in: slugs }, isActive: true },
    { _id: 1, slug: 1 }
  ).lean();

  return tags.map((t) => String(t._id));
}

async function resolveActivityCategoryIdFromTypeTags(typeTags = []) {
  const tagIds = await resolveServiceTagIdsFromTypeTags(typeTags);
  if (!tagIds.length) return null;

  const candidates = await ActivityCategory.find({
    isActive: true,
    tagsTypes: { $in: tagIds },
  }).lean();

  if (!candidates.length) return null;

  const idSet = new Set(tagIds.map((id) => String(id)));

  let best = null;
  let bestScore = -1;

  for (const cat of candidates) {
    const catTypes = Array.isArray(cat.tagsTypes) ? cat.tagsTypes : [];
    let score = 0;

    for (const t of catTypes) {
      if (idSet.has(String(t))) {
        score += 1;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      best = cat;
    } else if (score === bestScore && best !== null) {
      const currentOrder = typeof cat.order === 'number' ? cat.order : Number.MAX_SAFE_INTEGER;
      const bestOrder = typeof best.order === 'number' ? best.order : Number.MAX_SAFE_INTEGER;
      if (currentOrder < bestOrder) {
        best = cat;
      }
    }
  }

  return best ? best._id : null;
}

async function resolveActivityCategoryFromTypeTags(typeTags = []) {
  const tagIds = await resolveServiceTagIdsFromTypeTags(typeTags);
  if (!tagIds.length) return null;

  const candidates = await ActivityCategory.find({
    isActive: true,
    tagsTypes: { $in: tagIds },
  }).lean();

  if (!candidates.length) return null;

  const idSet = new Set(tagIds.map((id) => String(id)));

  let best = null;
  let bestScore = -1;

  for (const cat of candidates) {
    const catTypes = Array.isArray(cat.tagsTypes) ? cat.tagsTypes : [];
    let score = 0;

    for (const t of catTypes) {
      if (idSet.has(String(t))) {
        score += 1;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      best = cat;
    } else if (score === bestScore && best !== null) {
      const currentOrder = typeof cat.order === 'number' ? cat.order : Number.MAX_SAFE_INTEGER;
      const bestOrder = typeof best.order === 'number' ? best.order : Number.MAX_SAFE_INTEGER;
      if (currentOrder < bestOrder) {
        best = cat;
      }
    }
  }

  return best || null;
}

async function resolveActivityCategoryIdFromWikidataClassIds(classIds = []) {
  const qids = normalizeQids(classIds);
  if (!qids.length) return null;

  const candidates = await ActivityCategory.find(
    {
      isActive: true,
      externalId: { $in: qids },
    },
    { _id: 1, order: 1, externalId: 1 }
  )
    .sort({ order: 1, _id: 1 })
    .lean();

  if (!candidates.length) return null;

  // Prefer the first class that appears in the incoming classIds order.
  const byQid = new Map(
    candidates.map((c) => [String(c.externalId || '').toUpperCase(), c])
  );

  for (const qid of qids) {
    const hit = byQid.get(qid);
    if (hit?._id) return hit._id;
  }

  return candidates[0]?._id || null;
}

async function resolveActivityCategoryIdsFromWikidataClassIds(
  classIds = [],
  externalIdToCategoryIdMap = null
) {
  let levelQids = normalizeQids(classIds);
  if (!levelQids.length) return [];

  const visited = new Set(levelQids);

  for (let hop = 0; hop <= WIKIDATA_MAX_HOPS && levelQids.length; hop += 1) {
    const foundAtLevel = await resolveCategoryIdsForLevel(levelQids, externalIdToCategoryIdMap);
    // Keep only matches from the first level that has at least one match.
    if (foundAtLevel.length) return foundAtLevel;

    const parentsByQid = await getSubclassParentsForQids(levelQids);
    const nextLevel = [];

    for (const qid of levelQids) {
      const parents = parentsByQid.get(qid) || [];
      for (const parentQid of parents) {
        if (visited.has(parentQid)) continue;
        visited.add(parentQid);
        nextLevel.push(parentQid);
      }
    }

    levelQids = nextLevel;
  }

  return [];
}

async function resolveCategoryIdsForLevel(levelQids = [], externalIdToCategoryIdMap = null) {
  if (!levelQids.length) return [];

  if (externalIdToCategoryIdMap instanceof Map) {
    const ids = [];
    const seen = new Set();
    for (const qid of levelQids) {
      const id = externalIdToCategoryIdMap.get(qid);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    return ids;
  }

  const candidates = await ActivityCategory.find(
    {
      isActive: true,
      externalId: { $in: levelQids },
    },
    { _id: 1, externalId: 1 }
  ).lean();

  if (!candidates.length) return [];

  const byQid = new Map(
    candidates.map((c) => [String(c.externalId || '').toUpperCase(), String(c._id)])
  );

  const ids = [];
  const seen = new Set();
  for (const qid of levelQids) {
    const id = byQid.get(qid);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

async function getSubclassParentsForQids(qids = []) {
  const validQids = normalizeQids(qids);
  const result = new Map();

  for (const qid of validQids) {
    if (subclassParentsCache.has(qid)) {
      result.set(qid, subclassParentsCache.get(qid) || []);
    }
  }

  const missing = validQids.filter((qid) => !subclassParentsCache.has(qid));
  if (!missing.length) return result;

  for (let i = 0; i < missing.length; i += WIKIDATA_BATCH_SIZE) {
    const chunk = missing.slice(i, i + WIKIDATA_BATCH_SIZE);
    const ids = chunk.join('|');
    const url = `${WIKIDATA_GET_ENTITIES_URL}?action=wbgetentities&ids=${encodeURIComponent(
      ids
    )}&props=claims&format=json&origin=*`;

    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'TripPlanner/1.0 (activity-categories)',
        },
      });

      if (!response.ok) {
        for (const qid of chunk) subclassParentsCache.set(qid, []);
        continue;
      }

      const data = await response.json();
      const entities = data?.entities || {};

      for (const qid of chunk) {
        const entity = entities[qid];
        const parents = extractSubclassParentsFromEntity(entity);
        subclassParentsCache.set(qid, parents);
      }
    } catch (_err) {
      for (const qid of chunk) subclassParentsCache.set(qid, []);
    }
  }

  for (const qid of validQids) {
    result.set(qid, subclassParentsCache.get(qid) || []);
  }

  return result;
}

function extractSubclassParentsFromEntity(entity) {
  const claims = entity?.claims;
  if (!claims || !Array.isArray(claims.P279)) return [];

  const out = [];
  const seen = new Set();
  for (const statement of claims.P279) {
    const id = statement?.mainsnak?.datavalue?.value?.id;
    const qid = String(id || '').trim().toUpperCase();
    if (!/^Q\d+$/.test(qid) || seen.has(qid)) continue;
    seen.add(qid);
    out.push(qid);
  }
  return out;
}

module.exports = {
  normalizeTypeTags,
  normalizeQids,
  resolveServiceTagIdsFromTypeTags,
  resolveActivityCategoryIdFromTypeTags,
  resolveActivityCategoryFromTypeTags,
  resolveActivityCategoryIdFromWikidataClassIds,
  resolveActivityCategoryIdsFromWikidataClassIds,
};
