const Region = require("../models/Region");
const Country = require("../models/Country");

// util
function slugify(str) {
  return String(str)
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");
}

// Crear
exports.createRegion = async (req, res) => {
  try {
    const {
      countryId,
      parentRegionId,
      name,
      names,
      type,
      typeCode,
      adminLevel,
      slug,
      slugs,
      active,
      priority
    } = req.body;

    if (!countryId) {
      return res.status(400).json({ error: "countryId es requerido" });
    }

    // validar que exista el país
    const existsCountry = await Country.findById(countryId).lean();
    if (!existsCountry) return res.status(400).json({ error: "País no válido" });
    if (parentRegionId) {
      const existsParent = await Region.findById(parentRegionId).lean();
      if (!existsParent) return res.status(400).json({ error: "Región padre no válida" });
    }

    const namesObj = (names && typeof names === "object") ? names : {};
    const slugsObj = (slugs && typeof slugs === "object") ? slugs : {};

    let baseName = name;
    if (!baseName) {
      const firstEntry = Object.values(namesObj)[0];
      if (firstEntry && typeof firstEntry === "string") {
        baseName = firstEntry;
      }
    }
    if (!baseName) {
      return res.status(400).json({ error: "name o algún names[locale] es requerido" });
    }
    baseName = String(baseName).trim();

    const cleanedNames = {};
    Object.entries(namesObj).forEach(([locale, value]) => {
      if (typeof value === "string" && value.trim()) {
        cleanedNames[locale] = value.trim();
      }
    });

    let baseSlug = slug ? String(slug).trim() : slugify(baseName);
    const cleanedSlugs = {};

    if (Object.keys(slugsObj).length > 0) {
      Object.entries(slugsObj).forEach(([locale, value]) => {
        if (typeof value === "string" && value.trim()) {
          cleanedSlugs[locale] = slugify(value.trim());
        }
      });
    } else if (Object.keys(cleanedNames).length > 0) {
      Object.entries(cleanedNames).forEach(([locale, value]) => {
        cleanedSlugs[locale] = slugify(value);
      });
    }

    const payload = {
      countryId,
      parentRegionId: parentRegionId || null,
      name: baseName,
      names: cleanedNames,
      type: type ? String(type).trim() : "region",
      typeCode: typeCode ? String(typeCode).trim() : null,
      adminLevel: Number.isFinite(adminLevel) ? Number(adminLevel) : null,
      slug: baseSlug,
      slugs: cleanedSlugs,
      active: typeof active === "boolean" ? active : true,
      priority: Number.isFinite(priority) ? Number(priority) : 100
    };

    const exists = await Region.findOne({ slug: payload.slug }).lean();
    if (exists) return res.status(409).json({ error: "Región ya existe por slug" });

    const doc = await Region.create(payload);
    return res.status(201).json(doc);
  } catch (err) {
    return res.status(500).json({ error: "Error creando región" });
  }
};

// Listar
exports.listRegions = async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const countryId = req.query.countryId;
    const parentRegionId = req.query.parentRegionId;
    const typeCode = req.query.typeCode;
    const adminLevel = req.query.adminLevel;
    const active = req.query.active === "true" ? true : req.query.active === "false" ? false : undefined;
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    const offset = Number(req.query.offset) || 0;

    const filter = {};
    if (q) filter.$or = [
      { name: { $regex: q, $options: "i" } },
      { slug: { $regex: q, $options: "i" } },
    ];
    if (countryId) filter.countryId = countryId;
    if (parentRegionId) filter.parentRegionId = parentRegionId;
    if (typeCode) filter.typeCode = typeCode;
    if (adminLevel !== undefined && adminLevel !== "") filter.adminLevel = Number(adminLevel);
    if (typeof active === "boolean") filter.active = active;

    const [results, total] = await Promise.all([
      Region.find(filter)
        .populate("countryId", "name iso2 iso3 slug") // incluir datos del país
        .populate("parentRegionId", "name slug type typeCode adminLevel")
        .sort({ priority: 1, name: 1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      Region.countDocuments(filter)
    ]);

    return res.json({ results, total, limit, offset });
  } catch (err) {
    return res.status(500).json({ error: "Error listando regiones" });
  }
};

// Obtener por ID
exports.getRegionById = async (req, res) => {
  try {
    const { id } = req.params;
    const region = await Region.findById(id)
      .populate("countryId", "name iso2 slug")
      .populate("parentRegionId", "name slug type typeCode adminLevel")
      .lean();
    if (!region) return res.status(404).json({ error: "Región no encontrada" });
    return res.json(region);
  } catch (err) {
    return res.status(500).json({ error: "Error obteniendo región" });
  }
};

// Actualizar
exports.updateRegion = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      countryId,
      parentRegionId,
      name,
      names,
      type,
      typeCode,
      adminLevel,
      slug,
      slugs,
      active,
      priority
    } = req.body;

    const payload = {};
    if (countryId) {
      const existsCountry = await Country.findById(countryId).lean();
      if (!existsCountry) return res.status(400).json({ error: "País no válido" });
      payload.countryId = countryId;
    }
    if (parentRegionId !== undefined) {
      if (parentRegionId) {
        const existsParent = await Region.findById(parentRegionId).lean();
        if (!existsParent) return res.status(400).json({ error: "Región padre no válida" });
        payload.parentRegionId = parentRegionId;
      } else {
        payload.parentRegionId = null;
      }
    }
    if (name) payload.name = String(name).trim();
    if (type) payload.type = String(type).trim();
    if (typeCode !== undefined) payload.typeCode = typeCode ? String(typeCode).trim() : null;
    if (adminLevel !== undefined) payload.adminLevel = Number.isFinite(adminLevel) ? Number(adminLevel) : null;
    if (slug) payload.slug = String(slug).trim();

    if (names && typeof names === "object") {
      const cleanedNames = {};
      Object.entries(names).forEach(([locale, value]) => {
        if (typeof value === "string" && value.trim()) {
          cleanedNames[locale] = value.trim();
        }
      });
      if (Object.keys(cleanedNames).length > 0) {
        payload.names = cleanedNames;
      }
    }

    if (slugs && typeof slugs === "object") {
      const cleanedSlugs = {};
      Object.entries(slugs).forEach(([locale, value]) => {
        if (typeof value === "string" && value.trim()) {
          cleanedSlugs[locale] = slugify(value.trim());
        }
      });
      if (Object.keys(cleanedSlugs).length > 0) {
        payload.slugs = cleanedSlugs;
      }
    }

    if (active !== undefined) payload.active = active;
    if (priority !== undefined) payload.priority = Number(priority);

    if (payload.name && !payload.slug) {
      payload.slug = slugify(payload.name);
    }

    const updated = await Region.findByIdAndUpdate(id, payload, { new: true, runValidators: true }).lean();
    if (!updated) return res.status(404).json({ error: "Región no encontrada" });

    return res.json(updated);
  } catch (err) {
    return res.status(500).json({ error: "Error actualizando región" });
  }
};

// Eliminar
exports.deleteRegion = async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await Region.findByIdAndDelete(id).lean();
    if (!deleted) return res.status(404).json({ error: "Región no encontrada" });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: "Error eliminando región" });
  }
};
