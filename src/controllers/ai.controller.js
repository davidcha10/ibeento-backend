const { generateItineraryResponse } = require('../services/gemini.service');
const AI_LOG_PREFIX = '[AI][controller]';
const AI_SELECTED_ACTIVITIES_PER_DAY_CAP = Number(process.env.AI_SELECTED_ACTIVITIES_PER_DAY_CAP || 10);
const AI_SELECTED_ACTIVITIES_CAP_MAX = Number(process.env.AI_SELECTED_ACTIVITIES_CAP_MAX || 200);
const AI_EXECUTION_ENABLED = String(process.env.AI_EXECUTION_ENABLED || 'true').toLowerCase() === 'true';
const AI_MIN_ACTIVITIES_PER_DAY = Number(process.env.AI_MIN_ACTIVITIES_PER_DAY || 2);
const AI_MIN_OCCUPIED_MINUTES_PER_DAY = Number(process.env.AI_MIN_OCCUPIED_MINUTES_PER_DAY || 240);
const AI_WINDOW_OVERFLOW_TOLERANCE_MIN = Number(process.env.AI_WINDOW_OVERFLOW_TOLERANCE_MIN || 30);
const DEFAULT_WAKE_TIME = '08:00';
const DEFAULT_SLEEP_TIME = '22:00';
const DEFAULT_ACTIVITY_DURATION_MIN = 90;
const MIN_ACTIVITY_DURATION_MIN = 45;
const DAY_BUFFER_MIN = 30;

const ALLOWED_ACTION_TYPES = new Set([
  'add_activity',
  'update_activity',
  'remove_activity',
  'reorder_activity',
]);

function isObjectIdLike(value) {
  const v = String(value || '').trim();
  return /^[a-f\d]{24}$/i.test(v);
}

function normalizeIsoOrNull(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const d = new Date(raw);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toISOString();
}

function toNumberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function computeAverageActivityDurationMinutes(activities = [], fallback = DEFAULT_ACTIVITY_DURATION_MIN) {
  const durations = (Array.isArray(activities) ? activities : [])
    .map((activity) => getActivityDurationMin(activity))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (!durations.length) return fallback;
  const avg = durations.reduce((sum, value) => sum + value, 0) / durations.length;
  return clamp(Math.round(avg), MIN_ACTIVITY_DURATION_MIN, 240);
}

function derivePaceTargets(rawPace, context = {}) {
  const parsed = toNumberOrNull(rawPace);
  const pace = clamp(Math.round(parsed == null ? 5 : parsed), 1, 10);
  const paceRatio = (pace - 1) / 9;

  const dayWindowMinutesRaw = toNumberOrNull(context?.dayWindowMinutes);
  const dayWindowMinutes = clamp(
    Math.round(dayWindowMinutesRaw == null ? (14 * 60) : dayWindowMinutesRaw),
    6 * 60,
    16 * 60,
  );

  const referenceDurationMinutes = clamp(
    Math.round(toNumberOrNull(context?.avgDurationMinutes) || DEFAULT_ACTIVITY_DURATION_MIN),
    MIN_ACTIVITY_DURATION_MIN,
    240,
  );

  // Pace is mapped to desired occupancy ratio, not fixed activity count tiers.
  const desiredOccupancyRatio = clamp(0.38 + (paceRatio * 0.42), 0.35, 0.82);
  const targetOccupiedMinutesPerDay = clamp(
    Math.round(dayWindowMinutes * desiredOccupancyRatio),
    120,
    dayWindowMinutes,
  );

  const floorByWindow = Math.max(120, Math.round(dayWindowMinutes * 0.4));
  const minOccupiedMinutesPerDay = Math.max(
    Math.min(AI_MIN_OCCUPIED_MINUTES_PER_DAY, dayWindowMinutes),
    Math.round(targetOccupiedMinutesPerDay * 0.72),
    floorByWindow,
  );

  const preferredActivitiesPerDay = clamp(
    Math.round(targetOccupiedMinutesPerDay / referenceDurationMinutes),
    2,
    7,
  );
  const minActivitiesPerDay = clamp(
    Math.max(AI_MIN_ACTIVITIES_PER_DAY, preferredActivitiesPerDay - 1),
    2,
    preferredActivitiesPerDay,
  );

  const maxActivitiesPerDay = clamp(
    preferredActivitiesPerDay + (paceRatio >= 0.66 ? 2 : 1),
    preferredActivitiesPerDay,
    8,
  );

  return {
    pace,
    paceRatio: Number(paceRatio.toFixed(3)),
    desiredOccupancyRatio: Number(desiredOccupancyRatio.toFixed(3)),
    dayWindowMinutes,
    referenceDurationMinutes,
    minActivitiesPerDay,
    preferredActivitiesPerDay,
    maxActivitiesPerDay,
    minOccupiedMinutesPerDay,
    targetOccupiedMinutesPerDay,
  };
}

