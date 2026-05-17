const { Types } = require("mongoose");
const Zone = require("../models/Zone");

function slugify(str) {
  return String(str)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");
}

function sanitizeStringMap(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" && value.trim()) {
      out[key] = value.trim();
    }
  }
  return out;
}

function parseNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseNonNegativeIntOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const normalized = Math.floor(n);
  return normalized >= 0 ? normalized : null;
}

function parseObjectIdOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  return Types.ObjectId.isValid(String(value)) ? new Types.ObjectId(String(value)) : null;
}

function parseAuditStatusOrDefault(value, fallback = "pending") {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "approved" || raw === "rejected" || raw === "pending") return raw;
  return fallback;
}

function normalizeTaxonomySnapshot(input = {}) {
  const snapshot = (input && typeof input === "object" && !Array.isArray(input)) ? input : {};
  const canonicalType = snapshot.canonicalType
    ? String(snapshot.canonicalType).trim()
    : (snapshot.type ? String(snapshot.type).trim() : null);
  const typeCode = snapshot.typeCode ? String(snapshot.typeCode).trim() : null;
  const qid = snapshot.qid
    ? String(snapshot.qid).trim().toUpperCase()
    : (snapshot.typeQid ? String(snapshot.typeQid).trim().toUpperCase() : null);
  const taxonomyId = parseObjectIdOrNull(snapshot.taxonomyId ?? snapshot.zoneTypeTaxonomyId);
  const displayTypeLabel = snapshot.displayTypeLabel ? String(snapshot.displayTypeLabel).trim() : null;
  const wikidataName = snapshot.wikidataName ? String(snapshot.wikidataName).trim() : null;
  const numberOfSteps = parseNonNegativeIntOrNull(snapshot.numberOfSteps);
  const auditStatus = parseAuditStatusOrDefault(snapshot.auditStatus, "pending");

  return {
    canonicalType: canonicalType || "zone",
    typeCode,
    qid,
    taxonomyId,
    displayTypeLabel,
    wikidataName,
    numberOfSteps,
    auditStatus,
  };
}

