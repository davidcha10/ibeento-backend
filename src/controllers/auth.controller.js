const argon2 = require('argon2');
const User = require('../models/User');
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

exports.register = async (req, res, next) => {
  try {
    const { email, password, name, phone, nationality, document, onboardingCompleted } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'email and password are required' });

    const exists = await User.findOne({ email });
    if (exists) return res.status(409).json({ message: 'Email already registered' });

    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const user = await User.create({
      email,
      passwordHash,
      name,
      phone,
      nationality,
      document,
      onboardingCompleted: !!onboardingCompleted,
    });

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
    const { uid, email, name, photo, onboardingCompleted } = req.body;
    if (!uid || !email) return res.status(400).json({ message: 'uid and email are required' });

    let user = await User.findOne({ email });
    if (!user) {
      user = await User.create({
        email,
        name,
        photo,
        onboardingCompleted: !!onboardingCompleted,
        providers: [{ provider: 'google', providerId: uid }]
      });

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
      if (onboardingCompleted && !user.onboardingCompleted) {
        user.onboardingCompleted = true;
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
