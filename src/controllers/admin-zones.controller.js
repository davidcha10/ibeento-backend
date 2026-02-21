const Zone = require('../models/Zone');
const ZoneTypeTaxonomy = require('../models/ZoneTypeTaxonomy');
const {
  findTaxonomyByQid,
  resolveZoneDisplayTypeLabel,
} = require('../services/zones/zone-type-taxonomy.service');

function normalizeCanonicalType(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  const allowed = new Set([
    'country',
    'region',
    'province',
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
  if (allowed.has(raw)) return raw;
  return null;
}

function normalizeQid(value) {
  const raw = String(value || '').trim().toUpperCase();
  return /^Q\d+$/.test(raw) ? raw : null;
}

function getZoneType(zone) {
  return zone?.taxonomySnapshot?.canonicalType || zone?.taxonomySnapshot?.type || zone?.canonicalType || zone?.type || null;
}

function getZoneTypeCode(zone) {
  return zone?.taxonomySnapshot?.typeCode || zone?.typeCode || null;
}

function getZoneTypeQid(zone) {
  return zone?.taxonomySnapshot?.qid || zone?.taxonomySnapshot?.typeQid || zone?.qid || zone?.typeQid || null;
}

function getZoneTaxonomyId(zone) {
  return zone?.taxonomySnapshot?.taxonomyId || zone?.taxonomySnapshot?.zoneTypeTaxonomyId || zone?.taxonomyId || zone?.zoneTypeTaxonomyId || null;
}

function getZoneDisplayTypeLabel(zone) {
  return zone?.taxonomySnapshot?.displayTypeLabel || zone?.displayTypeLabel || null;
}

function getZoneWikidataName(zone) {
  return zone?.taxonomySnapshot?.wikidataName || zone?.wikidataName || null;
}

function getZoneNumberOfSteps(zone) {
  const value = zone?.taxonomySnapshot?.numberOfSteps ?? zone?.numberOfSteps;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

async function resolveTaxonomyDocForZone(zone) {
  if (!zone) return null;

  // Respect manual override first (edited taxonomyId in admin).
  if (getZoneTaxonomyId(zone)) {
    const byId = await ZoneTypeTaxonomy.findById(getZoneTaxonomyId(zone)).lean();
    if (byId && byId.active !== false) return byId;
  }

  const byQid = normalizeQid(getZoneTypeQid(zone));
  if (byQid) {
    const doc = await findTaxonomyByQid(byQid);
    if (doc && doc.active !== false) return doc;
  }

  const canonicalType = normalizeCanonicalType(getZoneType(zone));
  const typeCode = String(getZoneTypeCode(zone) || '').trim();
  if (typeCode) {
    const filter = { typeCode, active: true };
    if (canonicalType) filter.canonicalType = canonicalType;
    const byTypeCode = await ZoneTypeTaxonomy.findOne(filter).sort({ priority: 1, qid: 1 }).lean();
    if (byTypeCode) return byTypeCode;
  }

  return null;
}

exports.updateTaxonomySnapshotByZoneId = async (req, res, next) => {
  try {
    const { id } = req.params;
    const zone = await Zone.findById(id);
    if (!zone) return res.status(404).json({ success: false, message: 'Zone not found' });

    const taxonomyDoc = await resolveTaxonomyDocForZone(zone);
    if (!taxonomyDoc) {
      return res.status(404).json({
        success: false,
        message: 'No taxonomy mapping found for this zone',
      });
    }

    const canonicalType = normalizeCanonicalType(taxonomyDoc.canonicalType);
    if (!canonicalType) {
      return res.status(400).json({
        success: false,
        message: 'Taxonomy row has invalid canonicalType',
      });
    }

    let countryQid = null;
    if (getZoneType(zone) === 'country') {
      countryQid = normalizeQid(zone.externalId);
    } else if (zone.parentCountryId) {
      const countryZone = await Zone.findById(zone.parentCountryId).select('externalId').lean();
      countryQid = normalizeQid(countryZone?.externalId);
    }

    const displayTypeLabel = await resolveZoneDisplayTypeLabel({
      qid: taxonomyDoc.qid,
      typeCode: taxonomyDoc.typeCode || getZoneTypeCode(zone) || null,
      canonicalType,
      countryQid,
      locale: 'en',
    });

    const before = {
      canonicalType: getZoneType(zone),
      type: getZoneType(zone),
      typeCode: getZoneTypeCode(zone),
      qid: getZoneTypeQid(zone),
      typeQid: getZoneTypeQid(zone),
      taxonomyId: getZoneTaxonomyId(zone),
      zoneTypeTaxonomyId: getZoneTaxonomyId(zone),
      displayTypeLabel: getZoneDisplayTypeLabel(zone),
      wikidataName: getZoneWikidataName(zone),
      numberOfSteps: getZoneNumberOfSteps(zone),
      auditStatus: zone?.taxonomySnapshot?.auditStatus || "pending",
    };

    zone.taxonomySnapshot = zone.taxonomySnapshot || {};
    zone.taxonomySnapshot.canonicalType = canonicalType;
    zone.taxonomySnapshot.typeCode = taxonomyDoc.typeCode || getZoneTypeCode(zone) || null;
    zone.taxonomySnapshot.qid = taxonomyDoc.qid || getZoneTypeQid(zone) || null;
    zone.taxonomySnapshot.taxonomyId = taxonomyDoc._id;
    zone.taxonomySnapshot.displayTypeLabel = displayTypeLabel || null;
    zone.taxonomySnapshot.wikidataName = taxonomyDoc.wikidataName || getZoneWikidataName(zone) || null;
    zone.taxonomySnapshot.numberOfSteps = getZoneNumberOfSteps(zone);
    zone.taxonomySnapshot.auditStatus = zone?.taxonomySnapshot?.auditStatus || "pending";

    await zone.save();

    return res.json({
      success: true,
      data: {
        zone: {
          _id: zone._id,
          name: zone.name,
          taxonomySnapshot: zone.taxonomySnapshot,
          canonicalType: zone.taxonomySnapshot?.canonicalType || null,
          type: zone.taxonomySnapshot?.canonicalType || null,
          typeCode: zone.taxonomySnapshot?.typeCode || null,
          qid: zone.taxonomySnapshot?.qid || null,
          typeQid: zone.taxonomySnapshot?.qid || null,
          taxonomyId: zone.taxonomySnapshot?.taxonomyId || null,
          zoneTypeTaxonomyId: zone.taxonomySnapshot?.taxonomyId || null,
          displayTypeLabel: zone.taxonomySnapshot?.displayTypeLabel || null,
          wikidataName: zone.taxonomySnapshot?.wikidataName || null,
          numberOfSteps: Number.isFinite(Number(zone.taxonomySnapshot?.numberOfSteps))
            ? Number(zone.taxonomySnapshot.numberOfSteps)
            : null,
          auditStatus: zone?.taxonomySnapshot?.auditStatus || "pending",
        },
        before,
      },
    });
  } catch (err) {
    return next(err);
  }
};
