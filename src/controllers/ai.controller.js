const { generateItineraryResponse } = require('../services/gemini.service');
const AI_LOG_PREFIX = '[AI][controller]';
const AI_SELECTED_ACTIVITIES_CAP = Number(process.env.AI_SELECTED_ACTIVITIES_CAP || 24);
const AI_EXECUTION_ENABLED = String(process.env.AI_EXECUTION_ENABLED || 'true').toLowerCase() === 'true';
const AI_MIN_ACTIVITIES_PER_DAY = Number(process.env.AI_MIN_ACTIVITIES_PER_DAY || 2);
const AI_MIN_OCCUPIED_MINUTES_PER_DAY = Number(process.env.AI_MIN_OCCUPIED_MINUTES_PER_DAY || 240);
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

function buildSelectedActivitiesForAi(aiInput = {}) {
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

  const placeTypeSet = new Set(
    (Array.isArray(aiInput?.tripContext?.visitPlaces) ? aiInput.tripContext.visitPlaces : [])
      .map((p) => String(p?.type || '').trim().toLowerCase())
      .filter(Boolean)
  );

  const normalized = allActivities.map((a) => {
    const id = String(a?._id || '').trim();
    const priority = toNumberOrNull(a?.ranking?.priority) ?? 0;
    const categoryIds = [
      String(a?.activityCategoryId || '').trim(),
      ...(Array.isArray(a?.activityCategoryIds) ? a.activityCategoryIds.map((x) => String(x || '').trim()) : []),
    ].filter(Boolean);
    const categoryWeight = categoryIds.reduce((acc, cid) => acc + (topCategoryWeights.get(cid) || 0), 0);
    const inItinerary = itineraryActivityIds.has(id);
    const isFavorite = favoriteIds.has(id);

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

    const score =
      (isFavorite ? 200 : 0) +
      (inItinerary ? 140 : 0) +
      categoryWeight * 120 +
      clamp(priority, 0, 100);

    return {
      ...a,
      _id: id,
      location: scopedLocation,
      __score: score,
      __isFavorite: isFavorite,
      __inItinerary: inItinerary,
      __categoryWeight: categoryWeight,
      __priority: priority,
    };
  });

  normalized.sort((a, b) => {
    if (b.__score !== a.__score) return b.__score - a.__score;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });

  const cap = Number.isFinite(AI_SELECTED_ACTIVITIES_CAP) && AI_SELECTED_ACTIVITIES_CAP > 0
    ? AI_SELECTED_ACTIVITIES_CAP
    : 24;

  const selected = normalized.slice(0, cap).map((a) => {
    const {
      __score,
      __isFavorite,
      __inItinerary,
      __categoryWeight,
      __priority,
      ...clean
    } = a;
    return clean;
  });

  return {
    selected,
    diagnostics: {
      totalActivities: normalized.length,
      selectedActivities: selected.length,
      cap,
      favoritesInSelected: selected.filter((a) => favoriteIds.has(String(a?._id || ''))).length,
      itineraryActivitiesInSelected: selected.filter((a) =>
        itineraryActivityIds.has(String(a?._id || ''))
      ).length,
      topSelectedPreview: normalized.slice(0, 8).map((a) => ({
        id: a._id,
        name: a.name,
        score: a.__score,
        favorite: a.__isFavorite,
        inItinerary: a.__inItinerary,
        categoryWeight: Number(a.__categoryWeight || 0),
        priority: Number(a.__priority || 0),
      })),
    },
  };
}

