function getAllowedAdminEmails() {
  const fromEnv = String(process.env.ADMIN_ALLOWED_EMAILS || '')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  if (fromEnv.length) return new Set(fromEnv);
  return new Set(['davidcha250@gmail.com']);
}

module.exports = function authAdmin(req, res, next) {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Forbidden: admin only' });
    }

    const allowedEmails = getAllowedAdminEmails();
    const email = String(req.user.email || '').trim().toLowerCase();
    if (!email || !allowedEmails.has(email)) {
      return res.status(403).json({ success: false, message: 'Forbidden: admin email only' });
    }

    next();
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error in admin authorization' });
  }
};
