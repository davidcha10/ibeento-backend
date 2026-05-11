const argon2 = require('argon2');
const User = require('../models/User');
const UserPreference = require('../models/UserPreference');
const Session = require('../models/Session');
const { signAccessToken, signRefreshToken, verifyRefresh, hashValue, verifyHash, REFRESH_TTL_DAYS } = require('../utils/tokens');
const { sendTemplatedEmail } = require('../services/email.service');

const isProd = process.env.NODE_ENV === 'production';
const cookieDomain = process.env.COOKIE_DOMAIN || 'localhost';

function setRefreshCookie(res, refreshToken) {
  res.cookie('refresh_token', refreshToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    domain: cookieDomain,
    path: '/api/auth',
    maxAge: REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000
  });
}

function safeString(value, maxLength = 240) {
  return String(value || '').trim().slice(0, maxLength);
}

function clampNumber(value, { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY, fallback = null } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizeOnboardingSelectionMode(value) {
  return safeString(value, 16).toLowerCase() === 'single' ? 'single' : 'multiple';
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeOnboardingOption(rawOption) {
  const id = safeString(rawOption?.id, 80);
  if (!id) return null;
  return {
    id,
    label: safeString(rawOption?.label, 160),
  };
}

function normalizeOnboardingStep(rawStep, fallbackIndex = 1) {
  const stepId = safeString(rawStep?.stepId, 80);
  if (!stepId) return null;

  const stepIndex = clampNumber(rawStep?.stepIndex, {
    min: 1,
    max: 200,
    fallback: fallbackIndex,
  });

  const options = [];
  const optionIds = new Set();
  if (Array.isArray(rawStep?.options)) {
    for (const rawOption of rawStep.options.slice(0, 24)) {
      const option = normalizeOnboardingOption(rawOption);
      if (!option || optionIds.has(option.id)) continue;
      optionIds.add(option.id);
      options.push(option);
    }
  }

  const selectedOptionIds = [];
  const selectedSeen = new Set();
  if (Array.isArray(rawStep?.selectedOptionIds)) {
    for (const rawOptionId of rawStep.selectedOptionIds.slice(0, 24)) {
      const optionId = safeString(rawOptionId, 80);
      if (!optionId || selectedSeen.has(optionId)) continue;
      if (optionIds.size > 0 && !optionIds.has(optionId)) continue;
      selectedSeen.add(optionId);
      selectedOptionIds.push(optionId);
    }
  }

  return {
    stepId,
    stepIndex,
    title: safeString(rawStep?.title, 180),
    selectionMode: normalizeOnboardingSelectionMode(rawStep?.selectionMode),
    options,
    selectedOptionIds,
  };
}

function sanitizeOnboardingPreferences(rawPreferences) {
  if (!rawPreferences || typeof rawPreferences !== 'object' || Array.isArray(rawPreferences)) return null;

  const sessionId = safeString(rawPreferences?.sessionId, 140);
  if (!sessionId) return null;

  const questionSteps = [];
  if (Array.isArray(rawPreferences?.questionSteps)) {
    for (let index = 0; index < Math.min(rawPreferences.questionSteps.length, 40); index += 1) {
      const step = normalizeOnboardingStep(rawPreferences.questionSteps[index], index + 1);
      if (!step) continue;
      questionSteps.push(step);
    }
  }

  const startHour = clampNumber(rawPreferences?.activityWindow?.startHour, {
    min: 0,
    max: 24,
    fallback: 9,
  });
  const endHour = clampNumber(rawPreferences?.activityWindow?.endHour, {
    min: 0,
    max: 24,
    fallback: 20,
  });
  const normalizedStartHour = Math.min(startHour, endHour);
  const normalizedEndHour = Math.max(startHour, endHour);
  const fallbackDuration = Math.round((normalizedEndHour - normalizedStartHour) * 2) / 2;

  const companionCandidate = safeString(rawPreferences?.travelCompanion, 40).toLowerCase();
  const validCompanion = ['solo', 'partner', 'friends', 'family'].includes(companionCandidate)
    ? companionCandidate
    : null;

  return {
    flowVersion: safeString(rawPreferences?.flowVersion, 24) || 'v1',
    sessionId,
    activeStepIndex: clampNumber(rawPreferences?.activeStepIndex, {
      min: 1,
      max: 200,
      fallback: 1,
    }),
    totalSteps: clampNumber(rawPreferences?.totalSteps, {
      min: 1,
      max: 200,
      fallback: Math.max(questionSteps.length, 1),
    }),
    completed: !!rawPreferences?.completed,
    paceValue: clampNumber(rawPreferences?.paceValue, {
      min: 1,
      max: 10,
      fallback: 5,
    }),
    activityWindow: {
      startHour: normalizedStartHour,
      endHour: normalizedEndHour,
      durationHours: clampNumber(rawPreferences?.activityWindow?.durationHours, {
        min: 0,
        max: 24,
        fallback: fallbackDuration,
      }),
    },
    travelCompanion: validCompanion,
    questionSteps,
    updatedAt: new Date(),
  };
}

function deriveTravelCompanionFromQuestionSteps(questionSteps) {
  if (!Array.isArray(questionSteps) || !questionSteps.length) return null;
  const travelCompanionStep = questionSteps.find((step) => String(step?.stepId || '').trim() === 'new-travel-companions');
  if (!travelCompanionStep) return null;
  const selected = Array.isArray(travelCompanionStep?.selectedOptionIds)
    ? travelCompanionStep.selectedOptionIds.map((value) => safeString(value, 80).toLowerCase()).filter(Boolean)
    : [];
  const map = {
    'companions-solo': 'solo',
    'companions-partner': 'partner',
    'companions-friends': 'friends',
    'companions-family': 'family',
  };
  for (const optionId of selected) {
    if (map[optionId]) return map[optionId];
  }
  return null;
}

/**
 * Deriva los campos de UserPreference a partir de los datos del onboarding.
 */
function deriveUserPreferenceFromOnboarding(onboardingPreferences) {
  if (!onboardingPreferences) return null;

  const VALID_ACTIVITY_TYPES = new Set(['culture', 'entertainment', 'food_drinks', 'nature', 'shopping', 'wellness']);
  const update = {};

  const paceValue = clampNumber(onboardingPreferences?.paceValue, { min: 1, max: 10, fallback: null });
  if (paceValue !== null) {
    update.pace = paceValue;
  }

  const rawStart = clampNumber(onboardingPreferences?.activityWindow?.startHour, { min: 0, max: 24, fallback: null });
  const rawEnd   = clampNumber(onboardingPreferences?.activityWindow?.endHour,   { min: 0, max: 24, fallback: null });
  const rawDur   = clampNumber(onboardingPreferences?.activityWindow?.durationHours, { min: 0, max: 24, fallback: null });

  if (rawStart !== null && rawEnd !== null) {
    const startHour    = Math.min(rawStart, rawEnd);
    const endHour      = Math.max(rawStart, rawEnd);
    const durationHours = rawDur !== null ? rawDur : (endHour - startHour);
    update.activityWindow = { startHour, endHour, durationHours };
  }

  const rawTypes = Array.isArray(onboardingPreferences?.favoriteActivityTypes)
    ? onboardingPreferences.favoriteActivityTypes.filter((t) => VALID_ACTIVITY_TYPES.has(String(t)))
    : [];
  if (rawTypes.length) {
    update.favoriteActivityTypes = rawTypes;
  }

  const companion = safeString(onboardingPreferences?.travelCompanion, 40).toLowerCase()
    || deriveTravelCompanionFromQuestionSteps(onboardingPreferences?.questionSteps);
  if (['solo', 'partner', 'friends', 'family'].includes(companion)) {
    update.travelCompanion = companion;
  }

  return Object.keys(update).length ? update : null;
}

/**
 * Upsert de UserPreference con los datos derivados del onboarding.
 * Se ejecuta siempre después de tener el userId definitivo.
 * Para usuarios existentes solo actualiza los campos de onboarding
 * (pace, activityWindow); no sobreescribe presupuesto ni tipos favoritos.
 */
async function upsertUserPreferenceFromOnboarding(userId, onboardingPreferences) {
  if (!userId || !onboardingPreferences) return;
  const prefUpdate = deriveUserPreferenceFromOnboarding(onboardingPreferences);
  if (!prefUpdate) return;
  try {
    await UserPreference.findOneAndUpdate(
      { userId },
      { $set: prefUpdate },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (err) {
    console.error('[auth] upsertUserPreferenceFromOnboarding error', err?.message || err);
  }
}

exports.register = async (req, res, next) => {
  try {
    const {
      email,
      password,
      name,
      phone,
      nationality,
      document,
      onboardingCompleted,
      onboardingPreferences: rawOnboardingPreferences,
    } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'email and password are required' });

    const exists = await User.findOne({ email });
    if (exists) return res.status(409).json({ message: 'Email already registered' });

    const onboardingPreferences = sanitizeOnboardingPreferences(rawOnboardingPreferences);
    const resolvedOnboardingCompleted = !!onboardingCompleted || !!onboardingPreferences?.completed;
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const userPayload = {
      email,
      passwordHash,
      name,
      phone,
      nationality,
      document,
      onboardingCompleted: resolvedOnboardingCompleted,
    };
    if (onboardingPreferences) {
      userPayload.onboarding = onboardingPreferences;
    }

    const user = await User.create(userPayload);

    // Persist onboarding data into UserPreference collection now that we have a userId
    if (onboardingPreferences) {
      await upsertUserPreferenceFromOnboarding(user._id, onboardingPreferences);
    }

    try {
      await sendTemplatedEmail({
        to: user.email,
        templateKey: 'welcome',
        data: { name: user.name },
      });
    } catch (emailErr) {
      console.error('[auth.register] welcome email failed', emailErr?.message || emailErr);
    }

    const { token: refreshToken } = signRefreshToken({ sub: user._id.toString() });
    const refreshTokenHash = await hashValue(refreshToken);
    const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 86400 * 1000);

    await Session.create({
      userId: user._id,
      refreshTokenHash,
      userAgent: req.get('user-agent') || '',
      ip: req.ip || '',
      expiresAt
    });

    setRefreshCookie(res, refreshToken);
    const accessToken = signAccessToken(user);
    res.status(201).json({
      accessToken,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        role: user.role,
        isPro: !!user.isPro,
        onboardingCompleted: user.onboardingCompleted,
      }
    });
  } catch (err) { next(err); }
};

