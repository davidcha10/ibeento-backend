const { Schema, model } = require("mongoose");

const countrySchema = new Schema(
  {
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

    iso2: { type: String, required: true, unique: true, uppercase: true, minlength: 2, maxlength: 2 },
    phoneCode: { type: String, trim: true },
    type: { type: String, default: "country", trim: true },
    typeCode: { type: String, default: null, trim: true },
    adminLevel: { type: Number, default: null },
    parentCountryId: { type: Schema.Types.ObjectId, ref: "Country", default: null },
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

countrySchema.index({ source: 1, externalId: 1 }, { unique: true, sparse: true });

countrySchema.methods.getDisplayName = function (locale) {
  if (this.names && this.names.get && this.names.get(locale)) {
    return this.names.get(locale);
  }
  return this.name;
};

countrySchema.methods.getDisplayOfficialName = function (locale) {
  if (this.officialNames && this.officialNames.get && this.officialNames.get(locale)) {
    return this.officialNames.get(locale);
  }
  return this.officialName || this.name;
};

countrySchema.methods.getDisplaySlug = function (locale) {
  if (this.slugs && this.slugs.get && this.slugs.get(locale)) {
    return this.slugs.get(locale);
  }
  return this.slug;
};

module.exports = model("Country", countrySchema, "countries");
