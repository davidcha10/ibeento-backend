const ServiceTag = require('../models/ServiceTag');



/**
 * Normalize a Google Place type into our service-tag slug.
 */
function normalizeGoogleType(type) {
  if (!type) return null;

  return String(type)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/_/g, ' ')        // convert underscores to spaces first
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')      // convert spaces to hyphens
    .replace(/-+/g, '-');      // collapse repeated hyphens
}

/**
 * Ensures a list of Google Place types has matching ServiceTag documents.
 * Returns an array of ServiceTag ObjectIds.
 */
async function resolveServiceTagsFromGoogleTypes(types = []) {
  const tagIds = [];

  for (const t of types) {
    const normalized = normalizeGoogleType(t);
    if (!normalized) continue;

    // Look for existing tag
    let tag = await ServiceTag.findOne({ slug: normalized }).lean();

    // Create if missing
    if (!tag) {
      tag = await ServiceTag.create({
        name: normalized.replace(/-/g, ' '), // readable
        slug: normalized,
        businessType: ['experience'], // default for now
        isActive: true
      });
    }

    tagIds.push(tag._id);
  }

  return tagIds;
}

module.exports = {
  resolveServiceTagsFromGoogleTypes,
  normalizeGoogleType
};
