const { Schema, model, Types, models } = require("mongoose");

const citySchema = new Schema(
  {
    countryId: { type: Types.ObjectId, ref: "Country", required: true },
    regionId: { type: Types.ObjectId, ref: "Region", default: null },

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

    type: { type: String, default: "city", trim: true },
    typeCode: { type: String, default: null, trim: true },
    adminLevel: { type: Number, default: null },
    timeZone: { type: String, default: null, trim: true },
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

citySchema.index({ source: 1, externalId: 1 }, { unique: true, sparse: true });
// Validación: si hay región, debe pertenecer al mismo país
citySchema.pre("validate", async function (next) {
  try {
    if (!this.regionId) return next();

    const Region = models.Region || require("./Region");
    const region = await Region.findById(this.regionId).select("countryId").lean();

    if (!region) return next(new Error("Region not found"));
    if (String(region.countryId) !== String(this.countryId)) {
      return next(new Error("City.countryId must match Region.countryId"));
    }

    next();
  } catch (err) {
    next(err);
  }
});

citySchema.methods.getDisplayName = function (locale) {
  if (this.names && this.names.get && this.names.get(locale)) {
    return this.names.get(locale);
  }
  return this.name;
};

citySchema.methods.getDisplaySlug = function (locale) {
  if (this.slugs && this.slugs.get && this.slugs.get(locale)) {
    return this.slugs.get(locale);
  }
  return this.slug;
};

citySchema.methods.getDisplayOfficialName = function (locale) {
  if (this.officialNames && this.officialNames.get && this.officialNames.get(locale)) {
    return this.officialNames.get(locale);
  }
  return this.officialName || this.name;
};

module.exports = model("City", citySchema);
