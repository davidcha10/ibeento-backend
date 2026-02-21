const FORBIDDEN_FIELDS = new Set([
  'role',
  'status',
  'ispro',
  'pro',
  'subscription',
  'subscriptions',
  'billing',
  'plan',
  'permissions',
  'passwordhash',
  'authversion',
]);

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function collectUnsafePath(value, path = '') {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const unsafe = collectUnsafePath(value[i], `${path}[${i}]`);
      if (unsafe) return unsafe;
    }
    return null;
  }

  if (!isPlainObject(value)) return null;

  for (const [key, child] of Object.entries(value)) {
    const nextPath = path ? `${path}.${key}` : key;
    const keyNormalized = String(key || '').trim().toLowerCase();

    // Block MongoDB operators and dotted keys in user payloads.
    if (keyNormalized.startsWith('$') || key.includes('.')) {
      return nextPath;
    }

    if (FORBIDDEN_FIELDS.has(keyNormalized)) {
      return nextPath;
    }

    const unsafe = collectUnsafePath(child, nextPath);
    if (unsafe) return unsafe;
  }

  return null;
}

module.exports = function rejectSensitiveBodyFields(req, res, next) {
  const body = req.body;
  if (!body || typeof body !== 'object') return next();

  const unsafePath = collectUnsafePath(body);
  if (!unsafePath) return next();

  return res.status(400).json({
    success: false,
    message: `Forbidden field in request body: ${unsafePath}`,
  });
};
