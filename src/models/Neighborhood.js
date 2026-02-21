const { Schema, model, Types, models } = require("mongoose");

const neighborhoodSchema = new Schema(
  {
    countryId: { type: Types.ObjectId, ref: "Country", required: true },
    regionId: { type: Types.ObjectId, ref: "Region", default: null },
    cityId: { type: Types.ObjectId, ref: "City", required: true },

    name: { type: String, required: true, trim: true },

    names: {
      type: Map,
      of: String,
      default: {}
    },
    officialName: { type: String, default: null, trim: true },
    officialNames: {
      type: Map,
      of: String,
      default: {}
    },

    type: { type: String, default: "neighborhood", trim: true },
    typeCode: { type: String, default: null, trim: true },
    adminLevel: { type: Number, default: null },
    source: { type: String, default: null, trim: true },
    externalId: { type: String, default: null, trim: true },
    cover: { type: String, default: null, trim: true },

    slug: { type: String, required: true, unique: true, trim: true },

    slugs: {
      type: Map,
      of: String,
      default: {}
    },

    active: { type: Boolean, default: true },
    priority: { type: Number, default: 100 }
  },
  { timestamps: true }
);

neighborhoodSchema.index({ source: 1, externalId: 1 }, { unique: true, sparse: true });
// Validación: ciudad debe pertenecer al mismo país/region (si aplica)
neighborhoodSchema.pre("validate", async function (next) {
  try {
    if (!this.cityId) return next();

    const City = models.City || require("./City");
    const city = await City.findById(this.cityId).select("countryId regionId").lean();

    if (!city) return next(new Error("City not found"));
    if (String(city.countryId) !== String(this.countryId)) {
      return next(new Error("Neighborhood.countryId must match City.countryId"));
    }
    if (this.regionId && city.regionId && String(city.regionId) !== String(this.regionId)) {
      return next(new Error("Neighborhood.regionId must match City.regionId"));
    }

    next();
  } catch (err) {
    next(err);
  }
});

neighborhoodSchema.methods.getDisplayName = function (locale) {
  if (this.names && this.names.get && this.names.get(locale)) {
    return this.names.get(locale);
  }
  return this.name;
};

neighborhoodSchema.methods.getDisplayOfficialName = function (locale) {
  if (this.officialNames && this.officialNames.get && this.officialNames.get(locale)) {
    return this.officialNames.get(locale);
  }
  return this.officialName || this.name;
};

neighborhoodSchema.methods.getDisplaySlug = function (locale) {
  if (this.slugs && this.slugs.get && this.slugs.get(locale)) {
    return this.slugs.get(locale);
  }
  return this.slug;
};

module.exports = model("Neighborhood", neighborhoodSchema);
