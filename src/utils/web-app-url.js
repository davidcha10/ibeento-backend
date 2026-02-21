function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function getWebAppBaseUrl() {
  const explicit = normalizeBaseUrl(process.env.WEB_APP_URL);
  if (explicit) return explicit;

  const env = String(process.env.NODE_ENV || 'development').toLowerCase();
  if (env === 'production') {
    const prod = normalizeBaseUrl(process.env.WEB_APP_URL_PROD);
    return prod || 'https://www.ibeento.com';
  }

  const dev = normalizeBaseUrl(process.env.WEB_APP_URL_DEV);
  return dev || 'http://localhost:4200';
}

function buildWebAppUrl(pathname = '/') {
  const base = getWebAppBaseUrl();
  const path = String(pathname || '/').trim();
  if (!path) return base;
  return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
}

module.exports = {
  getWebAppBaseUrl,
  buildWebAppUrl,
};
