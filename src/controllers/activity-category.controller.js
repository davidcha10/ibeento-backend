const ActivityCategory = require('../models/ActivityCategory');

function slugify(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeNameKey(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizePayload(input = {}) {
  const name = String(input.name || '').trim();
  const slug = slugify(input.slug || name);
  const nameKey = normalizeNameKey(name);
  const source = input.source ? String(input.source).trim().toLowerCase() : null;
  const externalId = input.externalId ? String(input.externalId).trim().toUpperCase() : null;
  return {
    ...input,
    name,
    slug,
    nameKey,
    source,
    externalId,
  };
}

function buildFilters(query) {
  const filters = {};
  if (query.isActive !== undefined) filters.isActive = String(query.isActive) === 'true';
  if (query.group) filters.group = query.group;
  if (query.q) {
    filters.$or = [
      { name: { $regex: query.q, $options: 'i' } },
      { slug: { $regex: query.q, $options: 'i' } },
    ];
  }
  return filters;
}

exports.create = async (req, res) => {
  try {
    const normalized = normalizePayload(req.body || {});
    const {
      name,
      slug,
      nameKey,
      source,
      externalId,
      names,
      slugs,
      icon,
      order,
      group,
      tagsTypes,
      isActive,
    } = normalized;

    if (!name || !slug) {
      return res.status(400).json({ success: false, message: 'name and slug are required.' });
    }

    const duplicateClauses = [{ slug }, { nameKey }];
    if (source && externalId) duplicateClauses.push({ source, externalId });
    const exists = await ActivityCategory.findOne({ $or: duplicateClauses }).select('slug name source externalId');
    if (exists) {
      return res.status(409).json({
        success: false,
        message: 'Category already exists by slug, name or externalId.',
        conflict: {
          slug: exists.slug,
          name: exists.name,
          source: exists.source || null,
          externalId: exists.externalId || null,
        },
      });
    }

    const payload = {
      name,
      slug,
      nameKey,
      source,
      externalId,
      names,
      slugs,
      icon,
      order,
      group,
      tagsTypes,
      isActive,
    };

    const item = await ActivityCategory.create(payload);
    return res.json({ success: true, data: item });
  } catch (err) {
    console.error('ActivityCategory.create error:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
};

exports.createMany = async (req, res) => {
  try {
    const items = Array.isArray(req.body) ? req.body : req.body.items;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'items[] array is required.' });
    }

    const normalizedItems = items
      .map((item) => normalizePayload(item))
      .filter((item) => item.name && item.slug && item.nameKey);

    if (!normalizedItems.length) {
      return res.status(400).json({
        success: false,
        message: 'No valid items. Each item needs name or slug.',
      });
    }

    const seen = new Set();
    const dedupedBatch = [];
    const duplicatedInBatch = [];
    for (const item of normalizedItems) {
      const keys = [`slug:${item.slug}`, `name:${item.nameKey}`];
      const alreadySeen = keys.some((k) => seen.has(k));
      if (alreadySeen) {
        duplicatedInBatch.push({ slug: item.slug, name: item.name });
        continue;
      }
      keys.forEach((k) => seen.add(k));
      dedupedBatch.push(item);
    }

    const slugs = dedupedBatch.map((i) => i.slug);
    const nameKeys = dedupedBatch.map((i) => i.nameKey);
    const sourceExternalPairs = dedupedBatch
      .filter((i) => i.source && i.externalId)
      .map((i) => ({ source: i.source, externalId: i.externalId }));

    const existingDocs = await ActivityCategory.find({
      $or: [
        { slug: { $in: slugs } },
        { nameKey: { $in: nameKeys } },
        ...sourceExternalPairs,
      ],
    }).select('slug name nameKey source externalId');
    const existingSlugSet = new Set(existingDocs.map((doc) => doc.slug));
    const existingNameKeySet = new Set(existingDocs.map((doc) => doc.nameKey));
    const existingExternalSet = new Set(
      existingDocs
        .filter((d) => d.source && d.externalId)
        .map((d) => `${d.source}:${d.externalId}`)
    );

    const toInsert = dedupedBatch.filter(
      (item) =>
        !existingSlugSet.has(item.slug) &&
        !existingNameKeySet.has(item.nameKey) &&
        !(item.source && item.externalId && existingExternalSet.has(`${item.source}:${item.externalId}`))
    );

    if (toInsert.length === 0) {
      const duplicated = existingDocs.map((d) => ({
        slug: d.slug,
        name: d.name,
        source: d.source || null,
        externalId: d.externalId || null,
      }));
      return res.status(409).json({
        success: false,
        message: 'All provided categories already exist by slug or name.',
        duplicated,
        duplicatedInBatch,
      });
    }

    const created = await ActivityCategory.insertMany(toInsert);

    const duplicated = existingDocs.map((d) => ({
      slug: d.slug,
      name: d.name,
      source: d.source || null,
      externalId: d.externalId || null,
    }));
    return res.json({
      success: true,
      data: created,
      duplicated,
      duplicatedInBatch,
    });
  } catch (err) {
    console.error('ActivityCategory.createMany error:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
};

exports.list = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '100', 10), 1), 200);
    const skip = (page - 1) * limit;

    const filters = buildFilters(req.query);

    const [items, total] = await Promise.all([
      ActivityCategory.find(filters).sort({ order: 1, name: 1 }).skip(skip).limit(limit),
      ActivityCategory.countDocuments(filters),
    ]);

    return res.json({
      success: true,
      data: items,
      pagination: { total, page, pages: Math.ceil(total / limit), limit },
    });
  } catch (err) {
    console.error('ActivityCategory.list error:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
};

exports.get = async (req, res) => {
  try {
    const item = await ActivityCategory.findById(req.params.id);
    if (!item) return res.status(404).json({ success: false, message: 'Not found.' });
    return res.json({ success: true, data: item });
  } catch (err) {
    console.error('ActivityCategory.get error:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
};

exports.update = async (req, res) => {
  try {
    const body = { ...req.body };
    const payload = { ...body };
    const hasName = Object.prototype.hasOwnProperty.call(body, 'name');
    const hasSlug = Object.prototype.hasOwnProperty.call(body, 'slug');
    const hasSource = Object.prototype.hasOwnProperty.call(body, 'source');
    const hasExternalId = Object.prototype.hasOwnProperty.call(body, 'externalId');
    if (hasName) payload.name = String(body.name || '').trim();
    if (hasSlug || hasName) payload.slug = slugify(body.slug || payload.name);
    if (hasName) payload.nameKey = normalizeNameKey(payload.name);
    if (hasSource) payload.source = body.source ? String(body.source).trim().toLowerCase() : null;
    if (hasExternalId) payload.externalId = body.externalId ? String(body.externalId).trim().toUpperCase() : null;

    const duplicateChecks = [];
    if (payload.slug) duplicateChecks.push({ slug: payload.slug });
    if (payload.nameKey) duplicateChecks.push({ nameKey: payload.nameKey });
    const sourceForCheck = hasSource ? payload.source : null;
    const externalIdForCheck = hasExternalId ? payload.externalId : null;
    if (sourceForCheck && externalIdForCheck) {
      duplicateChecks.push({ source: sourceForCheck, externalId: externalIdForCheck });
    }

    if (duplicateChecks.length) {
      const exists = await ActivityCategory.findOne({
        _id: { $ne: req.params.id },
        $or: duplicateChecks,
      }).select('slug name');
      if (exists) {
        return res.status(409).json({
          success: false,
          message: 'Another category already exists by slug or name.',
          conflict: { slug: exists.slug, name: exists.name },
        });
      }
    }

    const updated = await ActivityCategory.findByIdAndUpdate(req.params.id, payload, { new: true });
    if (!updated) return res.status(404).json({ success: false, message: 'Not found.' });
    return res.json({ success: true, data: updated });
  } catch (err) {
    console.error('ActivityCategory.update error:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
};

exports.deactivate = async (req, res) => {
  try {
    const updated = await ActivityCategory.findByIdAndUpdate(
      req.params.id,
      { isActive: false },
      { new: true }
    );
    if (!updated) return res.status(404).json({ success: false, message: 'Not found.' });
    return res.json({ success: true, data: updated });
  } catch (err) {
    console.error('ActivityCategory.deactivate error:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
};

exports.restore = async (req, res) => {
  try {
    const updated = await ActivityCategory.findByIdAndUpdate(
      req.params.id,
      { isActive: true },
      { new: true }
    );
    if (!updated) return res.status(404).json({ success: false, message: 'Not found.' });
    return res.json({ success: true, data: updated });
  } catch (err) {
    console.error('ActivityCategory.restore error:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
};

exports.remove = async (req, res) => {
  try {
    const deleted = await ActivityCategory.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ success: false, message: 'Not found.' });
    return res.json({ success: true, message: 'Deleted permanently.' });
  } catch (err) {
    console.error('ActivityCategory.remove error:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
};
