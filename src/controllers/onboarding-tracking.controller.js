const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const OnboardingResponse = require('../models/OnboardingResponse');

function parseDays(raw, fallback = 30) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(Math.round(n), 1), 365);
}

function rangeStart(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function safeString(value) {
  return String(value || '').trim();
}

function normalizePlatform(value) {
  const raw = safeString(value).toLowerCase();
  if (raw === 'web' || raw === 'ios' || raw === 'android') return raw;
  return 'unknown';
}

function normalizeSelectionMode(value) {
  const raw = safeString(value).toLowerCase();
  return raw === 'single' ? 'single' : 'multiple';
}

function normalizeStepIndex(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const normalized = Math.round(n);
  return normalized >= 1 ? normalized : null;
}

function normalizeOptions(rawOptions) {
  if (!Array.isArray(rawOptions)) return [];
  const dedup = new Map();
  for (const option of rawOptions) {
    const id = safeString(option?.id);
    if (!id) continue;
    const label = safeString(option?.label);
    dedup.set(id, { id, label });
  }
  return [...dedup.values()];
}

function normalizeSelectedOptionIds(rawIds, validOptionIds) {
  const allowed = new Set(validOptionIds);
  if (!Array.isArray(rawIds)) return [];
  const dedup = [];
  const seen = new Set();
  for (const raw of rawIds) {
    const id = safeString(raw);
    if (!id || seen.has(id)) continue;
    if (allowed.size > 0 && !allowed.has(id)) continue;
    seen.add(id);
    dedup.push(id);
  }
  return dedup;
}

function normalizeQuestionSteps(rawSteps) {
  if (!Array.isArray(rawSteps)) return [];
  const steps = [];
  const seenStepIds = new Set();

  for (const rawStep of rawSteps) {
    const stepId = safeString(rawStep?.stepId);
    const stepIndex = normalizeStepIndex(rawStep?.stepIndex);
    if (!stepId || !stepIndex || seenStepIds.has(stepId)) continue;
    seenStepIds.add(stepId);

    const options = normalizeOptions(rawStep?.options);
    const optionIds = options.map((option) => option.id);
    const selectedOptionIds = normalizeSelectedOptionIds(rawStep?.selectedOptionIds, optionIds);
    const labelsById = new Map(options.map((option) => [option.id, option.label]));
    const selectedOptionLabels = selectedOptionIds
      .map((id) => safeString(labelsById.get(id)))
      .filter(Boolean);

    steps.push({
      stepId,
      stepIndex,
      title: safeString(rawStep?.title),
      selectionMode: normalizeSelectionMode(rawStep?.selectionMode),
      options,
      selectedOptionIds,
      selectedOptionLabels,
      answered: selectedOptionIds.length > 0,
    });
  }

  return steps.sort((a, b) => a.stepIndex - b.stepIndex);
}

function resolveOptionalUserId(req) {
  try {
    const authHeader = req.get('authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return null;
    const payload = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    const sub = safeString(payload?.sub);
    if (!sub || !mongoose.Types.ObjectId.isValid(sub)) return null;
    return new mongoose.Types.ObjectId(sub);
  } catch {
    return null;
  }
}

function participantKey(doc) {
  if (doc?.userId) return `u:${String(doc.userId)}`;
  const sessionId = safeString(doc?.sessionId);
  if (sessionId) return `s:${sessionId}`;
  return null;
}

exports.upsertProgress = async (req, res, next) => {
  try {
    const sessionId = safeString(req.body?.sessionId);
    if (!sessionId) {
      return res.status(400).json({
        success: false,
        message: 'sessionId is required',
      });
    }

    const flowVersion = safeString(req.body?.flowVersion) || 'v1';
    const platform = normalizePlatform(req.body?.platform || 'web');
    const activeStepIndex = normalizeStepIndex(req.body?.activeStepIndex) || 1;
    const totalSteps = normalizeStepIndex(req.body?.totalSteps);
    const completed = !!req.body?.completed;
    const now = new Date();
    const incomingSteps = normalizeQuestionSteps(req.body?.questionSteps);
    const userId = resolveOptionalUserId(req);

    const filter = { sessionId, flowVersion };
    const existing = await OnboardingResponse.findOne(filter).lean();
    const existingMaxStepIndex = normalizeStepIndex(existing?.maxStepIndex) || 1;
    const nextMaxStepIndex = Math.max(existingMaxStepIndex, activeStepIndex);
    const prevStepsById = new Map(
      (Array.isArray(existing?.questionSteps) ? existing.questionSteps : [])
        .map((step) => [safeString(step?.stepId), step])
        .filter(([stepId]) => !!stepId)
    );

    const mergedSteps = incomingSteps.map((step) => {
      const prev = prevStepsById.get(step.stepId) || null;
      const reached = step.stepIndex <= nextMaxStepIndex || !!prev?.reached;
      const answered = step.selectedOptionIds.length > 0;

      return {
        stepId: step.stepId,
        stepIndex: step.stepIndex,
        title: step.title,
        selectionMode: step.selectionMode,
        options: step.options,
        selectedOptionIds: step.selectedOptionIds,
        selectedOptionLabels: step.selectedOptionLabels,
        reached,
        reachedAt: prev?.reachedAt || (reached ? now : null),
        answered,
        answeredAt: answered ? (prev?.answeredAt || now) : null,
      };
    });

    const update = {
      sessionId,
      flowVersion,
      platform,
      lastSeenAt: now,
      maxStepIndex: nextMaxStepIndex,
      totalSteps: totalSteps || existing?.totalSteps || null,
    };

    if (userId) {
      update.userId = userId;
    }
    if (completed) {
      update.completedAt = existing?.completedAt || now;
    }
    if (incomingSteps.length > 0) {
      update.questionSteps = mergedSteps;
    }

    const saved = await OnboardingResponse.findOneAndUpdate(
      filter,
      {
        $set: update,
        $setOnInsert: { startedAt: now },
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      }
    ).lean();

    return res.status(200).json({
      success: true,
      data: {
        sessionId: saved?.sessionId || sessionId,
        flowVersion: saved?.flowVersion || flowVersion,
        maxStepIndex: saved?.maxStepIndex || nextMaxStepIndex,
        completedAt: saved?.completedAt || null,
        questionSteps: Array.isArray(saved?.questionSteps) ? saved.questionSteps.length : 0,
      },
    });
  } catch (err) {
    return next(err);
  }
};

exports.getAdminFunnel = async (req, res, next) => {
  try {
    const days = parseDays(req.query.days, 30);
    const from = rangeStart(days);

    const docs = await OnboardingResponse.find(
      { startedAt: { $gte: from } },
      {
        userId: 1,
        sessionId: 1,
        maxStepIndex: 1,
        totalSteps: 1,
        questionSteps: 1,
        lastSeenAt: 1,
        updatedAt: 1,
      }
    ).lean();

    const latestByParticipant = new Map();
    for (const doc of docs) {
      const key = participantKey(doc);
      if (!key) continue;
      const currentTs = new Date(doc?.lastSeenAt || doc?.updatedAt || 0).getTime();
      const prev = latestByParticipant.get(key);
      const prevTs = prev ? new Date(prev?.lastSeenAt || prev?.updatedAt || 0).getTime() : -1;
      if (!prev || currentTs >= prevTs) {
        latestByParticipant.set(key, doc);
      }
    }

    const participants = [...latestByParticipant.values()];
    const participantsCount = participants.length;

    const stepDefs = new Map();
    for (const doc of participants) {
      const steps = Array.isArray(doc?.questionSteps) ? doc.questionSteps : [];
      for (const step of steps) {
        const stepId = safeString(step?.stepId);
        const stepIndex = normalizeStepIndex(step?.stepIndex);
        if (!stepId || !stepIndex) continue;

        let def = stepDefs.get(stepId);
        if (!def) {
          def = {
            stepId,
            stepIndex,
            title: safeString(step?.title),
            selectionMode: normalizeSelectionMode(step?.selectionMode),
            optionsById: new Map(),
          };
          stepDefs.set(stepId, def);
        }

        const title = safeString(step?.title);
        if (title && !def.title) def.title = title;

        for (const option of Array.isArray(step?.options) ? step.options : []) {
          const optionId = safeString(option?.id);
          if (!optionId) continue;
          const optionLabel = safeString(option?.label);
          if (!def.optionsById.has(optionId)) {
            def.optionsById.set(optionId, optionLabel || optionId);
          }
        }

        for (const optionIdRaw of Array.isArray(step?.selectedOptionIds) ? step.selectedOptionIds : []) {
          const optionId = safeString(optionIdRaw);
          if (!optionId || def.optionsById.has(optionId)) continue;
          const label = safeString(
            (Array.isArray(step?.selectedOptionLabels) ? step.selectedOptionLabels : [])
              .find((v) => safeString(v))
          ) || optionId;
          def.optionsById.set(optionId, label);
        }
      }
    }

    const orderedStepDefs = [...stepDefs.values()].sort((a, b) => a.stepIndex - b.stepIndex);

    const steps = orderedStepDefs.map((def) => {
      const optionCounts = new Map([...def.optionsById.keys()].map((id) => [id, 0]));
      let reachedCount = 0;
      let answeredCount = 0;

      for (const doc of participants) {
        const maxStepIndex = normalizeStepIndex(doc?.maxStepIndex) || 1;
        const docSteps = Array.isArray(doc?.questionSteps) ? doc.questionSteps : [];
        const docStep = docSteps.find((step) => safeString(step?.stepId) === def.stepId) || null;

        const reached = !!docStep?.reached || maxStepIndex >= def.stepIndex;
        if (reached) reachedCount += 1;

        const selectedOptionIds = normalizeSelectedOptionIds(
          docStep?.selectedOptionIds,
          [...def.optionsById.keys()]
        );
        const answered = selectedOptionIds.length > 0 || !!docStep?.answered;
        if (answered) answeredCount += 1;

        for (const optionId of selectedOptionIds) {
          optionCounts.set(optionId, Number(optionCounts.get(optionId) || 0) + 1);
        }
      }

      const options = [...def.optionsById.entries()].map(([id, label]) => {
        const count = Number(optionCounts.get(id) || 0);
        return {
          id,
          label,
          count,
          rateFromAnswered: answeredCount > 0 ? count / answeredCount : 0,
          rateFromStart: participantsCount > 0 ? count / participantsCount : 0,
        };
      }).sort((a, b) => b.count - a.count);

      return {
        stepId: def.stepId,
        stepIndex: def.stepIndex,
        title: def.title || def.stepId,
        selectionMode: def.selectionMode,
        reachedCount,
        reachedRateFromStart: participantsCount > 0 ? reachedCount / participantsCount : 0,
        answeredCount,
        answeredRateFromReached: reachedCount > 0 ? answeredCount / reachedCount : 0,
        answeredRateFromStart: participantsCount > 0 ? answeredCount / participantsCount : 0,
        options,
      };
    });

    return res.status(200).json({
      success: true,
      data: {
        windowDays: days,
        from,
        participants: participantsCount,
        steps,
      },
    });
  } catch (err) {
    return next(err);
  }
};
