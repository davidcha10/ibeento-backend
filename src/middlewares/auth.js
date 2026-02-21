const jwt = require('jsonwebtoken');
const User = require('../models/User');

module.exports = async function auth(req, res, next) {
  try {
    const authHeader = req.get('authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ message: 'Unauthorized' });

    const payload = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    const user = await User.findById(payload.sub).select('_id email name role isPro authVersion');
    // if (!user || (user.authVersion || 0) !== (payload.av || 0)) {
    if (!user) {
      return res.status(401).json({ message: 'Token outdated or user not found' });
    }
    req.user = { _id: user._id, email: user.email, name: user.name, role: user.role, isPro: !!user.isPro };
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
}
