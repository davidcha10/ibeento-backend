const jwt = require('jsonwebtoken');
const User = require('../models/User');

module.exports = async function authOptional(req, _res, next) {
  try {
    const authHeader = req.get('authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return next();

    const payload = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    const user = await User.findById(payload.sub).select('_id email name role isPro');
    if (!user) return next();

    req.user = { _id: user._id, email: user.email, name: user.name, role: user.role, isPro: !!user.isPro };
    return next();
  } catch {
    return next();
  }
};
