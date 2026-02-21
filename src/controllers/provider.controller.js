// controllers/provider.controller.js
const Provider = require('../models/Provider');
const User = require('../models/User'); // opcional si quieres validar existencia del usuario

/** ===== Helpers ===== */
function toBool(v) {
  if (v === true || v === false) return v;
  if (v == null) return undefined;
  return String(v).toLowerCase() === 'true';
}

/** ===== List Providers ===== */
exports.list = async (req, res) => {
  try {
    const { page = 1, limit = 20, q, status, type } = req.query;

    const filter = {};
    if (status) filter.status = status;
    if (type) filter.type = type;
    if (q) filter.slug = { $regex: q, $options: 'i' };

    const cursor = Provider.find(filter)
      .sort({ createdAt: -1 })
      .skip((+page - 1) * +limit)
      .limit(+limit);

    const [items, total] = await Promise.all([
      cursor.lean(),
      Provider.countDocuments(filter)
    ]);

    res.json({ items, total, page: +page, pages: Math.ceil(total / +limit) });
  } catch (err) {
    console.error('provider.list error', err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
};

/** ===== Get Provider by id ===== */
exports.get = async (req, res) => {
  try {
    const doc = await Provider.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: 'NOT_FOUND' });
    res.json(doc);
  } catch (err) {
    console.error('provider.get error', err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
};

/** ===== Create Provider ===== */
exports.create = async (req, res) => {
  try {
    const { userId } = req.body;

    // opcional: validar que el userId exista
    // const userExists = await User.exists({ _id: userId });
    // if (!userExists) return res.status(400).json({ error: 'USER_NOT_FOUND' });

    // evitar duplicados
    const exists = await Provider.findOne({ userId });
    if (exists) return res.status(409).json({ error: 'PROVIDER_ALREADY_EXISTS' });

    const doc = await Provider.create(req.body);
    res.status(201).json(doc);
  } catch (err) {
    console.error('provider.create error', err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
};

/** ===== Update Provider ===== */
exports.update = async (req, res) => {
  try {
    const doc = await Provider.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!doc) return res.status(404).json({ error: 'NOT_FOUND' });
    res.json(doc);
  } catch (err) {
    console.error('provider.update error', err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
};

/** ===== Delete Provider ===== */
exports.remove = async (req, res) => {
  try {
    const ok = await Provider.findByIdAndDelete(req.params.id);
    if (!ok) return res.status(404).json({ error: 'NOT_FOUND' });
    res.json({ ok: true });
  } catch (err) {
    console.error('provider.remove error', err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
};

/** ===== Admin management (extra) ===== */
exports.addAdmin = async (req, res) => {
  try {
    const { email, role } = req.body;
    const doc = await Provider.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'NOT_FOUND' });

    doc.adminUsers.push({ email, role });
    await doc.save();
    res.json(doc);
  } catch (err) {
    console.error('provider.addAdmin error', err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
};