exports.login = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ message: 'Invalid credentials' });

    const ok = await argon2.verify(user.passwordHash, password);
    if (!ok) return res.status(401).json({ message: 'Invalid credentials' });

    user.lastLoginAt = new Date();
    await user.save();

    const { token: refreshToken } = signRefreshToken({ sub: user._id.toString() });
    const refreshTokenHash = await hashValue(refreshToken);
    const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 86400 * 1000);

    await Session.create({
      userId: user._id, refreshTokenHash,
      userAgent: req.get('user-agent') || '', ip: req.ip || '', expiresAt
    });

    setRefreshCookie(res, refreshToken);
    const accessToken = signAccessToken(user);
    res.json({
      accessToken,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        role: user.role,
        isPro: !!user.isPro,
        onboardingCompleted: user.onboardingCompleted,
      }
    });
  } catch (err) { next(err); }
};

exports.refresh = async (req, res, next) => {
  try {
    const token = req.cookies?.refresh_token;
    if (!token) return res.status(401).json({ message: 'No refresh token' });

    const payload = verifyRefresh(token);
    const userId = payload.sub;

    const sessions = await Session.find({ userId, revokedAt: { $exists: false } }).sort({ createdAt: -1 }).limit(20);
    let matched = null;
    for (const s of sessions) {
      if (await verifyHash(s.refreshTokenHash, token)) { matched = s; break; }
    }
    if (!matched) return res.status(401).json({ message: 'Invalid refresh' });

    matched.revokedAt = new Date(); // rotación
    await matched.save();

    const user = await User.findById(userId);
    if (!user) return res.status(401).json({ message: 'User not found' });

    const { token: newRefresh } = signRefreshToken({ sub: user._id.toString() });
    const newHash = await hashValue(newRefresh);
    const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 86400 * 1000);

    await Session.create({
      userId: user._id, refreshTokenHash: newHash,
      userAgent: req.get('user-agent') || '', ip: req.ip || '', expiresAt
    });

    setRefreshCookie(res, newRefresh);
    const accessToken = signAccessToken(user);
    res.json({ accessToken });
  } catch (err) { next(err); }
};

