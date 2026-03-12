const CompliancePack = require('../models/CompliancePack');
const mongoose = require('mongoose');

function normalizeUpper(value) {
  return String(value || '').trim().toUpperCase();
}

function parsePositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function parseFields(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((entry) => ({
      path: String(entry?.path || '').trim(),
      required: false,
      appliesTo: String(entry?.appliesTo || '').trim() === 'main_guest' ? 'main_guest' : 'all_guests',
    }))
    .filter((entry) => entry.path);
}

exports.list = async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const countryIso2 = normalizeUpper(req.query.countryIso2 || req.query.country);
    const code = normalizeUpper(req.query.code);
    const status = String(req.query.status || '').trim();
    const submissionMode = String(req.query.submissionMode || '').trim();
    const limit = Math.min(parsePositiveInt(req.query.limit, 100), 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const filter = {};
    if (countryIso2) filter.countryIso2 = countryIso2;
    if (code) filter.code = code;
    if (status) filter.status = status;
    if (submissionMode) filter.submissionMode = submissionMode;

    if (q) {
      filter.$or = [
        { code: { $regex: q, $options: 'i' } },
        { countryIso2: { $regex: q, $options: 'i' } },
      ];
    }

    const [results, total] = await Promise.all([
      CompliancePack.find(filter)
        .populate('countryZoneId', 'name externalId')
        .sort({ countryIso2: 1, code: 1, version: -1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      CompliancePack.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: { results, total, limit, offset },
    });
  } catch (err) {
    return next(err);
  }
};

exports.getById = async (req, res, next) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ success: false, message: 'Invalid id' });

    const doc = await CompliancePack.findById(id)
      .populate('countryZoneId', 'name externalId')
      .lean();
    if (!doc) return res.status(404).json({ success: false, message: 'Compliance pack not found' });

    return res.json({ success: true, data: doc });
  } catch (err) {
    return next(err);
  }
};

exports.create = async (req, res, next) => {
  try {
    const code = normalizeUpper(req.body?.code);
    const countryIso2 = normalizeUpper(req.body?.countryIso2 || req.body?.country);
    const version = parsePositiveInt(req.body?.version, 0);
    const countryZoneId = String(req.body?.countryZoneId || '').trim();

    if (!code) return res.status(400).json({ success: false, message: 'code is required' });
    if (!countryIso2) return res.status(400).json({ success: false, message: 'countryIso2 is required' });
    if (!version) return res.status(400).json({ success: false, message: 'version must be >= 1' });
    if (!mongoose.Types.ObjectId.isValid(countryZoneId)) {
      return res.status(400).json({ success: false, message: 'countryZoneId is required and must be a valid ObjectId' });
    }

    const payload = {
      code,
      countryIso2,
      countryZoneId,
      version,
      submissionMode: String(req.body?.submissionMode || 'manual').trim() || 'manual',
      fields: parseFields(req.body?.fields),
      mapping: req.body?.mapping && typeof req.body.mapping === 'object' ? req.body.mapping : {},
      status: String(req.body?.status || 'draft').trim() || 'draft',
    };

    const doc = await CompliancePack.create(payload);
    const populated = await CompliancePack.findById(doc._id)
      .populate('countryZoneId', 'name externalId')
      .lean();
    return res.status(201).json({ success: true, data: populated || doc });
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ success: false, message: 'A compliance pack with that country/code/version already exists' });
    }
    return next(err);
  }
};

exports.updateById = async (req, res, next) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ success: false, message: 'Invalid id' });

    const payload = {};
    if (req.body?.submissionMode !== undefined) payload.submissionMode = String(req.body.submissionMode || '').trim();
    if (req.body?.status !== undefined) payload.status = String(req.body.status || '').trim();
    if (req.body?.fields !== undefined) payload.fields = parseFields(req.body.fields);
    if (req.body?.mapping !== undefined) {
      payload.mapping = req.body.mapping && typeof req.body.mapping === 'object' ? req.body.mapping : {};
    }
    if (req.body?.code !== undefined) payload.code = normalizeUpper(req.body.code);
    if (req.body?.countryIso2 !== undefined || req.body?.country !== undefined) {
      payload.countryIso2 = normalizeUpper(req.body.countryIso2 || req.body.country);
    }
    if (req.body?.countryZoneId !== undefined) {
      const countryZoneId = String(req.body.countryZoneId || '').trim();
      if (!mongoose.Types.ObjectId.isValid(countryZoneId)) {
        return res.status(400).json({ success: false, message: 'countryZoneId must be a valid ObjectId' });
      }
      payload.countryZoneId = countryZoneId;
    }
    if (req.body?.version !== undefined) payload.version = parsePositiveInt(req.body.version, 0);

    const doc = await CompliancePack.findByIdAndUpdate(id, payload, { new: true, runValidators: true })
      .populate('countryZoneId', 'name externalId')
      .lean();
    if (!doc) return res.status(404).json({ success: false, message: 'Compliance pack not found' });

    return res.json({ success: true, data: doc });
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ success: false, message: 'A compliance pack with that country/code/version already exists' });
    }
    return next(err);
  }
};

exports.deleteById = async (req, res, next) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ success: false, message: 'Invalid id' });

    const deleted = await CompliancePack.findByIdAndDelete(id);
    if (!deleted) return res.status(404).json({ success: false, message: 'Compliance pack not found' });

    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
};
