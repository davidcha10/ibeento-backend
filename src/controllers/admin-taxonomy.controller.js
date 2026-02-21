const ZoneTypeTaxonomy = require('../models/ZoneTypeTaxonomy');
const Zone = require('../models/Zone');
const { invalidateTaxonomyCache } = require('../services/zones/zone-type-taxonomy.service');

const ALLOWED_CANONICAL_TYPES = new Set([
  'country',
  'region',
  'emirate',
  'city',
  'town',
  'village',
  'commune',
  'neighborhood',
  'locality',
  'district',
  'subdistrict',
]);

function normalizeQid(value) {
  const raw = String(value || '').trim().toUpperCase();
  return /^Q\d+$/.test(raw) ? raw : null;
}

function sanitizeLabels(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out = {};
  for (const [locale, label] of Object.entries(input)) {
    const key = String(locale || '').trim();
    const value = String(label || '').trim();
    if (!key || !value) continue;
    out[key] = value;
  }
  return out;
}

function sanitizeWikidataName(value) {
  const raw = String(value || '').trim();
  return raw || null;
}

function sanitizeCountryOverrides(input) {
  if (!Array.isArray(input)) return [];

  const rows = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const countryIso2Raw = String(item.countryIso2 || '').trim().toUpperCase();
    const countryIso2 = countryIso2Raw.length === 2 ? countryIso2Raw : null;
    const countryQid = normalizeQid(item.countryQid);
    const labels = sanitizeLabels(item.labels);

    if (!countryIso2 && !countryQid && Object.keys(labels).length === 0) continue;
    rows.push({ countryIso2, countryQid, labels });
  }

  return rows;
}

function parseBoolean(value) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return undefined;
}