function dayKeyFromIso(iso) {
  const d = new Date(String(iso || '').trim());
  if (!Number.isFinite(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function parseTimeToMinutes(value, fallbackMinutes) {
  const raw = String(value || '').trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (!m) return fallbackMinutes;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return fallbackMinutes;
  if (h < 0 || h > 23 || min < 0 || min > 59) return fallbackMinutes;
  return h * 60 + min;
}

function minutesToHHmm(totalMinutes) {
  const m = Math.max(0, Math.min(23 * 60 + 59, Math.floor(totalMinutes)));
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function deriveWindowFromItineraryUtcMinutes(items = []) {
  const starts = [];
  const ends = [];
  for (const it of items) {
    const s = normalizeIsoOrNull(it?.timelineStartDate);
    const e = normalizeIsoOrNull(it?.timelineEndDate);
    const sMin = s ? isoToUtcMinutes(s) : null;
    const eMin = e ? isoToUtcMinutes(e) : null;
    if (sMin != null) starts.push(sMin);
    if (eMin != null) ends.push(eMin);
  }
  if (!starts.length || !ends.length) return null;
  const earliest = Math.min(...starts);
  const latest = Math.max(...ends);
  if (!Number.isFinite(earliest) || !Number.isFinite(latest) || latest <= earliest) return null;

  // Give some room around observed itinerary behavior.
  const wake = clamp(earliest - 60, 0, 23 * 60);
  const sleep = clamp(latest + 60, wake + 240, 24 * 60);
  return { wakeMin: wake, sleepMin: sleep };
}

function withUtcMinutes(dayKey, minutes) {
  const [y, mo, d] = String(dayKey || '').split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return new Date(Date.UTC(y, mo - 1, d, h, m, 0, 0)).toISOString();
}

function isoToUtcMinutes(iso) {
  const d = new Date(String(iso || '').trim());
  if (!Number.isFinite(d.getTime())) return null;
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function intervalOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function getActivityDurationMin(activity) {
  const min = toNumberOrNull(activity?.defaultDurationMin?.min);
  const max = toNumberOrNull(activity?.defaultDurationMin?.max);
  const pick = min || max || DEFAULT_ACTIVITY_DURATION_MIN;
  return clamp(pick, MIN_ACTIVITY_DURATION_MIN, 360);
}

function getDateRangeDays(startIso, endIso) {
  const start = new Date(String(startIso || '').trim());
  const end = new Date(String(endIso || '').trim());
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return [];
  const out = [];
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  while (cursor.getTime() <= last.getTime()) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

function normalizeGenerationScope(rawScope = {}, aiInput = {}) {
  const scopeRaw = String(rawScope?.scope || '').trim().toLowerCase();
  const scope = scopeRaw === 'selected_day' ? 'selected_day' : 'whole_trip';
  const tripDays = getDateRangeDays(aiInput?.tripContext?.startDate, aiInput?.tripContext?.endDate);
  let targetDayYmd = null;

  if (scope === 'selected_day') {
    const candidate = String(rawScope?.targetDayYmd || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(candidate) && (!tripDays.length || tripDays.includes(candidate))) {
      targetDayYmd = candidate;
    } else if (tripDays.length) {
      targetDayYmd = tripDays[0];
    }
  }

  return { scope, targetDayYmd };
}

function rebaseIsoToDayKeepingUtcMinutes(rawIso, targetDayYmd) {
  const minutes = isoToUtcMinutes(rawIso);
  if (minutes == null || !targetDayYmd) return null;
  return withUtcMinutes(targetDayYmd, minutes);
}

function applySelectedDayScopeToAction(action = {}, targetDayYmd) {
  if (!action || !targetDayYmd) return action;
  const type = String(action?.type || '').trim();
  if (type === 'remove_activity') return action;

  const startIso = normalizeIsoOrNull(action?.timelineStartDate);
  if (!startIso) return action;

  const rebasedStartIso = rebaseIsoToDayKeepingUtcMinutes(startIso, targetDayYmd);
  if (!rebasedStartIso) return action;

  const next = {
    ...action,
    timelineStartDate: rebasedStartIso,
  };

  const endIso = normalizeIsoOrNull(action?.timelineEndDate);
  if (!endIso) return next;

  const startMin = isoToUtcMinutes(startIso);
  const endMin = isoToUtcMinutes(endIso);
  if (startMin == null || endMin == null) {
    const rebasedEndIso = rebaseIsoToDayKeepingUtcMinutes(endIso, targetDayYmd);
    if (rebasedEndIso) next.timelineEndDate = rebasedEndIso;
    return next;
  }

  const rebasedStartMin = isoToUtcMinutes(rebasedStartIso);
  if (rebasedStartMin == null) return next;

  const durationMin = Math.max(endMin - startMin, MIN_ACTIVITY_DURATION_MIN);
  const rebasedEndMin = clamp(rebasedStartMin + durationMin, rebasedStartMin + MIN_ACTIVITY_DURATION_MIN, 24 * 60 - 1);
  const rebasedEndIso = withUtcMinutes(targetDayYmd, rebasedEndMin);
  if (rebasedEndIso) next.timelineEndDate = rebasedEndIso;
  return next;
}

function actionTouchesSelectedDay(action = {}, targetDayYmd, selectedItemIds = new Set(), selectedActivityIds = new Set()) {
  if (!targetDayYmd) return true;
  const type = String(action?.type || '').trim();
  if (type === 'add_activity') {
    return dayKeyFromIso(action?.timelineStartDate) === targetDayYmd;
  }
  const itineraryItemId = String(action?.itineraryItemId || '').trim();
  if (itineraryItemId && selectedItemIds.size) {
    return selectedItemIds.has(itineraryItemId);
  }
  const activityId = String(action?.activityId || '').trim();
  if (activityId && selectedActivityIds.size) {
    return selectedActivityIds.has(activityId);
  }
  const day = dayKeyFromIso(action?.timelineStartDate);
  return !!day && day === targetDayYmd;
}

function buildSelectedActivitiesForAi(aiInput = {}, options = {}) {
  const WEIGHTS = {
    favorite: 0.35,
    priority: 0.30,
    rating: 0.25,
    categoryMatch: 0.10,
  };
  const scope = options?.generationScope?.scope === 'selected_day' ? 'selected_day' : 'whole_trip';
  const targetDayYmd = scope === 'selected_day'
    ? String(options?.generationScope?.targetDayYmd || '').trim()
    : '';
  const tripDaysAll = getDateRangeDays(aiInput?.tripContext?.startDate, aiInput?.tripContext?.endDate);
  const generatedDayCount = scope === 'selected_day'
    ? 1
    : Math.max(1, tripDaysAll.length);

  const allActivities = Array.isArray(aiInput?.activities) ? aiInput.activities : [];
  const itineraryItems = Array.isArray(aiInput?.itinerary?.items) ? aiInput.itinerary.items : [];
  const favoriteIds = new Set(
    (Array.isArray(aiInput?.userContext?.favorites?.activityIds) ? aiInput.userContext.favorites.activityIds : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean)
  );
  const topCategoryWeights = new Map(
    (Array.isArray(aiInput?.userContext?.favorites?.topActivityCategoryIds)
      ? aiInput.userContext.favorites.topActivityCategoryIds
      : []
    )
      .map((row) => [String(row?.categoryId || '').trim(), toNumberOrNull(row?.weight) ?? 0])
      .filter(([id]) => !!id)
  );
  const itineraryActivityIds = new Set(
    itineraryItems
      .map((it) => String(it?.activityId || '').trim())
      .filter(Boolean)
  );
  const itineraryActivityIdsOrdered = itineraryItems
    .map((it) => String(it?.activityId || '').trim())
    .filter(Boolean)
    .filter((id, idx, arr) => arr.indexOf(id) === idx);

  const placeTypeSet = new Set(
    (Array.isArray(aiInput?.tripContext?.visitPlaces) ? aiInput.tripContext.visitPlaces : [])
      .map((p) => String(p?.type || '').trim().toLowerCase())
      .filter(Boolean)
  );

  const normalized = allActivities.map((a) => {
    const id = String(a?._id || '').trim();
    const priorityRaw = toNumberOrNull(a?.ranking?.priority) ?? 0;
    const ratingRaw = toNumberOrNull(a?.ranking?.ratingAvg) ?? 0;
    const categoryIds = [
      String(a?.activityCategoryId || '').trim(),
      ...(Array.isArray(a?.activityCategoryIds) ? a.activityCategoryIds.map((x) => String(x || '').trim()) : []),
    ].filter(Boolean);
    const categoryMatchRaw = categoryIds.length
      ? Math.max(...categoryIds.map((cid) => Number(topCategoryWeights.get(cid) || 0)))
      : 0;
    const inItinerary = itineraryActivityIds.has(id);
    const isFavorite = favoriteIds.has(id);

    const favoriteScore = isFavorite ? 1 : 0;
    const priorityScore = clamp(priorityRaw, 0, 100) / 100;
    const ratingScore = clamp(ratingRaw, 0, 5) / 5;
    const categoryMatchScore = clamp(categoryMatchRaw, 0, 1);

    const weightedScore =
      (favoriteScore * WEIGHTS.favorite) +
      (priorityScore * WEIGHTS.priority) +
      (ratingScore * WEIGHTS.rating) +
      (categoryMatchScore * WEIGHTS.categoryMatch);

    const location = a?.location && typeof a.location === 'object' ? a.location : {};
    const scopedLocation = {};
    if (placeTypeSet.has('city') && location.cityId) scopedLocation.cityId = location.cityId;
    if (placeTypeSet.has('region') && location.regionId) scopedLocation.regionId = location.regionId;
    if (placeTypeSet.has('country') && location.countryId) scopedLocation.countryId = location.countryId;
    if (!Object.keys(scopedLocation).length) {
      if (location.cityId) scopedLocation.cityId = location.cityId;
      else if (location.regionId) scopedLocation.regionId = location.regionId;
      else if (location.countryId) scopedLocation.countryId = location.countryId;
    }

    return {
      ...a,
      _id: id,
      location: scopedLocation,
      __score: Number((weightedScore * 100).toFixed(2)),
      __isFavorite: isFavorite,
      __inItinerary: inItinerary,
      __favoriteScore: favoriteScore,
      __priorityScore: priorityScore,
      __ratingScore: ratingScore,
      __categoryMatchScore: categoryMatchScore,
      __priorityRaw: priorityRaw,
      __ratingRaw: ratingRaw,
    };
  });

  normalized.sort((a, b) => {
    if (b.__score !== a.__score) return b.__score - a.__score;
    if (a.__inItinerary !== b.__inItinerary) return a.__inItinerary ? -1 : 1;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });

  const perDayCap = Number.isFinite(AI_SELECTED_ACTIVITIES_PER_DAY_CAP) && AI_SELECTED_ACTIVITIES_PER_DAY_CAP > 0
    ? Math.floor(AI_SELECTED_ACTIVITIES_PER_DAY_CAP)
    : 10;
  const dynamicCap = Math.max(perDayCap, generatedDayCount * perDayCap);
  const capMax = Number.isFinite(AI_SELECTED_ACTIVITIES_CAP_MAX) && AI_SELECTED_ACTIVITIES_CAP_MAX > 0
    ? Math.floor(AI_SELECTED_ACTIVITIES_CAP_MAX)
    : dynamicCap;
  const cap = Math.min(dynamicCap, capMax);

  const normalizedById = new Map(
    normalized
      .map((a) => [String(a?._id || '').trim(), a])
      .filter(([id]) => !!id)
  );

  const forcedItems = itineraryActivityIdsOrdered
    .map((activityId) => normalizedById.get(activityId))
    .filter(Boolean);
  const forcedIds = new Set(forcedItems.map((a) => String(a?._id || '').trim()));

  const effectiveCap = Math.max(cap, forcedItems.length);
  const selectedWithMeta = [
    ...forcedItems,
    ...normalized.filter((a) => !forcedIds.has(String(a?._id || '').trim())),
  ].slice(0, effectiveCap);

  const selected = selectedWithMeta.map((a) => {
    const {
      __score,
      __isFavorite,
      __inItinerary,
      __favoriteScore,
      __priorityScore,
      __ratingScore,
      __categoryMatchScore,
      __priorityRaw,
      __ratingRaw,
      ...clean
    } = a;
    return clean;
  });

  return {
    selected,
    diagnostics: {
      scoringWeights: {
        favorite: WEIGHTS.favorite,
        priority: WEIGHTS.priority,
        rating: WEIGHTS.rating,
        categoryMatch: WEIGHTS.categoryMatch,
      },
      totalActivities: normalized.length,
      selectedActivities: selected.length,
      cap,
      perDayCap,
      generatedDayCount,
      scope,
      targetDayYmd: targetDayYmd || null,
      effectiveCap,
      forcedItineraryActivities: forcedItems.length,
      favoritesInSelected: selected.filter((a) => favoriteIds.has(String(a?._id || ''))).length,
      itineraryActivitiesInSelected: selected.filter((a) =>
        itineraryActivityIds.has(String(a?._id || ''))
      ).length,
      topSelectedPreview: normalized.slice(0, 8).map((a) => ({
        id: a._id,
        name: a.name,
        score: a.__score,
        inItinerary: !!a.__inItinerary,
        components: {
          favorite: Number(a.__favoriteScore || 0),
          priority: Number(a.__priorityScore || 0),
          rating: Number(a.__ratingScore || 0),
          categoryMatch: Number(a.__categoryMatchScore || 0),
        },
        raw: {
          priority: Number(a.__priorityRaw || 0),
          rating: Number(a.__ratingRaw || 0),
        },
      })),
    },
  };
}

function buildAiInputForModel(aiInput = {}, generationScope = null) {
  const { selected, diagnostics } = buildSelectedActivitiesForAi(aiInput, { generationScope });
  const days = getDateRangeDays(aiInput?.tripContext?.startDate, aiInput?.tripContext?.endDate);
  const itineraryItems = Array.isArray(aiInput?.itinerary?.items) ? aiInput.itinerary.items : [];
  const avgDurationMinutes = computeAverageActivityDurationMinutes(selected, DEFAULT_ACTIVITY_DURATION_MIN);
  const paceTargets = derivePaceTargets(aiInput?.userContext?.preferences?.pace, {
    dayWindowMinutes: 14 * 60,
    avgDurationMinutes,
  });
  const itineraryByDay = {};
  for (const item of itineraryItems) {
    const key = dayKeyFromIso(item?.timelineStartDate);
    if (!key) continue;
    itineraryByDay[key] = (itineraryByDay[key] || 0) + 1;
  }

  const modelInput = {
    ...aiInput,
    activities: selected,
    planningRules: {
      objective: 'Generate a complete day-by-day itinerary with morning and afternoon coverage.',
      sleepWindow: {
        wakeUpTime: aiInput?.userContext?.preferences?.wakeUpTime || null,
        sleepTime: aiInput?.userContext?.preferences?.sleepTime || null,
      },
      dayCoverage: {
        minActivitiesPerDay: paceTargets.minActivitiesPerDay,
        preferredActivitiesPerDay: paceTargets.preferredActivitiesPerDay,
        requiredBlocks: ['morning', 'afternoon'],
      },
    },
  };

  return {
    modelInput,
    diagnostics: {
      ...diagnostics,
      paceTargets,
      avgDurationMinutes,
      dayCount: days.length,
      dayCoverageBefore: days.map((d) => ({
        day: d,
        itineraryItems: itineraryByDay[d] || 0,
      })),
      generationScope: generationScope || null,
    },
  };
}

function applyActionToItems(baseItems = [], action = {}, activityDurationById = new Map()) {
  const type = String(action?.type || '').trim();
  const items = baseItems.slice();
  if (!type) return items;

  if (type === 'remove_activity') {
    const itineraryItemId = String(action?.itineraryItemId || '').trim();
    const activityId = String(action?.activityId || '').trim();
    return items.filter((it) => {
      const sameItem = itineraryItemId && String(it?._id || '') === itineraryItemId;
      const sameActivity = activityId && String(it?.activityId || '') === activityId;
      return !(sameItem || sameActivity);
    });
  }

  if (type === 'update_activity' || type === 'reorder_activity') {
    const itineraryItemId = String(action?.itineraryItemId || '').trim();
    const activityId = String(action?.activityId || '').trim();
    return items.map((it) => {
      const sameItem = itineraryItemId && String(it?._id || '') === itineraryItemId;
      const sameActivity = activityId && String(it?.activityId || '') === activityId;
      if (!(sameItem || sameActivity)) return it;
      return {
        ...it,
        timelineStartDate: action?.timelineStartDate || it.timelineStartDate,
        timelineEndDate: action?.timelineEndDate || it.timelineEndDate,
      };
    });
  }

  if (type === 'add_activity') {
    const activityId = String(action?.activityId || '').trim();
    const startIso = normalizeIsoOrNull(action?.timelineStartDate);
    if (!activityId || !startIso) return items;
    const endIso =
      normalizeIsoOrNull(action?.timelineEndDate) ||
      new Date(new Date(startIso).getTime() + (activityDurationById.get(activityId) || DEFAULT_ACTIVITY_DURATION_MIN) * 60000).toISOString();
    return items.concat([
      {
        _id: `virtual-${activityId}-${startIso}`,
        activityId,
        timelineStartDate: startIso,
        timelineEndDate: endIso,
      },
    ]);
  }

  return items;
}

function normalizeActionWindow(action = {}, context = {}) {
  const type = String(action?.type || '').trim();
  if (!type) return null;
  if (type === 'remove_activity') return { ...action };

  const wakeMin = context.wakeMin;
  const sleepMin = context.sleepMin;
  const activityDurationById = context.activityDurationById || new Map();
  const startIsoRaw = normalizeIsoOrNull(action?.timelineStartDate);
  if (!startIsoRaw) return action;

  const day = dayKeyFromIso(startIsoRaw);
  if (!day) return action;
  const startMinRaw = isoToUtcMinutes(startIsoRaw);
  if (startMinRaw == null) return action;

  const activityId = String(action?.activityId || '').trim();
  const durationMin = activityDurationById.get(activityId) || DEFAULT_ACTIVITY_DURATION_MIN;
  const latestStart = Math.max(wakeMin, sleepMin - Math.max(durationMin, MIN_ACTIVITY_DURATION_MIN));
  const clampedStartMin = clamp(startMinRaw, wakeMin, latestStart);
  const startIso = withUtcMinutes(day, clampedStartMin);

  let endIso = normalizeIsoOrNull(action?.timelineEndDate);
  let endMin = endIso ? isoToUtcMinutes(endIso) : null;
  if (endMin == null || endMin <= clampedStartMin) {
    endMin = clampedStartMin + Math.max(durationMin, MIN_ACTIVITY_DURATION_MIN);
  }
  endMin = clamp(endMin, clampedStartMin + MIN_ACTIVITY_DURATION_MIN, sleepMin);
  endIso = withUtcMinutes(day, endMin);

  return {
    ...action,
    timelineStartDate: startIso,
    timelineEndDate: endIso,
  };
}

function getDayIntervals(items = [], dayKey) {
  const intervals = [];
  for (const it of items) {
    const startIso = normalizeIsoOrNull(it?.timelineStartDate);
    if (!startIso || dayKeyFromIso(startIso) !== dayKey) continue;
    const endIso = normalizeIsoOrNull(it?.timelineEndDate) || new Date(new Date(startIso).getTime() + DEFAULT_ACTIVITY_DURATION_MIN * 60000).toISOString();
    const startMin = isoToUtcMinutes(startIso);
    const endMin = isoToUtcMinutes(endIso);
    if (startMin == null || endMin == null || endMin <= startMin) continue;
    intervals.push({ start: startMin, end: endMin });
  }
  intervals.sort((a, b) => a.start - b.start);
  return intervals;
}

function findFreeStart(intervals = [], preferredStartMin, durationMin, wakeMin, sleepMin) {
  const safeDuration = Math.max(durationMin, MIN_ACTIVITY_DURATION_MIN);
  const dayEnd = sleepMin;
  let candidate = clamp(preferredStartMin, wakeMin, Math.max(wakeMin, dayEnd - safeDuration));

  for (let i = 0; i < 24; i += 1) {
    let conflict = null;
    for (const slot of intervals) {
      if (intervalOverlap(candidate, candidate + safeDuration, slot.start - DAY_BUFFER_MIN, slot.end + DAY_BUFFER_MIN)) {
        conflict = slot;
        break;
      }
    }
    if (!conflict) return candidate;
    candidate = conflict.end + DAY_BUFFER_MIN;
    if (candidate + safeDuration > dayEnd) break;
  }
  return null;
}

function appendReason(baseReason, suffix) {
  const base = String(baseReason || '').trim();
  const next = String(suffix || '').trim();
  if (!next) return base || null;
  if (!base) return next;
  if (base.includes(next)) return base;
  return `${base}; ${next}`;
}

function findFreeStartBestEffort(intervals = [], preferredStartMin, durationMin, wakeMin, sleepMin) {
  const strictStart = findFreeStart(intervals, preferredStartMin, durationMin, wakeMin, sleepMin);
  if (strictStart != null) {
    return {
      startMin: strictStart,
      windowWakeMin: wakeMin,
      windowSleepMin: sleepMin,
      usedOverflow: false,
    };
  }

  const tolerance = Math.max(0, Math.floor(Number(AI_WINDOW_OVERFLOW_TOLERANCE_MIN) || 0));
  if (!tolerance) {
    return {
      startMin: null,
      windowWakeMin: wakeMin,
      windowSleepMin: sleepMin,
      usedOverflow: false,
    };
  }

  const relaxedWake = clamp(wakeMin - tolerance, 0, 23 * 60 + 59);
  const relaxedSleep = clamp(sleepMin + tolerance, relaxedWake + MIN_ACTIVITY_DURATION_MIN, 23 * 60 + 59);
  const relaxedStart = findFreeStart(intervals, preferredStartMin, durationMin, relaxedWake, relaxedSleep);

  return {
    startMin: relaxedStart,
    windowWakeMin: relaxedWake,
    windowSleepMin: relaxedSleep,
    usedOverflow: relaxedStart != null,
  };
}

function itemMatchesActionTarget(item = {}, action = {}) {
  const itineraryItemId = String(action?.itineraryItemId || '').trim();
  const activityId = String(action?.activityId || '').trim();
  const itemId = String(item?._id || '').trim();
  const itemActivityId = String(item?.activityId || '').trim();
  if (itineraryItemId && itemId && itineraryItemId === itemId) return true;
  if (activityId && itemActivityId && activityId === itemActivityId) return true;
  return false;
}

function dedupeActions(actions = []) {
  const seen = new Set();
  const deduped = [];
  const dropped = [];
  for (let i = 0; i < actions.length; i += 1) {
    const action = actions[i];
    const key = [
      String(action?.type || '').trim(),
      String(action?.itineraryItemId || '').trim(),
      String(action?.activityId || '').trim(),
      String(action?.timelineStartDate || '').trim(),
      String(action?.timelineEndDate || '').trim(),
    ].join('|');
    if (seen.has(key)) {
      dropped.push({
        index: i,
        reason: 'duplicate_action',
        type: String(action?.type || '').trim() || null,
        itineraryItemId: String(action?.itineraryItemId || '').trim() || null,
        activityId: String(action?.activityId || '').trim() || null,
      });
      continue;
    }
    seen.add(key);
    deduped.push(action);
  }
  return { deduped, dropped };
}

function resolvePrimaryActionConflicts(normalizedActions = [], tripItems = [], context = {}) {
  const wakeMin = Number(context?.wakeMin);
  const sleepMin = Number(context?.sleepMin);
  const activityDurationById = context?.activityDurationById || new Map();

  const { deduped, dropped: duplicateDrops } = dedupeActions(normalizedActions);
  const dropped = [...duplicateDrops];

  const ordered = [
    ...deduped.filter((action) => String(action?.type || '').trim() === 'remove_activity'),
    ...deduped.filter((action) => {
      const type = String(action?.type || '').trim();
      return type === 'update_activity' || type === 'reorder_activity';
    }),
    ...deduped.filter((action) => String(action?.type || '').trim() === 'add_activity'),
  ];

  const accepted = [];
  let overflowAssignments = 0;
  let workingItems = tripItems.slice();

  for (const action of ordered) {
    const type = String(action?.type || '').trim();
    if (!type) continue;

    const targetRows = workingItems.filter((row) => itemMatchesActionTarget(row, action));
    const hasTarget = targetRows.length > 0;

    if (type === 'remove_activity') {
      if (!hasTarget) {
        dropped.push({
          reason: 'remove_target_not_found',
          type,
          itineraryItemId: String(action?.itineraryItemId || '').trim() || null,
          activityId: String(action?.activityId || '').trim() || null,
        });
        continue;
      }
      workingItems = applyActionToItems(workingItems, action, activityDurationById);
      accepted.push(action);
      continue;
    }

    if ((type === 'update_activity' || type === 'reorder_activity') && !hasTarget) {
      dropped.push({
        reason: 'update_target_not_found',
        type,
        itineraryItemId: String(action?.itineraryItemId || '').trim() || null,
        activityId: String(action?.activityId || '').trim() || null,
      });
      continue;
    }

    if (type === 'update_activity' || type === 'reorder_activity') {
      const baseAction = { ...action };
      const startIso = normalizeIsoOrNull(baseAction?.timelineStartDate);
      const endIso = normalizeIsoOrNull(baseAction?.timelineEndDate);

      if (startIso) {
        const day = dayKeyFromIso(startIso);
        const startMin = isoToUtcMinutes(startIso);
        const candidateActivityId = String(baseAction?.activityId || targetRows[0]?.activityId || '').trim();
        const fallbackDuration = activityDurationById.get(candidateActivityId) || DEFAULT_ACTIVITY_DURATION_MIN;
        const explicitEndMin = endIso ? isoToUtcMinutes(endIso) : null;
        const durationMin = explicitEndMin != null && startMin != null && explicitEndMin > startMin
          ? (explicitEndMin - startMin)
          : fallbackDuration;

        if (!day || startMin == null) {
          dropped.push({
            reason: 'invalid_update_schedule',
            type,
            itineraryItemId: String(baseAction?.itineraryItemId || '').trim() || null,
            activityId: candidateActivityId || null,
          });
          continue;
        }

        const nonTargetItems = workingItems.filter((row) => !itemMatchesActionTarget(row, baseAction));
        const intervals = getDayIntervals(nonTargetItems, day);
        const freeSlot = findFreeStartBestEffort(intervals, startMin, durationMin, wakeMin, sleepMin);
        if (freeSlot.startMin == null) {
          dropped.push({
            reason: 'update_no_free_slot',
            type,
            itineraryItemId: String(baseAction?.itineraryItemId || '').trim() || null,
            activityId: candidateActivityId || null,
          });
          continue;
        }

        if (freeSlot.usedOverflow) overflowAssignments += 1;
        const safeEnd = clamp(
          freeSlot.startMin + Math.max(durationMin, MIN_ACTIVITY_DURATION_MIN),
          freeSlot.startMin + MIN_ACTIVITY_DURATION_MIN,
          freeSlot.windowSleepMin
        );
        const rebased = {
          ...baseAction,
          timelineStartDate: withUtcMinutes(day, freeSlot.startMin),
          timelineEndDate: withUtcMinutes(day, safeEnd),
          reason: freeSlot.usedOverflow
            ? appendReason(baseAction?.reason, 'overflow-window-tolerance')
            : baseAction?.reason || null,
        };
        workingItems = applyActionToItems(workingItems, rebased, activityDurationById);
        accepted.push(rebased);
        continue;
      }

      workingItems = applyActionToItems(workingItems, baseAction, activityDurationById);
      accepted.push(baseAction);
      continue;
    }

    if (type === 'add_activity') {
      const activityId = String(action?.activityId || '').trim();
      const startIso = normalizeIsoOrNull(action?.timelineStartDate);
      if (!activityId || !startIso) {
        dropped.push({
          reason: 'invalid_add_payload',
          type,
          itineraryItemId: null,
          activityId: activityId || null,
        });
        continue;
      }

      const day = dayKeyFromIso(startIso);
      const startMin = isoToUtcMinutes(startIso);
      const endMinRaw = normalizeIsoOrNull(action?.timelineEndDate)
        ? isoToUtcMinutes(action.timelineEndDate)
        : null;
      const fallbackDuration = activityDurationById.get(activityId) || DEFAULT_ACTIVITY_DURATION_MIN;
      const durationMin = (startMin != null && endMinRaw != null && endMinRaw > startMin)
        ? (endMinRaw - startMin)
        : fallbackDuration;

      if (!day || startMin == null) {
        dropped.push({
          reason: 'invalid_add_schedule',
          type,
          itineraryItemId: null,
          activityId,
        });
        continue;
      }

      const intervals = getDayIntervals(workingItems, day);
      const freeSlot = findFreeStartBestEffort(intervals, startMin, durationMin, wakeMin, sleepMin);
      if (freeSlot.startMin == null) {
        dropped.push({
          reason: 'add_no_free_slot',
          type,
          itineraryItemId: null,
          activityId,
        });
        continue;
      }

      if (freeSlot.usedOverflow) overflowAssignments += 1;
      const safeEnd = clamp(
        freeSlot.startMin + Math.max(durationMin, MIN_ACTIVITY_DURATION_MIN),
        freeSlot.startMin + MIN_ACTIVITY_DURATION_MIN,
        freeSlot.windowSleepMin
      );
      const rebased = {
        ...action,
        timelineStartDate: withUtcMinutes(day, freeSlot.startMin),
        timelineEndDate: withUtcMinutes(day, safeEnd),
        reason: freeSlot.usedOverflow
          ? appendReason(action?.reason, 'overflow-window-tolerance')
          : action?.reason || null,
      };
      workingItems = applyActionToItems(workingItems, rebased, activityDurationById);
      accepted.push(rebased);
      continue;
    }
  }

  return {
    accepted,
    dropped,
    overflowAssignments,
    simulatedItems: workingItems,
  };
}

function buildAdaptivePreferredSlots(options = {}) {
  const {
    targetAdds = 0,
    wakeMin = 8 * 60,
    sleepMin = 22 * 60,
    morningStart = 9 * 60 + 30,
    afternoonStart = 15 * 60,
    needMorning = false,
    needAfternoon = false,
    referenceDurationMinutes = DEFAULT_ACTIVITY_DURATION_MIN,
  } = options;

  const out = [];
  if (needMorning) out.push(clamp(morningStart, wakeMin, sleepMin));
  if (needAfternoon) out.push(clamp(afternoonStart, wakeMin, sleepMin));
  if (targetAdds <= out.length) return out.slice(0, targetAdds);

  const remaining = targetAdds - out.length;
  const slotPadding = Math.max(30, Math.round(referenceDurationMinutes * 0.3));
  const start = clamp(wakeMin + slotPadding, wakeMin, sleepMin);
  const end = clamp(sleepMin - (referenceDurationMinutes + slotPadding), start, sleepMin);

  if (remaining === 1) {
    out.push(clamp(Math.round((start + end) / 2), wakeMin, sleepMin));
  } else {
    for (let i = 0; i < remaining; i += 1) {
      const ratio = remaining <= 1 ? 0.5 : (i / (remaining - 1));
      out.push(clamp(Math.round(start + ((end - start) * ratio)), wakeMin, sleepMin));
    }
  }

  return out
    .sort((a, b) => a - b)
    .filter((slot, index, arr) => index === 0 || Math.abs(slot - arr[index - 1]) >= 30);
}

function enforceAndRepairPlan(sanitized = {}, modelInput = {}, generationScope = null) {
  const aiActions = Array.isArray(sanitized?.actions) ? sanitized.actions : [];
  const tripItems = Array.isArray(modelInput?.itinerary?.items) ? modelInput.itinerary.items : [];
  const tripDaysAll = getDateRangeDays(modelInput?.tripContext?.startDate, modelInput?.tripContext?.endDate);
  const scope = generationScope?.scope === 'selected_day' ? 'selected_day' : 'whole_trip';
  const targetDayYmd = scope === 'selected_day'
    ? String(generationScope?.targetDayYmd || '').trim()
    : '';
  const tripDays = (scope === 'selected_day' && targetDayYmd)
    ? [targetDayYmd]
    : tripDaysAll;
  const prefWake = String(modelInput?.userContext?.preferences?.wakeUpTime || '').trim();
  const prefSleep = String(modelInput?.userContext?.preferences?.sleepTime || '').trim();
  const windowSeedItems = (scope === 'selected_day' && targetDayYmd)
    ? tripItems.filter((it) => dayKeyFromIso(it?.timelineStartDate) === targetDayYmd)
    : tripItems;
  const itineraryWindow = deriveWindowFromItineraryUtcMinutes(windowSeedItems);
  let wakeMin = prefWake
    ? parseTimeToMinutes(prefWake, parseTimeToMinutes(DEFAULT_WAKE_TIME, 8 * 60))
    : (itineraryWindow?.wakeMin ?? parseTimeToMinutes(DEFAULT_WAKE_TIME, 8 * 60));
  let sleepMin = prefSleep
    ? parseTimeToMinutes(prefSleep, parseTimeToMinutes(DEFAULT_SLEEP_TIME, 22 * 60))
    : (itineraryWindow?.sleepMin ?? parseTimeToMinutes(DEFAULT_SLEEP_TIME, 22 * 60));
  let windowSource = prefWake || prefSleep ? 'preferences' : (itineraryWindow ? 'itinerary-derived' : 'default');

  // If inferred itinerary window is too narrow, it blocks realistic day generation.
  const MIN_INFERRED_WINDOW_MIN = 9 * 60;
  if (!prefWake && !prefSleep && itineraryWindow && (sleepMin - wakeMin < MIN_INFERRED_WINDOW_MIN)) {
    wakeMin = parseTimeToMinutes(DEFAULT_WAKE_TIME, 8 * 60);
    sleepMin = parseTimeToMinutes(DEFAULT_SLEEP_TIME, 22 * 60);
    windowSource = 'default-expanded';
  }

  if (sleepMin - wakeMin < 4 * 60) {
    wakeMin = parseTimeToMinutes(DEFAULT_WAKE_TIME, 8 * 60);
    sleepMin = parseTimeToMinutes(DEFAULT_SLEEP_TIME, 22 * 60);
    windowSource = 'default-expanded';
  }

  const morningStart = clamp(wakeMin + 30, wakeMin, sleepMin);
  const morningEnd = clamp(12 * 60 + 30, morningStart, sleepMin);
  const afternoonStart = clamp(14 * 60, morningEnd, sleepMin);

  const activities = Array.isArray(modelInput?.activities) ? modelInput.activities : [];
  const activityById = new Map(activities.map((a) => [String(a?._id || ''), a]));
  const avgDurationMinutes = computeAverageActivityDurationMinutes(activities, DEFAULT_ACTIVITY_DURATION_MIN);
  const paceTargets = derivePaceTargets(modelInput?.userContext?.preferences?.pace, {
    dayWindowMinutes: sleepMin - wakeMin,
    avgDurationMinutes,
  });
  const activityDurationById = new Map(
    activities.map((a) => [String(a?._id || ''), getActivityDurationMin(a)])
  );

  const normalizedActions = aiActions
    .map((a) =>
      normalizeActionWindow(a, {
        wakeMin,
        sleepMin,
        activityDurationById,
      })
    )
    .filter(Boolean);

  const {
    accepted: primaryActions,
    dropped: primaryDroppedActions,
    overflowAssignments: primaryOverflowAssignments,
    simulatedItems: simulatedAfterPrimary
  } = resolvePrimaryActionConflicts(
    normalizedActions,
    tripItems,
    {
      wakeMin,
      sleepMin,
      activityDurationById,
    }
  );

  let simulatedItems = simulatedAfterPrimary.slice();

  const usedActivityIds = new Set(
    simulatedItems
      .map((it) => String(it?.activityId || '').trim())
      .filter(Boolean)
  );

  const repairActions = [];
  let repairOverflowAssignments = 0;
  const activityQueue = activities
    .map((a) => String(a?._id || '').trim())
    .filter(Boolean);

  for (const day of tripDays) {
    const dayItems = simulatedItems.filter((it) => dayKeyFromIso(it?.timelineStartDate) === day);
    const intervals = getDayIntervals(dayItems, day);
    const occupiedMin = intervals.reduce((acc, s) => acc + Math.max(0, s.end - s.start), 0);
    const hasMorning = intervals.some((s) => intervalOverlap(s.start, s.end, morningStart, morningEnd));
    const hasAfternoon = intervals.some((s) => intervalOverlap(s.start, s.end, afternoonStart, sleepMin));

    const needMorning = !hasMorning;
    const needAfternoon = !hasAfternoon;
    const hardCoverageNeed = (needMorning ? 1 : 0) + (needAfternoon ? 1 : 0);
    const activitiesGapToMin = Math.max(0, paceTargets.minActivitiesPerDay - dayItems.length);
    const activitiesGapToPreferred = Math.max(0, paceTargets.preferredActivitiesPerDay - dayItems.length);
    const minutesGapToTarget = Math.max(0, paceTargets.targetOccupiedMinutesPerDay - occupiedMin);
    const estimatedAddsForMinutes = Math.ceil(
      minutesGapToTarget / Math.max(paceTargets.referenceDurationMinutes, MIN_ACTIVITY_DURATION_MIN)
    );

    // Best effort: combine signals instead of forcing one deterministic count tier.
    const weightedDemand = Math.ceil(
      (activitiesGapToMin * 0.35) +
      (activitiesGapToPreferred * 0.65) +
      (estimatedAddsForMinutes * 0.6)
    );

    const maxAddsByCount = Math.max(0, paceTargets.maxActivitiesPerDay - dayItems.length);
    const maxAddsByTime = Math.max(
      0,
      Math.floor((sleepMin - wakeMin) / Math.max(paceTargets.referenceDurationMinutes + DAY_BUFFER_MIN, MIN_ACTIVITY_DURATION_MIN)) - dayItems.length
    );
    const availableCandidates = Math.max(0, activityQueue.length - usedActivityIds.size);
    const maxAddsFeasible = Math.max(0, Math.min(maxAddsByCount, maxAddsByTime, availableCandidates));

    let targetAdds = Math.max(hardCoverageNeed, weightedDemand);
    if (hardCoverageNeed > 0 && maxAddsFeasible > 0) {
      targetAdds = Math.max(targetAdds, Math.min(hardCoverageNeed, maxAddsFeasible));
    }
    targetAdds = Math.min(targetAdds, maxAddsFeasible);

    if (!targetAdds) continue;

    const preferredSlots = buildAdaptivePreferredSlots({
      targetAdds,
      wakeMin,
      sleepMin,
      morningStart,
      afternoonStart,
      needMorning,
      needAfternoon,
      referenceDurationMinutes: paceTargets.referenceDurationMinutes,
    });

    for (const preferredStart of preferredSlots) {
      const candidateId = activityQueue.find((id) => !usedActivityIds.has(id));
      if (!candidateId) break;
      const duration = activityDurationById.get(candidateId) || DEFAULT_ACTIVITY_DURATION_MIN;
      const freeSlot = findFreeStartBestEffort(intervals, preferredStart, duration, wakeMin, sleepMin);
      if (freeSlot.startMin == null) continue;
      if (freeSlot.usedOverflow) repairOverflowAssignments += 1;
      const endMin = clamp(
        freeSlot.startMin + duration,
        freeSlot.startMin + MIN_ACTIVITY_DURATION_MIN,
        freeSlot.windowSleepMin
      );
      const addAction = {
        type: 'add_activity',
        itineraryItemId: null,
        activityId: candidateId,
        timelineStartDate: withUtcMinutes(day, freeSlot.startMin),
        timelineEndDate: withUtcMinutes(day, endMin),
        reason: freeSlot.usedOverflow
          ? 'repair:day-coverage; overflow-window-tolerance'
          : 'repair:day-coverage',
      };
      repairActions.push(addAction);
      usedActivityIds.add(candidateId);
      intervals.push({ start: freeSlot.startMin, end: endMin });
      intervals.sort((a, b) => a.start - b.start);
      simulatedItems = applyActionToItems(simulatedItems, addAction, activityDurationById);
    }
  }

  const mergedActions = primaryActions.concat(repairActions);
  return {
    ...sanitized,
    actions: mergedActions,
    actionsToApply: mergedActions,
    validation: {
      ...(sanitized.validation || {}),
      primaryActionsAccepted: primaryActions.length,
      primaryActionsDropped: primaryDroppedActions.length,
      actionsAfterRepair: mergedActions.length,
      repairActionsAdded: repairActions.length,
    },
    diagnostics: {
      ...(sanitized.diagnostics || {}),
      repair: {
        enabled: true,
        scope,
        targetDayYmd: targetDayYmd || null,
        windowSource,
        wakeTime: minutesToHHmm(wakeMin),
        sleepTime: minutesToHHmm(sleepMin),
        wakeMin,
        sleepMin,
        pace: paceTargets.pace,
        paceTargets,
        avgDurationMinutes,
        dayCount: tripDays.length,
        primaryActionsAccepted: primaryActions.length,
        primaryActionsDropped: primaryDroppedActions.length,
        primaryOverflowAssignments,
        repairActionsAdded: repairActions.length,
        repairOverflowAssignments,
        totalOverflowAssignments: primaryOverflowAssignments + repairOverflowAssignments,
        windowOverflowToleranceMin: Math.max(0, Math.floor(Number(AI_WINDOW_OVERFLOW_TOLERANCE_MIN) || 0)),
        primaryDroppedActions: primaryDroppedActions.slice(0, 20),
      },
    },
  };
}

function sanitizeAiActionWithReason(action, context = {}) {
  if (!action || typeof action !== 'object') {
    return { action: null, rejectReason: 'invalid_action_shape' };
  }

  const type = String(action.type || '').trim();
  if (!ALLOWED_ACTION_TYPES.has(type)) {
    return { action: null, rejectReason: 'invalid_action_type' };
  }

  const itineraryItemId = isObjectIdLike(action.itineraryItemId)
    ? String(action.itineraryItemId)
    : null;
  const activityId = isObjectIdLike(action.activityId)
    ? String(action.activityId)
    : null;
  const timelineStartDate = normalizeIsoOrNull(action.timelineStartDate);
  const timelineEndDate = normalizeIsoOrNull(action.timelineEndDate);
  const reason = String(action.reason || '').trim() || null;
  const {
    allowedActivityIds = new Set(),
    allowedItineraryItemIds = new Set(),
  } = context;

  if (type === 'add_activity' && (!activityId || !timelineStartDate)) {
    return { action: null, rejectReason: 'missing_required_fields_for_add' };
  }
  if ((type === 'update_activity' || type === 'reorder_activity') && !itineraryItemId && !activityId) {
    return { action: null, rejectReason: 'missing_target_for_update_or_reorder' };
  }
  if (type === 'remove_activity' && !itineraryItemId && !activityId) {
    return { action: null, rejectReason: 'missing_target_for_remove' };
  }

  if (activityId && allowedActivityIds.size && !allowedActivityIds.has(activityId)) {
    return { action: null, rejectReason: 'activity_not_in_allowed_set' };
  }
  if (itineraryItemId && allowedItineraryItemIds.size && !allowedItineraryItemIds.has(itineraryItemId)) {
    return { action: null, rejectReason: 'itinerary_item_not_in_allowed_set' };
  }

  const normalizedAction = {
    type,
    itineraryItemId,
    activityId,
    timelineStartDate,
    timelineEndDate,
    reason,
  };

  if (timelineStartDate && timelineEndDate) {
    const s = +new Date(timelineStartDate);
    const e = +new Date(timelineEndDate);
    if (Number.isFinite(s) && Number.isFinite(e) && e < s) {
      return {
        action: {
          ...normalizedAction,
          timelineEndDate: null,
        },
        rejectReason: null,
      };
    }
  }

  return { action: normalizedAction, rejectReason: null };
}

function sanitizeAiResult(result, aiInput = {}, generationScope = null) {
  const raw = result && typeof result === 'object' ? result : {};
  const scope = generationScope?.scope === 'selected_day' ? 'selected_day' : 'whole_trip';
  const targetDayYmd = scope === 'selected_day'
    ? String(generationScope?.targetDayYmd || '').trim()
    : '';
  const allItineraryItems = Array.isArray(aiInput?.itinerary?.items) ? aiInput.itinerary.items : [];
  const scopedItineraryItems = (scope === 'selected_day' && targetDayYmd)
    ? allItineraryItems.filter((it) => dayKeyFromIso(it?.timelineStartDate) === targetDayYmd)
    : allItineraryItems;

  const allowedActivityIds = new Set(
    (Array.isArray(aiInput?.activities) ? aiInput.activities : [])
      .map((a) => String(a?._id || '').trim())
      .filter(Boolean)
  );
  const allowedItineraryItemIds = new Set(
    scopedItineraryItems
      .map((it) => String(it?._id || '').trim())
      .filter(Boolean)
  );
  const allowedActivityIdsFromItinerary = new Set(
    scopedItineraryItems
      .map((it) => String(it?.activityId || '').trim())
      .filter(Boolean)
  );
  for (const itActId of allowedActivityIdsFromItinerary) {
    allowedActivityIds.add(itActId);
  }

  const rawActions = Array.isArray(raw.actions) ? raw.actions : [];
  const rejectedDetails = [];
  const acceptedEntries = [];

  for (let i = 0; i < rawActions.length; i += 1) {
    const rawAction = rawActions[i];
    const { action, rejectReason } = sanitizeAiActionWithReason(rawAction, {
      allowedActivityIds,
      allowedItineraryItemIds,
    });
    if (!action) {
      rejectedDetails.push({
        index: i,
        reason: rejectReason || 'unknown_rejection',
        type: String(rawAction?.type || '').trim() || null,
        itineraryItemId: String(rawAction?.itineraryItemId || '').trim() || null,
        activityId: String(rawAction?.activityId || '').trim() || null,
      });
      continue;
    }
    acceptedEntries.push({
      index: i,
      action,
    });
  }

  if (scope === 'selected_day' && targetDayYmd) {
    const scopedEntries = [];
    for (const entry of acceptedEntries) {
      const rebasedAction = applySelectedDayScopeToAction(entry.action, targetDayYmd);
      const touchesSelectedDay = actionTouchesSelectedDay(
        rebasedAction,
        targetDayYmd,
        allowedItineraryItemIds,
        allowedActivityIdsFromItinerary
      );
      if (!touchesSelectedDay) {
        rejectedDetails.push({
          index: entry.index,
          reason: 'outside_selected_day_scope',
          type: String(entry.action?.type || '').trim() || null,
          itineraryItemId: String(entry.action?.itineraryItemId || '').trim() || null,
          activityId: String(entry.action?.activityId || '').trim() || null,
        });
        continue;
      }
      scopedEntries.push({
        ...entry,
        action: rebasedAction,
      });
    }
    acceptedEntries.length = 0;
    acceptedEntries.push(...scopedEntries);
  }

  const actions = acceptedEntries.map((entry) => entry.action);

  return {
    trip_analysis: raw.trip_analysis && typeof raw.trip_analysis === 'object' ? raw.trip_analysis : null,
    highLevelSummary: typeof raw.highLevelSummary === 'string' ? raw.highLevelSummary : '',
    notes: typeof raw.notes === 'string' ? raw.notes : '',
    actions,
    validation: {
      actionsReceived: rawActions.length,
      actionsAccepted: actions.length,
      actionsRejected: Math.max(rawActions.length - actions.length, 0),
      rejectedDetails,
      allowedActivities: allowedActivityIds.size,
      allowedItineraryItems: allowedItineraryItemIds.size,
      scope,
      targetDayYmd: targetDayYmd || null,
    },
    rawText: raw.rawText || null,
    parsingError: raw.parsingError || null,
    meta: raw.meta && typeof raw.meta === 'object' ? raw.meta : null,
    diagnostics: raw.diagnostics && typeof raw.diagnostics === 'object' ? raw.diagnostics : null,
  };
}

/**
 * POST /api/ai/itinerary
 *
 * Controller that receives the AiItineraryInput payload from the frontend,
 * calls Gemini through the gemini.service, and returns the structured AI response.
 */
exports.generateItinerary = async (req, res) => {
  try {
    const aiInput = req.body;

    if (!aiInput) {
      return res.status(400).json({
        success: false,
        message: 'Missing AI input payload in request body',
      });
    }

    // Optional: allow the client to pass extra instructions for the AI
    const extraInstructions =
      typeof req.body.extraInstructions === 'string'
        ? req.body.extraInstructions
        : undefined;
    const generationScope = normalizeGenerationScope(req.body?.generationScope, aiInput);

    const reqSummary = {
      hasTripContext: !!aiInput?.tripContext,
      startDate: aiInput?.tripContext?.startDate || null,
      endDate: aiInput?.tripContext?.endDate || null,
      visitPlaces: Array.isArray(aiInput?.tripContext?.visitPlaces)
        ? aiInput.tripContext.visitPlaces.length
        : 0,
      itineraryItems: Array.isArray(aiInput?.itinerary?.items)
        ? aiInput.itinerary.items.length
        : 0,
      activities: Array.isArray(aiInput?.activities)
        ? aiInput.activities.length
        : 0,
      favoriteActivityIds: Array.isArray(aiInput?.userContext?.favorites?.activityIds)
        ? aiInput.userContext.favorites.activityIds.length
        : 0,
      hasExtraInstructions: !!extraInstructions,
      generationScope,
      userId: req?.user?._id ? String(req.user._id) : null,
    };
    console.log(`${AI_LOG_PREFIX} incoming`, reqSummary);

    const { modelInput, diagnostics } = buildAiInputForModel(aiInput, generationScope);
    console.log(`${AI_LOG_PREFIX} prepared-input`, diagnostics);

    if (!AI_EXECUTION_ENABLED) {
      console.log(`${AI_LOG_PREFIX} ai-execution-disabled`, {
        reason: 'AI_EXECUTION_ENABLED is false',
      });
      return res.status(200).json({
        success: true,
        data: {
          trip_analysis: null,
          highLevelSummary: '',
          notes: '',
          actions: [],
          validation: {
            actionsReceived: 0,
            actionsAccepted: 0,
            actionsRejected: 0,
            allowedActivities: Array.isArray(modelInput?.activities) ? modelInput.activities.length : 0,
            allowedItineraryItems: Array.isArray(modelInput?.itinerary?.items) ? modelInput.itinerary.items.length : 0,
          },
          rawText: null,
          parsingError: null,
          meta: {
            executionSkipped: true,
            reason: 'AI execution disabled for input validation phase',
          },
          diagnostics: {
            preparedInput: diagnostics,
          },
        },
      });
    }

    const result = await generateItineraryResponse(modelInput, {
      extraInstructions,
    });
    const sanitized = sanitizeAiResult(result, modelInput, generationScope);
    const repaired = enforceAndRepairPlan(sanitized, modelInput, generationScope);

    console.log(`${AI_LOG_PREFIX} outgoing`, {
      parsingError: repaired?.parsingError || null,
      actionsReceived: repaired?.validation?.actionsReceived ?? 0,
      actionsAccepted: repaired?.validation?.actionsAccepted ?? 0,
      actionsRejected: repaired?.validation?.actionsRejected ?? 0,
      rejectedDetailsCount: Array.isArray(repaired?.validation?.rejectedDetails)
        ? repaired.validation.rejectedDetails.length
        : 0,
      primaryActionsAccepted: repaired?.validation?.primaryActionsAccepted ?? 0,
      primaryActionsDropped: repaired?.validation?.primaryActionsDropped ?? 0,
      actionsAfterRepair: repaired?.validation?.actionsAfterRepair ?? 0,
      repairActionsAdded: repaired?.validation?.repairActionsAdded ?? 0,
      modelId: repaired?.meta?.modelId || null,
      attempt: repaired?.meta?.attempt || null,
      fallbackUsed: !!repaired?.diagnostics?.fallbackUsed,
      preparedActivities: diagnostics?.selectedActivities ?? 0,
    });

    return res.status(200).json({
      success: true,
      data: repaired,
    });
  } catch (err) {
    console.error(`${AI_LOG_PREFIX} error`, {
      message: err?.message || String(err),
      stack: err?.stack || null,
    });

    return res.status(500).json({
      success: false,
      message: 'Failed to generate itinerary with Gemini',
      error: err.message || String(err),
    });
  }
};