function buildAiInputForModel(aiInput = {}) {
  const { selected, diagnostics } = buildSelectedActivitiesForAi(aiInput);
  const days = getDateRangeDays(aiInput?.tripContext?.startDate, aiInput?.tripContext?.endDate);
  const itineraryItems = Array.isArray(aiInput?.itinerary?.items) ? aiInput.itinerary.items : [];
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
        minActivitiesPerDay: 2,
        preferredActivitiesPerDay: 3,
        requiredBlocks: ['morning', 'afternoon'],
      },
    },
  };

  return {
    modelInput,
    diagnostics: {
      ...diagnostics,
      dayCount: days.length,
      dayCoverageBefore: days.map((d) => ({
        day: d,
        itineraryItems: itineraryByDay[d] || 0,
      })),
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

function enforceAndRepairPlan(sanitized = {}, modelInput = {}) {
  const aiActions = Array.isArray(sanitized?.actions) ? sanitized.actions : [];
  const tripItems = Array.isArray(modelInput?.itinerary?.items) ? modelInput.itinerary.items : [];
  const tripDays = getDateRangeDays(modelInput?.tripContext?.startDate, modelInput?.tripContext?.endDate);
  const prefWake = String(modelInput?.userContext?.preferences?.wakeUpTime || '').trim();
  const prefSleep = String(modelInput?.userContext?.preferences?.sleepTime || '').trim();
  const itineraryWindow = deriveWindowFromItineraryUtcMinutes(tripItems);
  const wakeMin = prefWake
    ? parseTimeToMinutes(prefWake, parseTimeToMinutes(DEFAULT_WAKE_TIME, 8 * 60))
    : (itineraryWindow?.wakeMin ?? parseTimeToMinutes(DEFAULT_WAKE_TIME, 8 * 60));
  const sleepMin = prefSleep
    ? parseTimeToMinutes(prefSleep, parseTimeToMinutes(DEFAULT_SLEEP_TIME, 22 * 60))
    : (itineraryWindow?.sleepMin ?? parseTimeToMinutes(DEFAULT_SLEEP_TIME, 22 * 60));
  const morningStart = clamp(wakeMin + 30, wakeMin, sleepMin);
  const morningEnd = clamp(12 * 60 + 30, morningStart, sleepMin);
  const afternoonStart = clamp(14 * 60, morningEnd, sleepMin);

  const activities = Array.isArray(modelInput?.activities) ? modelInput.activities : [];
  const activityById = new Map(activities.map((a) => [String(a?._id || ''), a]));
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

  let simulatedItems = tripItems.slice();
  for (const action of normalizedActions) {
    simulatedItems = applyActionToItems(simulatedItems, action, activityDurationById);
  }

  const usedActivityIds = new Set(
    simulatedItems
      .map((it) => String(it?.activityId || '').trim())
      .filter(Boolean)
  );

  const repairActions = [];
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
    const needCount = Math.max(0, AI_MIN_ACTIVITIES_PER_DAY - dayItems.length);
    const needOccupied = Math.max(0, AI_MIN_OCCUPIED_MINUTES_PER_DAY - occupiedMin);
    const targetAdds = Math.max(
      needCount,
      needMorning ? 1 : 0,
      needAfternoon ? 1 : 0,
      Math.ceil(needOccupied / Math.max(DEFAULT_ACTIVITY_DURATION_MIN, MIN_ACTIVITY_DURATION_MIN))
    );
    if (!targetAdds) continue;

    const preferredSlots = [];
    if (needMorning) preferredSlots.push(clamp(9 * 60 + 30, wakeMin, sleepMin));
    if (needAfternoon) preferredSlots.push(clamp(15 * 60, wakeMin, sleepMin));
    while (preferredSlots.length < targetAdds) {
      preferredSlots.push(clamp(16 * 60, wakeMin, sleepMin));
    }

    for (const preferredStart of preferredSlots) {
      const candidateId = activityQueue.find((id) => !usedActivityIds.has(id));
      if (!candidateId) break;
      const duration = activityDurationById.get(candidateId) || DEFAULT_ACTIVITY_DURATION_MIN;
      const startMin = findFreeStart(intervals, preferredStart, duration, wakeMin, sleepMin);
      if (startMin == null) continue;
      const endMin = clamp(startMin + duration, startMin + MIN_ACTIVITY_DURATION_MIN, sleepMin);
      const addAction = {
        type: 'add_activity',
        itineraryItemId: null,
        activityId: candidateId,
        timelineStartDate: withUtcMinutes(day, startMin),
        timelineEndDate: withUtcMinutes(day, endMin),
        reason: 'repair:day-coverage',
      };
      repairActions.push(addAction);
      usedActivityIds.add(candidateId);
      intervals.push({ start: startMin, end: endMin });
      intervals.sort((a, b) => a.start - b.start);
      simulatedItems = applyActionToItems(simulatedItems, addAction, activityDurationById);
    }
  }

  const mergedActions = normalizedActions.concat(repairActions);
  return {
    ...sanitized,
    actions: mergedActions,
    validation: {
      ...(sanitized.validation || {}),
      actionsAfterRepair: mergedActions.length,
      repairActionsAdded: repairActions.length,
    },
    diagnostics: {
      ...(sanitized.diagnostics || {}),
      repair: {
        enabled: true,
        windowSource: prefWake || prefSleep ? 'preferences' : (itineraryWindow ? 'itinerary-derived' : 'default'),
        wakeTime: minutesToHHmm(wakeMin),
        sleepTime: minutesToHHmm(sleepMin),
        wakeMin,
        sleepMin,
        dayCount: tripDays.length,
        repairActionsAdded: repairActions.length,
      },
    },
  };
}

function sanitizeAiAction(action, context = {}) {
  if (!action || typeof action !== 'object') return null;

  const type = String(action.type || '').trim();
  if (!ALLOWED_ACTION_TYPES.has(type)) return null;

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

  // Field requirements by type
  if (type === 'add_activity' && (!activityId || !timelineStartDate)) {
    return null;
  }
  if ((type === 'update_activity' || type === 'reorder_activity') && !itineraryItemId && !activityId) {
    return null;
  }
  if (type === 'remove_activity' && !itineraryItemId && !activityId) {
    return null;
  }

  // Hard validation: action ids must exist in the original input payload.
  if (activityId && allowedActivityIds.size && !allowedActivityIds.has(activityId)) {
    return null;
  }
  if (itineraryItemId && allowedItineraryItemIds.size && !allowedItineraryItemIds.has(itineraryItemId)) {
    return null;
  }

  if (timelineStartDate && timelineEndDate) {
    const s = +new Date(timelineStartDate);
    const e = +new Date(timelineEndDate);
    if (Number.isFinite(s) && Number.isFinite(e) && e < s) {
      // Normalize inconsistent intervals by dropping end.
      return {
        type,
        itineraryItemId,
        activityId,
        timelineStartDate,
        timelineEndDate: null,
        reason,
      };
    }
  }

  return {
    type,
    itineraryItemId,
    activityId,
    timelineStartDate,
    timelineEndDate,
    reason,
  };
}

function sanitizeAiResult(result, aiInput = {}) {
  const raw = result && typeof result === 'object' ? result : {};
  const allowedActivityIds = new Set(
    (Array.isArray(aiInput?.activities) ? aiInput.activities : [])
      .map((a) => String(a?._id || '').trim())
      .filter(Boolean)
  );
  const allowedItineraryItemIds = new Set(
    (Array.isArray(aiInput?.itinerary?.items) ? aiInput.itinerary.items : [])
      .map((it) => String(it?._id || '').trim())
      .filter(Boolean)
  );
  const allowedActivityIdsFromItinerary = new Set(
    (Array.isArray(aiInput?.itinerary?.items) ? aiInput.itinerary.items : [])
      .map((it) => String(it?.activityId || '').trim())
      .filter(Boolean)
  );
  for (const itActId of allowedActivityIdsFromItinerary) {
    allowedActivityIds.add(itActId);
  }

  const rawActions = Array.isArray(raw.actions) ? raw.actions : [];
  const actions = rawActions
    .map((a) => sanitizeAiAction(a, { allowedActivityIds, allowedItineraryItemIds }))
    .filter(Boolean);

  return {
    trip_analysis: raw.trip_analysis && typeof raw.trip_analysis === 'object' ? raw.trip_analysis : null,
    highLevelSummary: typeof raw.highLevelSummary === 'string' ? raw.highLevelSummary : '',
    notes: typeof raw.notes === 'string' ? raw.notes : '',
    actions,
    validation: {
      actionsReceived: rawActions.length,
      actionsAccepted: actions.length,
      actionsRejected: Math.max(rawActions.length - actions.length, 0),
      allowedActivities: allowedActivityIds.size,
      allowedItineraryItems: allowedItineraryItemIds.size,
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
      userId: req?.user?._id ? String(req.user._id) : null,
    };
    console.log(`${AI_LOG_PREFIX} incoming`, reqSummary);

    const { modelInput, diagnostics } = buildAiInputForModel(aiInput);
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
    const sanitized = sanitizeAiResult(result, modelInput);
    const repaired = enforceAndRepairPlan(sanitized, modelInput);

    console.log(`${AI_LOG_PREFIX} outgoing`, {
      parsingError: repaired?.parsingError || null,
      actionsReceived: repaired?.validation?.actionsReceived ?? 0,
      actionsAccepted: repaired?.validation?.actionsAccepted ?? 0,
      actionsRejected: repaired?.validation?.actionsRejected ?? 0,
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