function parsePriority(value) {
  if (value === null || value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

async function attachUsageCounts(docs = []) {
  if (!Array.isArray(docs) || !docs.length) return docs;

  const taxonomyIds = docs
    .map((d) => d?._id)
    .filter(Boolean);

  const qids = docs
    .map((d) => normalizeQid(d?.qid))
    .filter(Boolean);

  const [countsByTaxonomyId, countsByQid] = await Promise.all([
    taxonomyIds.length
      ? Zone.aggregate([
          {
            $match: {
              $or: [
                { "taxonomySnapshot.taxonomyId": { $in: taxonomyIds } },
                { "taxonomySnapshot.zoneTypeTaxonomyId": { $in: taxonomyIds } },
                { zoneTypeTaxonomyId: { $in: taxonomyIds } },
              ],
            },
          },
          {
            $project: {
              taxonomyRef: {
                $ifNull: [
                  "$taxonomySnapshot.taxonomyId",
                  { $ifNull: ["$taxonomySnapshot.zoneTypeTaxonomyId", "$zoneTypeTaxonomyId"] },
                ],
              },
            },
          },
          { $group: { _id: '$taxonomyRef', count: { $sum: 1 } } },
        ])
      : Promise.resolve([]),
    qids.length
      ? Zone.aggregate([
          {
            $match: {
              $or: [
                {
                  $and: [
                    {
                      $or: [
                        { "taxonomySnapshot.zoneTypeTaxonomyId": null },
                        { "taxonomySnapshot.zoneTypeTaxonomyId": { $exists: false } },
                        { "taxonomySnapshot.taxonomyId": null },
                        { "taxonomySnapshot.taxonomyId": { $exists: false } },
                      ],
                    },
                    {
                      $or: [{ zoneTypeTaxonomyId: null }, { zoneTypeTaxonomyId: { $exists: false } }],
                    },
                    {
                      $or: [
                        { "taxonomySnapshot.typeQid": { $in: qids } },
                        { "taxonomySnapshot.qid": { $in: qids } },
                        { typeQid: { $in: qids } },
                      ],
                    },
                  ],
                },
              ],
            },
          },
          {
            $project: {
              qidRef: {
                $ifNull: ["$taxonomySnapshot.qid", { $ifNull: ["$taxonomySnapshot.typeQid", "$typeQid"] }],
              },
            },
          },
          { $group: { _id: '$qidRef', count: { $sum: 1 } } },
        ])
      : Promise.resolve([]),
  ]);

  const byTaxonomyId = new Map(
    countsByTaxonomyId.map((row) => [String(row._id), Number(row.count || 0)])
  );
  const byQid = new Map(
    countsByQid.map((row) => [String(row._id || '').toUpperCase(), Number(row.count || 0)])
  );

  return docs.map((doc) => {
    const qid = normalizeQid(doc?.qid);
    const usageCount =
      Number(byTaxonomyId.get(String(doc?._id)) || 0) +
      Number(byQid.get(String(qid || '')) || 0);
    return { ...doc, usageCount };
  });
}

exports.list = async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const canonicalType = String(req.query.canonicalType || '').trim().toLowerCase();
    const typeCode = String(req.query.typeCode || '').trim();
    const active = parseBoolean(req.query.active);
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    const offset = Number(req.query.offset) || 0;

    const filter = {};
    if (canonicalType) filter.canonicalType = canonicalType;
    if (typeCode) filter.typeCode = typeCode;
    if (typeof active === 'boolean') filter.active = active;

    if (q) {
      const qid = normalizeQid(q);
      if (qid) {
        filter.$or = [{ qid }, { typeCode: { $regex: q, $options: 'i' } }];
      } else {
        filter.$or = [
          { qid: { $regex: q, $options: 'i' } },
          { typeCode: { $regex: q, $options: 'i' } },
          { wikidataName: { $regex: q, $options: 'i' } },
          { 'labels.en': { $regex: q, $options: 'i' } },
          { 'labels.es': { $regex: q, $options: 'i' } },
          { 'labels.fr': { $regex: q, $options: 'i' } },
        ];
      }
    }

    const [results, total] = await Promise.all([
      ZoneTypeTaxonomy.find(filter)
        .sort({ priority: 1, canonicalType: 1, typeCode: 1, qid: 1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      ZoneTypeTaxonomy.countDocuments(filter),
    ]);

    const resultsWithUsage = await attachUsageCounts(results);

    return res.json({
      success: true,
      data: { results: resultsWithUsage, total, limit, offset },
    });
  } catch (err) {
    return next(err);
  }
};

exports.getByQid = async (req, res, next) => {
  try {
    const qid = normalizeQid(req.params.qid);
    if (!qid) return res.status(400).json({ success: false, message: 'Invalid qid' });

    const doc = await ZoneTypeTaxonomy.findOne({ qid }).lean();
    if (!doc) return res.status(404).json({ success: false, message: 'Taxonomy row not found' });
    const [withUsage] = await attachUsageCounts([doc]);
    return res.json({ success: true, data: withUsage });
  } catch (err) {
    return next(err);
  }
};

exports.createOrUpsert = async (req, res, next) => {
  try {
    const qid = normalizeQid(req.body?.qid);
    const canonicalType = String(req.body?.canonicalType || '').trim().toLowerCase();
    const typeCode = String(req.body?.typeCode || '').trim();

    if (!qid) return res.status(400).json({ success: false, message: 'qid is required' });
    if (!ALLOWED_CANONICAL_TYPES.has(canonicalType)) {
      return res.status(400).json({ success: false, message: 'Invalid canonicalType' });
    }
    if (!typeCode) return res.status(400).json({ success: false, message: 'typeCode is required' });

    const payload = {
      qid,
      canonicalType,
      typeCode,
      wikidataName: sanitizeWikidataName(req.body?.wikidataName),
      labels: sanitizeLabels(req.body?.labels),
      countryOverrides: sanitizeCountryOverrides(req.body?.countryOverrides),
    };

    const active = parseBoolean(req.body?.active);
    if (typeof active === 'boolean') payload.active = active;

    const priority = parsePriority(req.body?.priority);
    if (priority !== undefined) payload.priority = priority;

    await ZoneTypeTaxonomy.updateOne({ qid }, { $set: payload }, { upsert: true });
    invalidateTaxonomyCache();

    const doc = await ZoneTypeTaxonomy.findOne({ qid }).lean();
    return res.status(201).json({ success: true, data: doc });
  } catch (err) {
    return next(err);
  }
};

exports.updateByQid = async (req, res, next) => {
  try {
    const qid = normalizeQid(req.params.qid);
    if (!qid) return res.status(400).json({ success: false, message: 'Invalid qid' });

    const doc = await ZoneTypeTaxonomy.findOne({ qid });
    if (!doc) return res.status(404).json({ success: false, message: 'Taxonomy row not found' });

    if (req.body?.canonicalType !== undefined) {
      const canonicalType = String(req.body.canonicalType || '').trim().toLowerCase();
      if (!ALLOWED_CANONICAL_TYPES.has(canonicalType)) {
        return res.status(400).json({ success: false, message: 'Invalid canonicalType' });
      }
      doc.canonicalType = canonicalType;
    }

    if (req.body?.typeCode !== undefined) {
      const typeCode = String(req.body.typeCode || '').trim();
      if (!typeCode) return res.status(400).json({ success: false, message: 'typeCode cannot be empty' });
      doc.typeCode = typeCode;
    }

    if (req.body?.wikidataName !== undefined) {
      doc.wikidataName = sanitizeWikidataName(req.body.wikidataName);
    }

    if (req.body?.labels !== undefined) {
      doc.labels = sanitizeLabels(req.body.labels);
    }

    if (req.body?.countryOverrides !== undefined) {
      doc.countryOverrides = sanitizeCountryOverrides(req.body.countryOverrides);
    }

    const active = parseBoolean(req.body?.active);
    if (typeof active === 'boolean') doc.active = active;

    const priority = parsePriority(req.body?.priority);
    if (priority !== undefined) doc.priority = priority;

    await doc.save();
    invalidateTaxonomyCache();

    return res.json({ success: true, data: doc.toObject() });
  } catch (err) {
    return next(err);
  }
};

exports.deleteByQid = async (req, res, next) => {
  try {
    const qid = normalizeQid(req.params.qid);
    if (!qid) return res.status(400).json({ success: false, message: 'Invalid qid' });

    const deleted = await ZoneTypeTaxonomy.findOneAndDelete({ qid }).lean();
    if (!deleted) return res.status(404).json({ success: false, message: 'Taxonomy row not found' });

    invalidateTaxonomyCache();
    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
};
