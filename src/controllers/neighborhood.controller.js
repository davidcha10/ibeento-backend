const Neighborhood = require("../models/Neighborhood");
const Country = require("../models/Country");
const Region = require("../models/Region");
const City = require("../models/City");

function slugify(str) {
  return String(str)
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");
}

exports.createNeighborhood = async (req, res) => {
  try {
    const {
      countryId,
      regionId,
      cityId,
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

    if (!countryId) return res.status(400).json({ error: "countryId es requerido" });
    if (!cityId) return res.status(400).json({ error: "cityId es requerido" });

    const existsCountry = await Country.findById(countryId).lean();
    if (!existsCountry) return res.status(400).json({ error: "País no válido" });

    const existsCity = await City.findById(cityId).lean();
    if (!existsCity) return res.status(400).json({ error: "Ciudad no válida" });
    if (String(existsCity.countryId) !== String(countryId)) {
      return res.status(400).json({ error: "La ciudad no pertenece al país indicado" });
    }

    if (regionId) {
      const existsRegion = await Region.findById(regionId).lean();
      if (!existsRegion) return res.status(400).json({ error: "Región no válida" });
      if (String(existsRegion.countryId) !== String(countryId)) {
        return res.status(400).json({ error: "La región no pertenece al país indicado" });
      }
      if (existsCity.regionId && String(existsCity.regionId) !== String(regionId)) {
        return res.status(400).json({ error: "La región no coincide con la ciudad indicada" });
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
    if (!baseName) return res.status(400).json({ error: "name o algún names[locale] es requerido" });
    baseName = String(baseName).trim();

    const cleanedNames = {};
    Object.entries(namesObj).forEach(([locale, value]) => {
      if (typeof value === "string" && value.trim()) cleanedNames[locale] = value.trim();
    });

    const cleanedOfficialNames = {};
    Object.entries(officialNamesObj).forEach(([locale, value]) => {
      if (typeof value === "string" && value.trim()) cleanedOfficialNames[locale] = value.trim();
    });

    let baseSlug = slug ? String(slug).trim() : slugify(baseName);
    const cleanedSlugs = {};

    if (Object.keys(slugsObj).length > 0) {
      Object.entries(slugsObj).forEach(([locale, value]) => {
        if (typeof value === "string" && value.trim()) cleanedSlugs[locale] = slugify(value.trim());
      });
    } else if (Object.keys(cleanedNames).length > 0) {
      Object.entries(cleanedNames).forEach(([locale, value]) => {
        cleanedSlugs[locale] = slugify(value);
      });
    }

    const payload = {
      countryId,
      regionId: regionId || null,
      cityId,
      name: baseName,
      names: cleanedNames,
      officialName: officialName ? String(officialName).trim() : null,
      officialNames: cleanedOfficialNames,
      type: type ? String(type).trim() : "neighborhood",
      typeCode: typeCode ? String(typeCode).trim() : null,
      adminLevel: Number.isFinite(adminLevel) ? Number(adminLevel) : null,
      slug: baseSlug,
      slugs: cleanedSlugs,
      active: typeof active === "boolean" ? active : true,
      priority: Number.isFinite(priority) ? Number(priority) : 100
    };

    const exists = await Neighborhood.findOne({ slug: payload.slug }).lean();
    if (exists) return res.status(409).json({ error: "Barrio ya existe por slug" });

    const doc = await Neighborhood.create(payload);
    return res.status(201).json(doc);
  } catch (err) {
    return res.status(500).json({ error: "Error creando barrio", details: err.message });
  }
};

exports.listNeighborhoods = async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const countryId = req.query.countryId;
    const regionId = req.query.regionId;
    const cityId = req.query.cityId;
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
    if (cityId) filter.cityId = cityId;
    if (typeCode) filter.typeCode = typeCode;
    if (adminLevel !== undefined && adminLevel !== "") filter.adminLevel = Number(adminLevel);
    if (typeof active === "boolean") filter.active = active;

    const [results, total] = await Promise.all([
      Neighborhood.find(filter)
        .populate("countryId", "name iso2 iso3 slug")
        .populate("regionId", "name slug type typeCode adminLevel")
        .populate("cityId", "name slug")
        .sort({ priority: 1, name: 1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      Neighborhood.countDocuments(filter)
    ]);

    return res.json({ results, total, limit, offset });
  } catch (err) {
    return res.status(500).json({ error: "Error listando barrios" });
  }
};

exports.getNeighborhoodById = async (req, res) => {
  try {
    const { id } = req.params;
    const neighborhood = await Neighborhood.findById(id)
      .populate("countryId", "name iso2 slug")
      .populate("regionId", "name slug type typeCode adminLevel")
      .populate("cityId", "name slug")
      .lean();
    if (!neighborhood) return res.status(404).json({ error: "Barrio no encontrado" });
    return res.json(neighborhood);
  } catch (err) {
    return res.status(500).json({ error: "Error obteniendo barrio" });
  }
};

exports.updateNeighborhood = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      countryId,
      regionId,
      cityId,
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

    if (cityId) {
      const existsCity = await City.findById(cityId).lean();
      if (!existsCity) return res.status(400).json({ error: "Ciudad no válida" });
      const countryIdToCheck = payload.countryId || existsCity.countryId;
      if (countryIdToCheck && String(existsCity.countryId) !== String(countryIdToCheck)) {
        return res.status(400).json({ error: "La ciudad no pertenece al país indicado" });
      }
      payload.cityId = cityId;
    }

    if (regionId !== undefined) {
      if (regionId) {
        const existsRegion = await Region.findById(regionId).lean();
        if (!existsRegion) return res.status(400).json({ error: "Región no válida" });

        let countryIdToCheck = payload.countryId;
        if (!countryIdToCheck) {
          const current = await Neighborhood.findById(id).select("countryId").lean();
          countryIdToCheck = current?.countryId;
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
        if (typeof value === "string" && value.trim()) cleanedNames[locale] = value.trim();
      });
      if (Object.keys(cleanedNames).length > 0) payload.names = cleanedNames;
    }

    if (officialNames && typeof officialNames === "object") {
      const cleanedOfficialNames = {};
      Object.entries(officialNames).forEach(([locale, value]) => {
        if (typeof value === "string" && value.trim()) cleanedOfficialNames[locale] = value.trim();
      });
      if (Object.keys(cleanedOfficialNames).length > 0) payload.officialNames = cleanedOfficialNames;
    }

    if (slugs && typeof slugs === "object") {
      const cleanedSlugs = {};
      Object.entries(slugs).forEach(([locale, value]) => {
        if (typeof value === "string" && value.trim()) cleanedSlugs[locale] = slugify(value.trim());
      });
      if (Object.keys(cleanedSlugs).length > 0) payload.slugs = cleanedSlugs;
    }

    if (active !== undefined) payload.active = active;
    if (priority !== undefined) payload.priority = Number(priority);

    if (payload.name && !payload.slug) {
      payload.slug = slugify(payload.name);
    }

    const updated = await Neighborhood.findByIdAndUpdate(id, payload, { new: true, runValidators: true }).lean();
    if (!updated) return res.status(404).json({ error: "Barrio no encontrado" });

    return res.json(updated);
  } catch (err) {
    return res.status(500).json({ error: "Error actualizando barrio" });
  }
};

exports.deleteNeighborhood = async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await Neighborhood.findByIdAndDelete(id).lean();
    if (!deleted) return res.status(404).json({ error: "Barrio no encontrado" });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: "Error eliminando barrio" });
  }
};
