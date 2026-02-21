const { Schema, model, Types } = require("mongoose");

const regionSchema = new Schema(
  {
    countryId: { type: Types.ObjectId, ref: "Country", required: true },
    parentRegionId: { type: Types.ObjectId, ref: "Region", default: null },

    name: { type: String, required: true, trim: true },

    names: {
      type: Map,
      of: String,
      default: {}
    },

    type: { type: String, default: "region", trim: true },
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

regionSchema.index({ source: 1, externalId: 1 }, { unique: true, sparse: true });
regionSchema.methods.getDisplayName = function (locale) {
  if (this.names && this.names.get && this.names.get(locale)) {
    return this.names.get(locale);
  }
  return this.name;
};

regionSchema.methods.getDisplaySlug = function (locale) {
  if (this.slugs && this.slugs.get && this.slugs.get(locale)) {
    return this.slugs.get(locale);
  }
  return this.slug;
};

module.exports = model("Region", regionSchema);
