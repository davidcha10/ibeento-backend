const City = require("../models/City");
const Country = require("../models/Country");
const Region = require("../models/Region");

// util
function slugify(str) {
  return String(str)
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");
}

// Crear ciudad
exports.createCity = async (req, res) => {
  try {
    const {
      countryId,
      regionId,
      name,
      names,
      officialName,
      officialNames,
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

    // Validar país
    const existsCountry = await Country.findById(countryId).lean();
    if (!existsCountry) return res.status(400).json({ error: "País no válido" });

    // Validar región si se envía
    if (regionId) {
      const existsRegion = await Region.findById(regionId).lean();
      if (!existsRegion) return res.status(400).json({ error: "Región no válida" });
      if (String(existsRegion.countryId) !== String(countryId)) {
        return res.status(400).json({ error: "La región no pertenece al país indicado" });
      }
    }

    const namesObj = (names && typeof names === "object") ? names : {};
    const officialNamesObj = (officialNames && typeof officialNames === "object") ? officialNames : {};
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

    const cleanedOfficialNames = {};
    Object.entries(officialNamesObj).forEach(([locale, value]) => {
      if (typeof value === "string" && value.trim()) {
        cleanedOfficialNames[locale] = value.trim();
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
      regionId: regionId || null,
      name: baseName,
      names: cleanedNames,
      officialName: officialName ? String(officialName).trim() : null,
      officialNames: cleanedOfficialNames,
      type: type ? String(type).trim() : "city",
      typeCode: typeCode ? String(typeCode).trim() : null,
      adminLevel: Number.isFinite(adminLevel) ? Number(adminLevel) : null,
      slug: baseSlug,
      slugs: cleanedSlugs,
      active: typeof active === "boolean" ? active : true,
      priority: Number.isFinite(priority) ? Number(priority) : 100
    };

    const exists = await City.findOne({ slug: payload.slug }).lean();
    if (exists) return res.status(409).json({ error: "Ciudad ya existe por slug" });

    const doc = await City.create(payload);
    return res.status(201).json(doc);
  } catch (err) {
    return res.status(500).json({ error: "Error creando ciudad", details: err.message });
  }
};

// Listar ciudades
exports.listCities = async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const countryId = req.query.countryId;
    const regionId = req.query.regionId;
    const typeCode = req.query.typeCode;
    const adminLevel = req.query.adminLevel;
    const active = req.query.active === "true" ? true : req.query.active === "false" ? false : undefined;
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    const offset = Number(req.query.offset) || 0;

    const filter = {};
    if (q) filter.$or = [
      { name: { $regex: q, $options: "i" } },
      { slug: { $regex: q, $options: "i" } }
    ];
    if (countryId) filter.countryId = countryId;
    if (regionId) filter.regionId = regionId;
    if (typeCode) filter.typeCode = typeCode;
    if (adminLevel !== undefined && adminLevel !== "") filter.adminLevel = Number(adminLevel);
    if (typeof active === "boolean") filter.active = active;

    const [results, total] = await Promise.all([
      City.find(filter)
      .populate("countryId", "name iso2 iso3 slug")
      .populate("regionId", "name slug type typeCode adminLevel")
      .sort({ priority: 1, name: 1 })
      .skip(offset)
      .limit(limit)
        .lean(),
      City.countDocuments(filter)
    ]);

    return res.json({ results, total, limit, offset });
  } catch (err) {
    return res.status(500).json({ error: "Error listando ciudades" });
  }
};

// Obtener ciudad por id
exports.getCityById = async (req, res) => {
  try {
    const { id } = req.params;
    const city = await City.findById(id)
      .populate("countryId", "name iso2 slug")
      .populate("regionId", "name code slug")
      .lean();
    if (!city) return res.status(404).json({ error: "Ciudad no encontrada" });
    return res.json(city);
  } catch (err) {
    return res.status(500).json({ error: "Error obteniendo ciudad" });
  }
};

// Actualizar ciudad
exports.updateCity = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      countryId,
      regionId,
      name,
      names,
      officialName,
      officialNames,
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
    if (regionId !== undefined) {
      if (regionId) {
        const existsRegion = await Region.findById(regionId).lean();
        if (!existsRegion) return res.status(400).json({ error: "Región no válida" });

        let countryIdToCheck = countryId;
        if (!countryIdToCheck) {
          const currentCity = await City.findById(id).select("countryId").lean();
          countryIdToCheck = currentCity?.countryId;
        }

        if (countryIdToCheck && String(existsRegion.countryId) !== String(countryIdToCheck)) {
          return res.status(400).json({ error: "La región no pertenece al país indicado" });
        }
        payload.regionId = regionId;
      } else {
        payload.regionId = null;
      }
    }
    if (name) payload.name = String(name).trim();
    if (officialName !== undefined) payload.officialName = officialName ? String(officialName).trim() : null;
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

    if (officialNames && typeof officialNames === "object") {
      const cleanedOfficialNames = {};
      Object.entries(officialNames).forEach(([locale, value]) => {
        if (typeof value === "string" && value.trim()) {
          cleanedOfficialNames[locale] = value.trim();
        }
      });
      if (Object.keys(cleanedOfficialNames).length > 0) {
        payload.officialNames = cleanedOfficialNames;
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

    if (payload.name && !payload.slug) payload.slug = slugify(payload.name);

    const updated = await City.findByIdAndUpdate(id, payload, { new: true, runValidators: true }).lean();
    if (!updated) return res.status(404).json({ error: "Ciudad no encontrada" });

    return res.json(updated);
  } catch (err) {
    return res.status(500).json({ error: "Error actualizando ciudad" });
  }
};

// Eliminar ciudad
exports.deleteCity = async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await City.findByIdAndDelete(id).lean();
    if (!deleted) return res.status(404).json({ error: "Ciudad no encontrada" });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: "Error eliminando ciudad" });
  }
};