function extractTaxonomySnapshotFromRequest(body = {}) {
  if (body.taxonomySnapshot && typeof body.taxonomySnapshot === "object") {
    return normalizeTaxonomySnapshot(body.taxonomySnapshot);
  }
  return normalizeTaxonomySnapshot({
    canonicalType: body.canonicalType,
    type: body.type,
    typeCode: body.typeCode,
    qid: body.qid,
    typeQid: body.typeQid,
    taxonomyId: body.taxonomyId,
    zoneTypeTaxonomyId: body.zoneTypeTaxonomyId,
    displayTypeLabel: body.displayTypeLabel,
    wikidataName: body.wikidataName,
    numberOfSteps: body.numberOfSteps,
    auditStatus: body.auditStatus,
  });
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

function getZoneTypeTaxonomyId(zone) {
  return zone?.taxonomySnapshot?.taxonomyId || zone?.taxonomySnapshot?.zoneTypeTaxonomyId || zone?.taxonomyId || zone?.zoneTypeTaxonomyId || null;
}

function getZoneDisplayTypeLabel(zone) {
  return zone?.taxonomySnapshot?.displayTypeLabel || zone?.displayTypeLabel || null;
}

function getZoneWikidataName(zone) {
  return zone?.taxonomySnapshot?.wikidataName || zone?.wikidataName || null;
}

function attachLegacySnapshotFields(zone) {
  const mapOne = (input) => {
    if (!input || typeof input !== "object") return input;
    const snapshot = input.taxonomySnapshot && typeof input.taxonomySnapshot === "object"
      ? input.taxonomySnapshot
      : {};
    return {
      ...input,
      canonicalType: snapshot.canonicalType || snapshot.type || input.canonicalType || input.type || null,
      type: snapshot.canonicalType || snapshot.type || input.type || input.canonicalType || null,
      typeCode: snapshot.typeCode || input.typeCode || null,
      qid: snapshot.qid || snapshot.typeQid || input.qid || input.typeQid || null,
      typeQid: snapshot.qid || snapshot.typeQid || input.typeQid || input.qid || null,
      taxonomyId: snapshot.taxonomyId || snapshot.zoneTypeTaxonomyId || input.taxonomyId || input.zoneTypeTaxonomyId || null,
      zoneTypeTaxonomyId: snapshot.taxonomyId || snapshot.zoneTypeTaxonomyId || input.zoneTypeTaxonomyId || input.taxonomyId || null,
      displayTypeLabel: snapshot.displayTypeLabel || input.displayTypeLabel || null,
      wikidataName: snapshot.wikidataName || input.wikidataName || null,
      numberOfSteps: snapshot.numberOfSteps ?? input.numberOfSteps ?? null,
      auditStatus: snapshot.auditStatus || input.auditStatus || "pending",
    };
  };

  if (!zone || typeof zone !== "object") return zone;
  const mapped = mapOne(zone);
  return {
    ...mapped,
    parentZoneId: mapOne(mapped.parentZoneId),
    parentCountryId: mapOne(mapped.parentCountryId),
  };
}

function normalizeGeo(geo) {
  if (!geo || typeof geo !== "object") return null;
  const type = geo.type || geo?.type;
  const coords = geo.coordinates;
  if (type !== "Point" || !Array.isArray(coords) || coords.length !== 2) return null;
  const lng = Number(coords[0]);
  const lat = Number(coords[1]);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return { type: "Point", coordinates: [lng, lat] };
}

async function resolveHierarchy(parentZoneId, explicitCountryId) {
  const hierarchy = {
    parentZoneId: null,
    parentCountryId: null,
    ancestry: [],
    level: 1
  };

  if (parentZoneId) {
    const parent = await Zone.findById(parentZoneId).select("_id ancestry level parentCountryId taxonomySnapshot type").lean();
    if (!parent) {
      return { error: "Zona padre no válida" };
    }
    hierarchy.parentZoneId = parent._id;
    hierarchy.ancestry = [...(parent.ancestry || []), parent._id];
    hierarchy.level = Number.isFinite(parent.level) ? Number(parent.level) + 1 : hierarchy.ancestry.length + 1;
    hierarchy.parentCountryId = parent.parentCountryId || (getZoneType(parent) === "country" ? parent._id : null);
  }

  if (explicitCountryId !== undefined) {
    if (!explicitCountryId) {
      hierarchy.parentCountryId = null;
    } else {
      const rootZone = await Zone.findById(explicitCountryId).select("_id").lean();
      if (!rootZone) {
        return { error: "parentCountryId no válido" };
      }
      hierarchy.parentCountryId = rootZone._id;
    }
  }

  return hierarchy;
}

async function rebaseDescendants(zoneId, newAncestry, newParentCountryId) {
  const descendants = await Zone.find({ ancestry: zoneId }).select("_id ancestry").lean();
  if (!descendants.length) return;

  const updates = descendants
    .map((desc) => {
      const idx = (desc.ancestry || []).findIndex((id) => String(id) === String(zoneId));
      if (idx === -1) return null;
      const suffix = (desc.ancestry || []).slice(idx + 1);
      return {
        updateOne: {
          filter: { _id: desc._id },
          update: {
            $set: {
              ancestry: [...newAncestry, zoneId, ...suffix],
              parentCountryId: newParentCountryId || null
            }
          }
        }
      };
    })
    .filter(Boolean);

  if (updates.length) {
    await Zone.bulkWrite(updates);
  }
}

exports.createZone = async (req, res) => {
  try {
    const {
      parentZoneId,
      parentCountryId,
      name,
      names,
      officialName,
      officialNames,
      slug,
      slugs,
      taxonomySnapshot,
      canonicalType,
      type,
      typeCode,
      qid,
      typeQid,
      taxonomyId,
      zoneTypeTaxonomyId,
      displayTypeLabel,
      wikidataName,
      numberOfSteps,
      auditStatus,
      level,
      adminLevel,
      source,
      externalId,
      cover,
      timeZone,
      geo,
      active,
      audited,
      priority,
      discoverPreviewSearched
    } = req.body;

    const namesObj = sanitizeStringMap(names);
    const officialNamesObj = sanitizeStringMap(officialNames);
    const slugsObj = sanitizeStringMap(slugs);

    let baseName = name;
    if (!baseName) {
      const firstEntry = Object.values(namesObj)[0];
      if (typeof firstEntry === "string") baseName = firstEntry;
    }
    if (!baseName || !String(baseName).trim()) {
      return res.status(400).json({ error: "name o algún names[locale] es requerido" });
    }
    baseName = String(baseName).trim();

    const zoneId = new Types.ObjectId();

    const hierarchy = await resolveHierarchy(parentZoneId, parentCountryId);
    if (hierarchy.error) return res.status(400).json({ error: hierarchy.error });
    const resolvedSnapshot = extractTaxonomySnapshotFromRequest({
      taxonomySnapshot,
      canonicalType,
      type,
      typeCode,
      qid,
      typeQid,
      taxonomyId,
      zoneTypeTaxonomyId,
      displayTypeLabel,
      wikidataName,
      numberOfSteps,
      auditStatus,
    });

    const payload = {
      _id: zoneId,
      parentZoneId: hierarchy.parentZoneId,
      parentCountryId: hierarchy.parentCountryId,
      ancestry: hierarchy.ancestry,
      name: baseName,
      names: namesObj,
      officialName: officialName ? String(officialName).trim() : null,
      officialNames: officialNamesObj,
      slug: slug ? String(slug).trim() : slugify(baseName),
      slugs: slugsObj,
      taxonomySnapshot: resolvedSnapshot,
      level: parseNumberOrNull(level) ?? hierarchy.level,
      adminLevel: parseNumberOrNull(adminLevel),
      source: source ? String(source).trim() : null,
      externalId: externalId ? String(externalId).trim() : null,
      cover: cover ? String(cover).trim() : null,
      timeZone: timeZone ? String(timeZone).trim() : null,
      geo: normalizeGeo(geo),
      active: typeof active === "boolean" ? active : true,
      audited: typeof audited === "boolean" ? audited : false,
      priority: Number.isFinite(Number(priority)) ? Number(priority) : 100,
      discoverPreviewSearched: typeof discoverPreviewSearched === "boolean" ? discoverPreviewSearched : false
    };

    if (payload.taxonomySnapshot?.canonicalType === "country" && !payload.parentCountryId) {
      payload.parentCountryId = zoneId;
    }

    if (Object.keys(payload.slugs).length === 0 && Object.keys(payload.names).length > 0) {
      for (const [locale, value] of Object.entries(payload.names)) {
        payload.slugs[locale] = slugify(value);
      }
    }

    const doc = await Zone.create(payload);
    return res.status(201).json(attachLegacySnapshotFields(doc.toObject()));
  } catch (err) {
    return res.status(500).json({ error: "Error creando zona", details: err.message });
  }
};

exports.listZones = async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const parentZoneId = req.query.parentZoneId;
    const parentCountryId = req.query.parentCountryId;
    const canonicalType = req.query.canonicalType || req.query.type;
    const typeCode = req.query.typeCode;
    const level = req.query.level;
    const adminLevel = req.query.adminLevel;
    const active = req.query.active === "true" ? true : req.query.active === "false" ? false : undefined;
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    const offset = Number(req.query.offset) || 0;
    const includePath = req.query.includePath === "true";

    const filter = {};
    if (q) {
      filter.$or = [
        { name: { $regex: q, $options: "i" } },
        { slug: { $regex: q, $options: "i" } },
        { officialName: { $regex: q, $options: "i" } },
        { "taxonomySnapshot.typeCode": { $regex: q, $options: "i" } },
        { "taxonomySnapshot.canonicalType": { $regex: q, $options: "i" } },
        { typeCode: { $regex: q, $options: "i" } }
      ];
    }
    if (parentZoneId !== undefined) {
      if (parentZoneId === "" || parentZoneId === "null") filter.parentZoneId = null;
      else filter.parentZoneId = parentZoneId;
    }
    if (parentCountryId) filter.parentCountryId = parentCountryId;
    if (canonicalType) {
      filter.$and = filter.$and || [];
      filter.$and.push({
        $or: [
          { "taxonomySnapshot.canonicalType": canonicalType },
          { "taxonomySnapshot.type": canonicalType },
          { canonicalType },
          { type: canonicalType },
        ],
      });
    }
    if (typeCode) {
      filter.$and = filter.$and || [];
      filter.$and.push({
        $or: [
          { "taxonomySnapshot.typeCode": typeCode },
          { typeCode },
        ],
      });
    }
    if (level !== undefined && level !== "") filter.level = Number(level);
    if (adminLevel !== undefined && adminLevel !== "") filter.adminLevel = Number(adminLevel);
    if (typeof active === "boolean") filter.active = active;

    const [results, total] = await Promise.all([
      Zone.find(filter)
        .populate("parentZoneId", "name slug taxonomySnapshot canonicalType type typeCode qid typeQid taxonomyId zoneTypeTaxonomyId displayTypeLabel wikidataName level adminLevel")
        .populate("parentCountryId", "name slug taxonomySnapshot canonicalType type typeCode qid typeQid taxonomyId zoneTypeTaxonomyId displayTypeLabel wikidataName level adminLevel")
        .sort({ priority: 1, level: 1, name: 1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      Zone.countDocuments(filter)
    ]);

    let hydratedResults = results.map(attachLegacySnapshotFields);

    if (includePath && hydratedResults.length) {
      const ancestryIds = Array.from(
        new Set(
          hydratedResults
            .flatMap((zone) => (Array.isArray(zone?.ancestry) ? zone.ancestry : []))
            .map((id) => String(id))
            .filter(Boolean)
        )
      );

      const ancestryDocs = ancestryIds.length
        ? await Zone.find({ _id: { $in: ancestryIds } }).select("_id name").lean()
        : [];
      const ancestryById = new Map(ancestryDocs.map((doc) => [String(doc._id), doc]));

      hydratedResults = hydratedResults.map((zone) => {
        const chain = (Array.isArray(zone?.ancestry) ? zone.ancestry : [])
          .map((id) => ancestryById.get(String(id))?.name)
          .filter(Boolean);
        const pathNames = [...chain, zone?.name].filter(Boolean);
        return {
          ...zone,
          pathNames,
          pathLabel: pathNames.join(" > "),
        };
      });
    }

    return res.json({ results: hydratedResults, total, limit, offset });
  } catch (err) {
    return res.status(500).json({ error: "Error listando zonas" });
  }
};

exports.getZoneById = async (req, res) => {
  try {
    const { id } = req.params;
    const zone = await Zone.findById(id)
      .populate("parentZoneId", "name slug taxonomySnapshot canonicalType type typeCode qid typeQid taxonomyId zoneTypeTaxonomyId displayTypeLabel wikidataName level adminLevel")
      .populate("parentCountryId", "name slug taxonomySnapshot canonicalType type typeCode qid typeQid taxonomyId zoneTypeTaxonomyId displayTypeLabel wikidataName level adminLevel")
      .lean();
    if (!zone) return res.status(404).json({ error: "Zona no encontrada" });
    return res.json(attachLegacySnapshotFields(zone));
  } catch (err) {
    return res.status(500).json({ error: "Error obteniendo zona" });
  }
};

exports.updateZone = async (req, res) => {
  try {
    const { id } = req.params;
    const current = await Zone.findById(id).lean();
    if (!current) return res.status(404).json({ error: "Zona no encontrada" });

    const {
      parentZoneId,
      parentCountryId,
      name,
      names,
      officialName,
      officialNames,
      slug,
      slugs,
      taxonomySnapshot,
      canonicalType,
      type,
      typeCode,
      qid,
      typeQid,
      taxonomyId,
      zoneTypeTaxonomyId,
      displayTypeLabel,
      wikidataName,
      numberOfSteps,
      auditStatus,
      level,
      adminLevel,
      source,
      externalId,
      cover,
      timeZone,
      geo,
      active,
      audited,
      priority,
      discoverPreviewSearched
    } = req.body;

    const payload = {};
    const snapshotPatchSource = taxonomySnapshot !== undefined
      ? { taxonomySnapshot }
      : { canonicalType, type, typeCode, qid, typeQid, taxonomyId, zoneTypeTaxonomyId, displayTypeLabel, wikidataName, numberOfSteps, auditStatus };
    const snapshotPatch = extractTaxonomySnapshotFromRequest(snapshotPatchSource);

    if (name !== undefined) payload.name = String(name || "").trim();
    if (officialName !== undefined) payload.officialName = officialName ? String(officialName).trim() : null;
    if (taxonomySnapshot !== undefined || canonicalType !== undefined || type !== undefined) {
      payload["taxonomySnapshot.canonicalType"] = snapshotPatch.canonicalType;
    }
    if (taxonomySnapshot !== undefined || typeCode !== undefined) payload["taxonomySnapshot.typeCode"] = snapshotPatch.typeCode;
    if (taxonomySnapshot !== undefined || qid !== undefined || typeQid !== undefined) payload["taxonomySnapshot.qid"] = snapshotPatch.qid;
    if (taxonomySnapshot !== undefined || taxonomyId !== undefined || zoneTypeTaxonomyId !== undefined) payload["taxonomySnapshot.taxonomyId"] = snapshotPatch.taxonomyId;
    if (taxonomySnapshot !== undefined || displayTypeLabel !== undefined) payload["taxonomySnapshot.displayTypeLabel"] = snapshotPatch.displayTypeLabel;
    if (taxonomySnapshot !== undefined || wikidataName !== undefined) payload["taxonomySnapshot.wikidataName"] = snapshotPatch.wikidataName;
    if (taxonomySnapshot !== undefined || numberOfSteps !== undefined) payload["taxonomySnapshot.numberOfSteps"] = snapshotPatch.numberOfSteps;
    if (taxonomySnapshot !== undefined || auditStatus !== undefined) payload["taxonomySnapshot.auditStatus"] = snapshotPatch.auditStatus;
    if (source !== undefined) payload.source = source ? String(source).trim() : null;
    if (externalId !== undefined) payload.externalId = externalId ? String(externalId).trim() : null;
    if (cover !== undefined) payload.cover = cover ? String(cover).trim() : null;
    if (timeZone !== undefined) payload.timeZone = timeZone ? String(timeZone).trim() : null;
    if (active !== undefined) payload.active = !!active;
    if (audited !== undefined) payload.audited = !!audited;
    if (priority !== undefined) payload.priority = Number.isFinite(Number(priority)) ? Number(priority) : 100;
    if (discoverPreviewSearched !== undefined) payload.discoverPreviewSearched = !!discoverPreviewSearched;
    if (level !== undefined) payload.level = parseNumberOrNull(level);
    if (adminLevel !== undefined) payload.adminLevel = parseNumberOrNull(adminLevel);
    if (slug !== undefined) payload.slug = slug ? String(slug).trim() : undefined;

    if (names !== undefined) payload.names = sanitizeStringMap(names);
    if (officialNames !== undefined) payload.officialNames = sanitizeStringMap(officialNames);
    if (slugs !== undefined) payload.slugs = sanitizeStringMap(slugs);
    if (geo !== undefined) payload.geo = normalizeGeo(geo);

    if (payload.name && !payload.slug) {
      payload.slug = slugify(payload.name);
    }
    if (payload.slugs && Object.keys(payload.slugs).length === 0 && payload.names && Object.keys(payload.names).length > 0) {
      const generated = {};
      for (const [locale, value] of Object.entries(payload.names)) {
        generated[locale] = slugify(value);
      }
      payload.slugs = generated;
    }

    const parentChanged =
      parentZoneId !== undefined ||
      parentCountryId !== undefined ||
      canonicalType !== undefined ||
      type !== undefined ||
      taxonomySnapshot !== undefined;
    let nextAncestry = current.ancestry || [];
    let nextParentCountryId = current.parentCountryId || null;

    if (parentChanged) {
      const hierarchy = await resolveHierarchy(
        parentZoneId !== undefined ? parentZoneId : current.parentZoneId,
        parentCountryId !== undefined ? parentCountryId : current.parentCountryId
      );
      if (hierarchy.error) return res.status(400).json({ error: hierarchy.error });

      payload.parentZoneId = hierarchy.parentZoneId;
      nextAncestry = hierarchy.ancestry;
      nextParentCountryId = hierarchy.parentCountryId;

      const nextType = payload["taxonomySnapshot.canonicalType"] || getZoneType(current);
      if (nextType === "country" && !nextParentCountryId) {
        nextParentCountryId = current._id;
      }

      payload.ancestry = nextAncestry;
      payload.parentCountryId = nextParentCountryId;
      payload.level = payload.level ?? hierarchy.level;
    }

    const updated = await Zone.findByIdAndUpdate(id, payload, { new: true, runValidators: true }).lean();
    if (!updated) return res.status(404).json({ error: "Zona no encontrada" });

    if (parentChanged) {
      await rebaseDescendants(updated._id, updated.ancestry || [], updated.parentCountryId || null);
    }

    return res.json(attachLegacySnapshotFields(updated));
  } catch (err) {
    return res.status(500).json({ error: "Error actualizando zona", details: err.message });
  }
};

exports.deleteZone = async (req, res) => {
  try {
    const { id } = req.params;
    const hasChildren = await Zone.exists({ parentZoneId: id });
    if (hasChildren) {
      return res.status(409).json({ error: "No se puede eliminar una zona con hijos" });
    }

    const deleted = await Zone.findByIdAndDelete(id).lean();
    if (!deleted) return res.status(404).json({ error: "Zona no encontrada" });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: "Error eliminando zona" });
  }
};
