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
exports.createCountry = async (req, res) => {
  try {
    const { name, names, officialName, officialNames, iso2, phoneCode, typeCode, slug, slugs, active, priority } = req.body;

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

    const officialNamesObj = (officialNames && typeof officialNames === "object") ? officialNames : {};
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
      name: baseName,
      names: cleanedNames,
      officialName: officialName ? String(officialName).trim() : undefined,
      officialNames: cleanedOfficialNames,
      iso2: String(iso2).trim().toUpperCase(),
      phoneCode: phoneCode ? String(phoneCode).trim() : undefined,
      typeCode: typeCode ? String(typeCode).trim() : undefined,
      slug: baseSlug,
      slugs: cleanedSlugs,
      active: typeof active === "boolean" ? active : true,
      priority: Number.isFinite(priority) ? Number(priority) : 100
    };

    if (payload.iso2.length !== 2) return res.status(400).json({ error: "iso2 debe tener 2 caracteres" });

    const exists = await Country.findOne({ $or: [{ iso2: payload.iso2 }, { slug: payload.slug }] }).lean();
    if (exists) return res.status(409).json({ error: "País ya existe por iso2 o slug" });

    const doc = await Country.create(payload);
    return res.status(201).json(doc);
  } catch (err) {
    return res.status(500).json({ error: "Error creando país" });
  }
};

// Listar
exports.listCountries = async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const active = req.query.active === "true" ? true : req.query.active === "false" ? false : undefined;
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    const offset = Number(req.query.offset) || 0;

    const filter = {};
    if (q) filter.$or = [
      { name: { $regex: q, $options: "i" } },
      { slug: { $regex: q, $options: "i" } },
      { iso2: { $regex: `^${q}`, $options: "i" } },
    ];
    if (typeof active === "boolean") filter.active = active;

    const [results, total] = await Promise.all([
      Country.find(filter).sort({ priority: 1, name: 1 }).skip(offset).limit(limit).lean(),
      Country.countDocuments(filter)
    ]);

    return res.json({ results, total, limit, offset });
  } catch (err) {
    return res.status(500).json({ error: "Error listando países" });
  }
};

// Obtener por ID
exports.getCountryById = async (req, res) => {
  try {
    const { id } = req.params;
    const country = await Country.findById(id).lean();
    if (!country) return res.status(404).json({ error: "País no encontrado" });
    return res.json(country);
  } catch (err) {
    return res.status(500).json({ error: "Error obteniendo país" });
  }
};

// Actualizar
exports.updateCountry = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, names, officialName, officialNames, iso2, phoneCode, typeCode, slug, slugs, active, priority } = req.body;

    const payload = {};
    if (name) payload.name = String(name).trim();
    if (iso2) {
      if (String(iso2).trim().length !== 2) return res.status(400).json({ error: "iso2 debe tener 2 caracteres" });
      payload.iso2 = String(iso2).trim().toUpperCase();
    }

    if (phoneCode) payload.phoneCode = String(phoneCode).trim();
    if (typeCode !== undefined) payload.typeCode = typeCode ? String(typeCode).trim() : null;
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

    if (officialName !== undefined) payload.officialName = officialName ? String(officialName).trim() : null;

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

    if (payload.name && !payload.slug) {
      payload.slug = slugify(payload.name);
    }

    const updated = await Country.findByIdAndUpdate(id, payload, { new: true, runValidators: true }).lean();
    if (!updated) return res.status(404).json({ error: "País no encontrado" });

    return res.json(updated);
  } catch (err) {
    return res.status(500).json({ error: "Error actualizando país" });
  }
};

// Eliminar
exports.deleteCountry = async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await Country.findByIdAndDelete(id).lean();
    if (!deleted) return res.status(404).json({ error: "País no encontrado" });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: "Error eliminando país" });
  }
};
