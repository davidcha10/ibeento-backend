const BusinessUnit = require('../models/BusinessUnit');
const mongoose = require('mongoose');
const Zone = require('../models/Zone');
const CompliancePack = require('../models/CompliancePack');
const { Service } = require('../models/Service');
const { generateSireTxtForBusinessUnit } = require('../services/sire-daily-report.service');

function isAdmin(req) {
  return String(req?.user?.role || '').trim().toLowerCase() === 'admin';
}

function requesterId(req) {
  return String(req?.user?._id || req?.user?.id || '').trim();
}

function normalizeLocationData(input = {}) {
  if (!input || typeof input !== 'object') return input;
  const location = { ...input };

  let primaryZoneId = location.primaryZoneId;
  if (primaryZoneId && typeof primaryZoneId === 'object' && primaryZoneId._id) {
    primaryZoneId = primaryZoneId._id;
  }
  primaryZoneId = String(primaryZoneId || '').trim();

  const legacyZones = Array.isArray(location.zones) ? location.zones : [];
  if (!primaryZoneId && legacyZones.length) {
    const lastZone = legacyZones[legacyZones.length - 1] || {};
    primaryZoneId = String(lastZone.zoneId || '').trim();
  }

  if (primaryZoneId && mongoose.Types.ObjectId.isValid(primaryZoneId)) {
    location.primaryZoneId = primaryZoneId;
  } else {
    delete location.primaryZoneId;
  }

  delete location.primaryZoneType;

  // Enforce single-zone model moving forward.
  delete location.zones;
  delete location.cityId;
  delete location.regionId;
  delete location.countryId;

  return location;
}

function normalizeTeamRole(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['owner', 'admin', 'operator', 'viewer'].includes(normalized)) return normalized;
  return 'viewer';
}

function normalizeTeamStatus(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['invited', 'active', 'inactive'].includes(normalized)) return normalized;
  return 'invited';
}

function normalizeDateOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeTeamMembers(rawMembers) {
  if (!Array.isArray(rawMembers)) return [];

  const out = [];
  const seen = new Set();

  for (const raw of rawMembers) {
    if (!raw || typeof raw !== 'object') continue;

    const rawUserId = raw.userId && typeof raw.userId === 'object'
      ? (raw.userId._id || raw.userId.id || '')
      : raw.userId;
    const userId = mongoose.Types.ObjectId.isValid(String(rawUserId || '').trim())
      ? String(rawUserId).trim()
      : null;

    const email = String(raw.email || '').trim().toLowerCase();
    const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
    if (!userId && !validEmail) continue;

    const dedupeKey = userId ? `u:${userId}` : `e:${validEmail}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const status = normalizeTeamStatus(raw.status);
    const invitedAt = normalizeDateOrNull(raw.invitedAt) || new Date();
    const acceptedAt = status === 'active'
      ? (normalizeDateOrNull(raw.acceptedAt) || new Date())
      : normalizeDateOrNull(raw.acceptedAt);

    out.push({
      userId,
      email: validEmail || null,
      name: String(raw.name || '').trim() || null,
      role: normalizeTeamRole(raw.role),
      status,
      invitedAt,
      acceptedAt,
    });
  }

  return out;
}

async function resolveCountryZoneId(primaryZoneId) {
  const zoneId = String(primaryZoneId || '').trim();
  if (!mongoose.Types.ObjectId.isValid(zoneId)) return null;

  const primaryZone = await Zone.findById(zoneId)
    .select('_id name parentCountryId parentZoneId ancestry')
    .lean();
  if (!primaryZone) return null;

  if (primaryZone.parentCountryId) {
    return String(primaryZone.parentCountryId);
  }

  if (!primaryZone.parentZoneId) {
    return String(primaryZone._id);
  }

  const ancestry = Array.isArray(primaryZone.ancestry) ? primaryZone.ancestry.map(String).filter(Boolean) : [];
  if (ancestry.length) return ancestry[0];

  return String(primaryZone._id);
}

function normalizeAppliesTo(value, fallback = 'all_guests') {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'main_guest' || normalized === 'all_guests' || normalized === 'not_needed') return normalized;
  return fallback;
}

function defaultAppliesToForPath(path = '') {
  const key = String(path || '').trim();
  if (key.startsWith('invoiceInformation.')) return 'main_guest';
  if (key.startsWith('checkIn.')) return 'main_guest';
  return 'all_guests';
}

function maxAppliesTo(a, b) {
  const priority = { not_needed: 0, main_guest: 1, all_guests: 2 };
  const left = normalizeAppliesTo(a, 'main_guest');
  const right = normalizeAppliesTo(b, 'main_guest');
  return priority[left] >= priority[right] ? left : right;
}

function normalizeEnabledPackCodes(rawCodes = []) {
  if (!Array.isArray(rawCodes)) return [];
  return Array.from(
    new Set(
      rawCodes
        .map((code) => String(code || '').trim().toUpperCase())
        .filter(Boolean)
    )
  );
}

function normalizeFieldApplicability(raw = {}) {
  const out = {};

  if (Array.isArray(raw)) {
    for (const item of raw) {
      const key = String(item?.path || '').trim();
      if (!key) continue;
      out[key] = normalizeAppliesTo(item?.appliesTo, defaultAppliesToForPath(key));
    }
    return out;
  }

  if (raw instanceof Map) {
    for (const [path, appliesTo] of raw.entries()) {
      const key = String(path || '').trim();
      if (!key) continue;
      out[key] = normalizeAppliesTo(appliesTo, defaultAppliesToForPath(key));
    }
    return out;
  }

  for (const [path, appliesTo] of Object.entries(raw || {})) {
    const key = String(path || '').trim();
    if (!key) continue;
    out[key] = normalizeAppliesTo(appliesTo, defaultAppliesToForPath(key));
  }

  return out;
}

function getPrimaryZoneIdFromLocationData(locationData = {}) {
  const raw = locationData?.primaryZoneId || '';

  if (raw && typeof raw === 'object' && raw._id) {
    return String(raw._id || '').trim();
  }
  return String(raw || '').trim();
}

async function buildSyncedComplianceFields({ countryZoneId, enabledPackCodes = [], fieldApplicabilityByPath = {} }) {
  if (!countryZoneId || !mongoose.Types.ObjectId.isValid(String(countryZoneId))) {
    return Object.entries(fieldApplicabilityByPath || {})
      .filter(([, appliesTo]) => normalizeAppliesTo(appliesTo, 'not_needed') !== 'not_needed')
      .map(([path, appliesTo]) => ({
        path: String(path || '').trim(),
        required: false,
        appliesTo: normalizeAppliesTo(appliesTo, defaultAppliesToForPath(path)),
        packs: [],
      }))
      .filter((field) => !!field.path)
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  const docs = Array.isArray(enabledPackCodes) && enabledPackCodes.length
    ? await CompliancePack.find({
        countryZoneId: String(countryZoneId),
        status: { $in: ['active', 'draft'] },
        code: { $in: enabledPackCodes },
      })
        .sort({ code: 1, version: -1, updatedAt: -1 })
        .select('code fields.path fields.required fields.appliesTo')
        .lean()
    : [];

  const latestByCode = new Map();
  for (const doc of docs) {
    const code = String(doc?.code || '').trim().toUpperCase();
    if (!code || latestByCode.has(code)) continue;
    latestByCode.set(code, doc);
  }

  const byPath = new Map();
  for (const doc of latestByCode.values()) {
    const code = String(doc?.code || '').trim().toUpperCase();
    for (const field of Array.isArray(doc?.fields) ? doc.fields : []) {
      const path = String(field?.path || '').trim();
      if (!path) continue;

      const current = byPath.get(path) || {
        path,
        required: false,
        appliesTo: defaultAppliesToForPath(path),
        packs: new Set(),
      };
      current.required = current.required || !!field?.required;
      current.appliesTo = maxAppliesTo(
        current.appliesTo,
        normalizeAppliesTo(field?.appliesTo, defaultAppliesToForPath(path))
      );
      current.packs.add(code);
      byPath.set(path, current);
    }
  }

  for (const [path, rawAppliesTo] of Object.entries(fieldApplicabilityByPath || {})) {
    const key = String(path || '').trim();
    if (!key) continue;
    const selected = normalizeAppliesTo(rawAppliesTo, defaultAppliesToForPath(key));
    if (selected === 'not_needed') continue;
    if (byPath.has(key)) continue;

    byPath.set(key, {
      path: key,
      required: false,
      appliesTo: selected,
      packs: new Set(),
    });
  }

  return Array.from(byPath.values())
    .map((item) => {
      const selected = fieldApplicabilityByPath[item.path];
      const selectedNormalized = normalizeAppliesTo(selected, item.appliesTo);
      const packCodes = Array.from(item.packs || []);
      if (selectedNormalized === 'not_needed' && !packCodes.length) return null;
      const appliesTo = selectedNormalized === 'not_needed'
        ? item.appliesTo
        : maxAppliesTo(item.appliesTo, selectedNormalized);
      return {
        path: item.path,
        required: !!item.required,
        appliesTo,
        packs: packCodes.sort((a, b) => a.localeCompare(b)),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.path.localeCompare(b.path));
}

// Crear una nueva unidad de negocio
exports.createBusinessUnit = async (req, res) => {
  try {
    const data = { ...(req.body || {}) };
    
    // Manejar el caso en que el usuario venga como objeto completo o como string
    if (data.user && typeof data.user === 'object' && data.user._id) {
      data.user = data.user._id;
    }

    const requester = requesterId(req);
    const resolvedUser = isAdmin(req) ? String(data.user || requester || '').trim() : requester;
    data.user = resolvedUser;
    const entityType = String(data.entityType || 'individual').trim().toLowerCase();
    if (entityType !== 'business') data.teamMembers = [];
    else data.teamMembers = normalizeTeamMembers(data.teamMembers);
    if (data.locationData) {
      data.locationData = normalizeLocationData(data.locationData);
    }

    // Validación de seguridad
    if (!data.user) {
      return res.status(400).json({
        success: false,
        message: 'User ID is required to create a Business Unit.',
      });
    }

    if (data.compliance && typeof data.compliance === 'object') {
      const enabledPackCodes = normalizeEnabledPackCodes(data?.compliance?.enabledPackCodes);
      const fieldApplicabilityByPath = normalizeFieldApplicability(data?.compliance?.fieldApplicability || {});
      const primaryZoneId = getPrimaryZoneIdFromLocationData(data?.locationData || {});
      const countryZoneId = await resolveCountryZoneId(primaryZoneId);
      const fields = await buildSyncedComplianceFields({
        countryZoneId,
        enabledPackCodes,
        fieldApplicabilityByPath,
      });
      const fieldApplicabilityByPathOut = new Map();
      for (const [path, appliesTo] of Object.entries(fieldApplicabilityByPath || {})) {
        const key = String(path || '').trim();
        if (!key) continue;
        fieldApplicabilityByPathOut.set(key, normalizeAppliesTo(appliesTo, defaultAppliesToForPath(key)));
      }
      for (const field of fields) {
        fieldApplicabilityByPathOut.set(field.path, field.appliesTo);
      }
      const normalizedFieldApplicability = Array.from(fieldApplicabilityByPathOut.entries()).map(([path, appliesTo]) => ({
        path,
        appliesTo,
      }));
      data.compliance = {
        ...data.compliance,
        enabledPackCodes,
        fieldApplicability: normalizedFieldApplicability,
        fields,
      };
    }

    const businessUnit = await BusinessUnit.create(data);
    res.status(201).json({ success: true, businessUnit });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: 'Error creating Business Unit',
      error: error.message,
    });
  }
};

// Obtener todas las unidades de negocio (con filtros opcionales)
exports.getBusinessUnits = async (req, res) => {
  try {
    const filters = {};
    if (isAdmin(req)) {
      if (req.query.user) filters.user = req.query.user;
    } else {
      const requester = requesterId(req);
      if (!requester) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
      }
      filters.user = requester;
    }
    if (req.query.type) filters.businessType = req.query.type;
    if (req.query.primaryZoneId) filters['locationData.primaryZoneId'] = req.query.primaryZoneId;
    if (req.query.status) filters.status = req.query.status;

    const businessUnits = await BusinessUnit.find(filters)
      .populate('user', 'name email')
      .populate('locationData.primaryZoneId', 'name canonicalType parentZoneId parentCountryId ancestry source externalId')
      .sort({ createdAt: -1 });

    res.json({ success: true, count: businessUnits.length, businessUnits });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Error fetching Business Units', error });
  }
};

// Obtener una unidad de negocio por ID
exports.getBusinessUnitById = async (req, res) => {
  try {
    const { id } = req.params;
    const businessUnit = await BusinessUnit.findById(id)
      .populate('user', 'name email')
      .populate('locationData.primaryZoneId', 'name canonicalType parentZoneId parentCountryId ancestry source externalId');

    if (!businessUnit)
      return res.status(404).json({ success: false, message: 'Business Unit not found' });

    if (!isAdmin(req) && String(businessUnit.user?._id || businessUnit.user || '') !== requesterId(req)) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    res.json({ success: true, businessUnit });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Error fetching Business Unit', error });
  }
};

// Actualizar una unidad de negocio
exports.updateBusinessUnit = async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await BusinessUnit.findById(id)
      .select('_id user entityType teamMembers locationData.primaryZoneId compliance')
      .lean();
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Business Unit not found' });
    }

    if (!isAdmin(req) && String(existing.user || '') !== requesterId(req)) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    const updates = { ...(req.body || {}) };
    if (!isAdmin(req)) delete updates.user;
    if (Object.prototype.hasOwnProperty.call(updates, 'teamMembers')) {
      updates.teamMembers = normalizeTeamMembers(updates.teamMembers);
    }
    const effectiveEntityType = String(updates.entityType || existing.entityType || 'individual').trim().toLowerCase();
    if (effectiveEntityType !== 'business') {
      updates.teamMembers = [];
    }
    if (updates.locationData) {
      updates.locationData = normalizeLocationData(updates.locationData);
    }

    const incomingCompliance = updates.compliance && typeof updates.compliance === 'object'
      ? updates.compliance
      : null;
    const shouldSyncComplianceFields = !!incomingCompliance || !!updates.locationData;

    if (shouldSyncComplianceFields) {
      const existingCompliance = (existing?.compliance && typeof existing.compliance === 'object')
        ? existing.compliance
        : {};
      const mergedCompliance = {
        ...existingCompliance,
        ...(incomingCompliance || {}),
      };
      const enabledPackCodes = normalizeEnabledPackCodes(mergedCompliance.enabledPackCodes);
      const fieldApplicabilityByPath = normalizeFieldApplicability(mergedCompliance.fieldApplicability || {});
      const effectiveLocationData = updates.locationData || existing.locationData || {};
      const primaryZoneId = getPrimaryZoneIdFromLocationData(effectiveLocationData);
      const countryZoneId = await resolveCountryZoneId(primaryZoneId);
      const fields = await buildSyncedComplianceFields({
        countryZoneId,
        enabledPackCodes,
        fieldApplicabilityByPath,
      });
      const fieldApplicabilityByPathOut = new Map();
      for (const [path, appliesTo] of Object.entries(fieldApplicabilityByPath || {})) {
        const key = String(path || '').trim();
        if (!key) continue;
        fieldApplicabilityByPathOut.set(key, normalizeAppliesTo(appliesTo, defaultAppliesToForPath(key)));
      }
      for (const field of fields) {
        fieldApplicabilityByPathOut.set(field.path, field.appliesTo);
      }
      const normalizedFieldApplicability = Array.from(fieldApplicabilityByPathOut.entries()).map(([path, appliesTo]) => ({
        path,
        appliesTo,
      }));

      updates.compliance = {
        ...mergedCompliance,
        enabledPackCodes,
        fieldApplicability: normalizedFieldApplicability,
        fields,
      };
    }

    const businessUnit = await BusinessUnit.findByIdAndUpdate(id, updates, { new: true });

    res.json({ success: true, message: 'Business Unit updated successfully', businessUnit });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Error updating Business Unit', error });
  }
};

// Eliminar (desactivar) una unidad de negocio
exports.deleteBusinessUnit = async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await BusinessUnit.findById(id).select('_id user').lean();
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Business Unit not found' });
    }

    if (!isAdmin(req) && String(existing.user || '') !== requesterId(req)) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    const [businessUnit, servicesUpdate] = await Promise.all([
      BusinessUnit.findByIdAndUpdate(
        id,
        { status: 'inactive' },
        { new: true }
      ),
      Service.updateMany(
        {
          $or: [
            { BusinessUnitId: id },
            { businessUnitId: id },
          ],
        },
        {
          $set: {
            isActive: false,
            status: 'inactive',
          },
        }
      ),
    ]);

    const servicesDeactivated = Number(
      servicesUpdate?.modifiedCount ??
      servicesUpdate?.nModified ??
      0
    );

    res.json({
      success: true,
      message: 'Business Unit and associated services deactivated successfully',
      businessUnit,
      servicesDeactivated,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Error deleting Business Unit', error });
  }
};

// Obtener compliance packs relevantes para la BU según su primaryZoneId -> país
exports.getRelevantCompliancePacks = async (req, res) => {
  try {
    const { id } = req.params;
    const businessUnit = await BusinessUnit.findById(id)
      .select('_id user locationData.primaryZoneId compliance.enabledPackCodes')
      .lean();

    if (!businessUnit) {
      return res.status(404).json({ success: false, message: 'Business Unit not found' });
    }

    if (!isAdmin(req) && String(businessUnit.user || '') !== requesterId(req)) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    const primaryZoneId = String(
      businessUnit?.locationData?.primaryZoneId || ''
    ).trim();
    if (!primaryZoneId) {
      return res.json({
        success: true,
        data: {
          businessUnitId: String(businessUnit._id),
          primaryZoneId: null,
          countryZoneId: null,
          country: null,
          packs: [],
        },
      });
    }

    const countryZoneId = await resolveCountryZoneId(primaryZoneId);
    if (!countryZoneId || !mongoose.Types.ObjectId.isValid(countryZoneId)) {
      return res.json({
        success: true,
        data: {
          businessUnitId: String(businessUnit._id),
          primaryZoneId,
          countryZoneId: null,
          country: null,
          packs: [],
        },
      });
    }

    const [country, docs] = await Promise.all([
      Zone.findById(countryZoneId)
        .select('_id name source externalId')
        .lean(),
      CompliancePack.find({
        countryZoneId,
        status: { $in: ['active', 'draft'] },
      })
        .sort({ code: 1, version: -1, updatedAt: -1 })
        .lean(),
    ]);

    // Keep latest version per code (since BU toggles by code).
    const byCode = new Map();
    for (const doc of docs) {
      const code = String(doc?.code || '').trim().toUpperCase();
      if (!code || byCode.has(code)) continue;
      byCode.set(code, {
        _id: String(doc._id),
        code,
        version: Number(doc.version || 1),
        status: String(doc.status || 'draft'),
        submissionMode: String(doc.submissionMode || 'manual'),
        countryIso2: String(doc.countryIso2 || '').trim().toUpperCase(),
        fields: Array.isArray(doc.fields)
          ? doc.fields
              .map((field) => ({
                path: String(field?.path || '').trim(),
                required: !!field?.required,
                appliesTo: String(field?.appliesTo || '').trim() === 'main_guest' ? 'main_guest' : 'all_guests',
              }))
              .filter((field) => !!field.path)
          : [],
      });
    }

    return res.json({
      success: true,
      data: {
        businessUnitId: String(businessUnit._id),
        primaryZoneId,
        countryZoneId: String(countryZoneId),
        country: country
          ? {
              _id: String(country._id),
              name: String(country.name || ''),
              source: String(country.source || ''),
              externalId: String(country.externalId || ''),
            }
          : null,
        packs: Array.from(byCode.values()),
      },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: 'Error fetching relevant compliance packs', error });
  }
};

// Descargar archivo SIRE TXT manual por fecha (YYYY-MM-DD) para una BU específica
exports.downloadSireTxt = async (req, res) => {
  try {
    const { id } = req.params;
    const reportDate = String(req.query?.date || '').trim();

    if (!reportDate) {
      return res.status(400).json({ success: false, message: 'Query param "date" is required (YYYY-MM-DD).' });
    }

    const businessUnit = await BusinessUnit.findById(id).select('_id user').lean();
    if (!businessUnit) {
      return res.status(404).json({ success: false, message: 'Business Unit not found' });
    }

    if (!isAdmin(req) && String(businessUnit.user || '') !== requesterId(req)) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    const result = await generateSireTxtForBusinessUnit({
      businessUnitId: String(id),
      reportDate,
    });

    if (!result?.ok) {
      const code = String(result?.code || '').trim();
      const status =
        code === 'business_unit_not_found'
          ? 404
          : code === 'invalid_date' || code === 'missing_business_unit'
            ? 400
            : 409;
      return res.status(status).json({
        success: false,
        message: result?.message || 'Unable to generate SIRE TXT file.',
        code: result?.code || 'generation_error',
        meta: result?.meta || null,
      });
    }

    const filename = String(result?.filename || `sire-${reportDate}.txt`).replace(/[\r\n"]/g, '').trim();
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(String(result?.content || ''));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: 'Error generating SIRE TXT file', error });
  }
};