exports.logout = async (req, res, next) => {
  try {
    const token = req.cookies?.refresh_token;
    if (token) {
      const sessions = await Session.find({ revokedAt: { $exists: false } });
      for (const s of sessions) {
        if (await verifyHash(s.refreshTokenHash, token)) {
          s.revokedAt = new Date();
          await s.save();
          break;
        }
      }
    }
    res.clearCookie('refresh_token', { path: '/api/auth', domain: process.env.COOKIE_DOMAIN || 'localhost' });
    res.json({ ok: true });
  } catch (err) { next(err); }
};

exports.me = async (req, res) => {
  res.json({ user: req.user });
};

exports.google = async (req, res, next) => {
  try {
    const { uid, email, name, photo, onboardingCompleted, onboardingPreferences: rawOnboardingPreferences } = req.body;
    if (!uid || !email) return res.status(400).json({ message: 'uid and email are required' });

    const onboardingPreferences = sanitizeOnboardingPreferences(rawOnboardingPreferences);
    const resolvedOnboardingCompleted = !!onboardingCompleted || !!onboardingPreferences?.completed;
    let user = await User.findOne({ email });
    if (!user) {
      const userPayload = {
        email,
        name,
        photo,
        onboardingCompleted: resolvedOnboardingCompleted,
        providers: [{ provider: 'google', providerId: uid }],
      };
      if (onboardingPreferences) {
        userPayload.onboarding = onboardingPreferences;
      }

      user = await User.create(userPayload);

      // Persist onboarding data into UserPreference collection now that we have a userId
      if (onboardingPreferences) {
        await upsertUserPreferenceFromOnboarding(user._id, onboardingPreferences);
      }

      try {
        await sendTemplatedEmail({
          to: user.email,
          templateKey: 'welcome',
          data: { name: user.name },
        });
      } catch (emailErr) {
        console.error('[auth.google] welcome email failed', emailErr?.message || emailErr);
      }
    } else {
      user.lastLoginAt = new Date();
      if (name) user.name = name;
      if (photo) user.photo = photo;
      if (resolvedOnboardingCompleted && !user.onboardingCompleted) {
        user.onboardingCompleted = true;
      }
      if (onboardingPreferences) {
        user.onboarding = onboardingPreferences;
        if (typeof user.markModified === 'function') user.markModified('onboarding');
        // Update only onboarding-derived fields in UserPreference (non-destructive)
        await upsertUserPreferenceFromOnboarding(user._id, onboardingPreferences);
      }

      const hasGoogle = user.providers?.some(p => p.provider === 'google' && p.providerId === uid);
      if (!hasGoogle) {
        user.providers.push({ provider: 'google', providerId: uid });
      }
      await user.save();
    }

    const { token: refreshToken } = signRefreshToken({ sub: user._id.toString() });
    const refreshTokenHash = await hashValue(refreshToken);
    const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 86400 * 1000);

    await Session.create({
      userId: user._id,
      refreshTokenHash,
      userAgent: req.get('user-agent') || '',
      ip: req.ip || '',
      expiresAt
    });

    setRefreshCookie(res, refreshToken);
    const accessToken = signAccessToken(user);
    res.json({
      accessToken,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        role: user.role,
        isPro: !!user.isPro,
        photo: user.photo,
        providers: user.providers,
        onboardingCompleted: user.onboardingCompleted,
      }
    });
  } catch (err) {
    next(err);
  }
};

