// src/utils/env.js
const dotenv = require('dotenv');
const path = require('path');

// Asegúrate de cargar .env si aún no se ha cargado
if (!process.env.__DOTENV_LOADED__) {
  dotenv.config({ path: path.resolve(__dirname, '../../.env') });
  process.env.__DOTENV_LOADED__ = '1';
}

function requireEnv(name, opts = {}) {
  const val = process.env[name];
  if (!val || val.trim() === '') {
    const msg = opts.message || `Missing required env var: ${name}`;
    throw new Error(msg);
  }
  return val;
}

function intEnv(name, defaultValue, opts = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw.trim() === '') {
    if (defaultValue === undefined) {
      throw new Error(opts.message || `Missing required integer env var: ${name}`);
    }
    return defaultValue;
  }
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) {
    throw new Error(opts.message || `Invalid integer for ${name}: "${raw}"`);
  }
  if (opts.min !== undefined && n < opts.min) {
    throw new Error(opts.message || `Env var ${name} must be >= ${opts.min}`);
  }
  return n;
}

const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';

const CONFIG = {
  NODE_ENV,
  IS_PROD,
  PORT: intEnv('PORT', 4000, { min: 1 }),
  COOKIE_DOMAIN: process.env.COOKIE_DOMAIN || 'localhost',

  // Mongo
  MONGODB_URI: requireEnv('MONGODB_URI'),

  // JWT
  JWT_ACCESS_SECRET: requireEnv('JWT_ACCESS_SECRET', {
    message: 'JWT_ACCESS_SECRET is missing (check .env)'
  }),
  JWT_REFRESH_SECRET: requireEnv('JWT_REFRESH_SECRET', {
    message: 'JWT_REFRESH_SECRET is missing (check .env)'
  }),
  ACCESS_TOKEN_TTL_SEC: intEnv('ACCESS_TOKEN_TTL_SEC', 86400, { min: 60 }),
  REFRESH_TOKEN_TTL_DAYS: intEnv('REFRESH_TOKEN_TTL_DAYS', 30, { min: 1 })
};

module.exports = {
  requireEnv,
  intEnv,
  CONFIG
};
