// src/utils/tokens.js
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const argon2 = require('argon2');
const { CONFIG } = require('./env');

const {
  JWT_ACCESS_SECRET,
  JWT_REFRESH_SECRET,
  ACCESS_TOKEN_TTL_SEC,
  REFRESH_TOKEN_TTL_DAYS
} = CONFIG;

function signAccessToken(user) {
  return jwt.sign(
    { sub: user._id.toString(), role: user.role, av: user.authVersion || 0 },
    JWT_ACCESS_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL_SEC } // segundos
  );
}

function signRefreshToken(payload = {}) {
  const jti = crypto.randomUUID();
  return {
    token: jwt.sign({ ...payload, jti }, JWT_REFRESH_SECRET, { expiresIn: `${REFRESH_TOKEN_TTL_DAYS}d` }),
    jti
  };
}

function verifyAccess(token) {
  return jwt.verify(token, JWT_ACCESS_SECRET);
}

function verifyRefresh(token) {
  return jwt.verify(token, JWT_REFRESH_SECRET);
}

async function hashValue(value) {
  return argon2.hash(value, { type: argon2.argon2id });
}

async function verifyHash(hash, value) {
  return argon2.verify(hash, value);
}

module.exports = {
  signAccessToken,
  signRefreshToken,
  verifyAccess,
  verifyRefresh,
  hashValue,
  verifyHash,
  ACCESS_TTL: ACCESS_TOKEN_TTL_SEC,
  REFRESH_TTL_DAYS: CONFIG.REFRESH_TOKEN_TTL_DAYS
};