exports.apple = async (req, res, next) => {
  try {
    const { uid, email, name, photo, onboardingCompleted, onboardingPreferences: rawOnboardingPreferences } = req.body;
    if (!uid) return res.status(400).json({ message: 'uid is required' });

    const onboardingPreferences = sanitizeOnboardingPreferences(rawOnboardingPreferences);
    const resolvedOnboardingCompleted = !!onboardingCompleted || !!onboardingPreferences?.completed;
    let user = await User.findOne({
      providers: { $elemMatch: { provider: 'apple', providerId: uid } }
    });
    if (!user && email) {
      user = await User.findOne({ email });
    }
    if (!user) {
      if (!email) {
        return res.status(400).json({ message: 'email is required the first time you sign in with Apple' });
      }
      const userPayload = {
        email,
        name,
        photo,
        onboardingCompleted: resolvedOnboardingCompleted,
        providers: [{ provider: 'apple', providerId: uid }]
      };
      if (onboardingPreferences) {
        userPayload.onboarding = onboardingPreferences;
      }

      user = await User.create(userPayload);

      // Persist onboarding data into UserPreference collection now that we have a userId
      if (onboardingPreferences) {
        await upsertUserPreferenceFromOnboarding(user._id, onboardingPreferences);
      }

      try {
        await sendTemplatedEmail({
          to: user.email,
          templateKey: 'welcome',
          data: { name: user.name },
        });
      } catch (emailErr) {
        console.error('[auth.apple] welcome email failed', emailErr?.message || emailErr);
      }
    } else {
      user.lastLoginAt = new Date();
      if (name) user.name = name;
      if (photo) user.photo = photo;
      if (resolvedOnboardingCompleted && !user.onboardingCompleted) {
        user.onboardingCompleted = true;
      }
      if (onboardingPreferences) {
        user.onboarding = onboardingPreferences;
        if (typeof user.markModified === 'function') user.markModified('onboarding');
        await upsertUserPreferenceFromOnboarding(user._id, onboardingPreferences);
      }

      const hasApple = user.providers?.some(p => p.provider === 'apple' && p.providerId === uid);
      if (!hasApple) {
        user.providers.push({ provider: 'apple', providerId: uid });
      }
      await user.save();
    }

    const { token: refreshToken } = signRefreshToken({ sub: user._id.toString() });
    const refreshTokenHash = await hashValue(refreshToken);
    const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 86400 * 1000);

    await Session.create({
      userId: user._id,
      refreshTokenHash,
      userAgent: req.get('user-agent') || '',
      ip: req.ip || '',
      expiresAt
    });

    setRefreshCookie(res, refreshToken);
    const accessToken = signAccessToken(user);
    res.json({
      accessToken,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        role: user.role,
        isPro: !!user.isPro,
        photo: user.photo,
        providers: user.providers,
        onboardingCompleted: user.onboardingCompleted,
      }
    });
  } catch (err) {
    next(err);
  }
};
