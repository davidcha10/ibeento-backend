const { Schema, model, Types } = require("mongoose");

const taxonomySnapshotSchema = new Schema(
  {
    canonicalType: { type: String, default: "zone", trim: true },
    typeCode: { type: String, default: null, trim: true },
    qid: { type: String, default: null, uppercase: true, trim: true },
    taxonomyId: { type: Types.ObjectId, ref: "ZoneTypeTaxonomy", default: null },
    taxonomyCandidates: {
      type: [
        new Schema(
          {
            qid: { type: String, uppercase: true, trim: true, required: true },
            steps: { type: Number, default: 0, min: 0 },
          },
          { _id: false }
        )
      ],
      default: []
    },
    numberOfSteps: { type: Number, default: null, min: 0 },
    displayTypeLabel: { type: String, default: null, trim: true },
    wikidataName: { type: String, default: null, trim: true },
    auditStatus: { type: String, enum: ["pending", "approved", "rejected"], default: "pending", trim: true },
  },
  { _id: false }
);

const zoneSchema = new Schema(
  {
    parentZoneId: { type: Types.ObjectId, ref: "Zone", default: null },
    parentCountryId: { type: Types.ObjectId, ref: "Zone", default: null },
    ancestry: [{ type: Types.ObjectId, ref: "Zone" }],

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

    slug: { type: String, required: true, trim: true },
    slugs: {
      type: Map,
      of: String,
      default: {}
    },

    taxonomySnapshot: {
      type: taxonomySnapshotSchema,
      default: () => ({})
    },
    level: { type: Number, default: null },
    adminLevel: { type: Number, default: null },

    source: { type: String, default: null, trim: true },
    externalId: { type: String, default: null, trim: true },
    cover: { type: String, default: null, trim: true },
    timeZone: { type: String, default: null, trim: true },

    geo: {
      type: {
        type: String,
        enum: ["Point"]
      },
      coordinates: {
        type: [Number],
        validate: {
          validator(v) {
            return !v || v.length === 2;
          },
          message: "geo.coordinates must be [lng, lat]"
        }
      }
    },

    active: { type: Boolean, default: true },
    audited: { type: Boolean, default: false },
    priority: { type: Number, default: 100 },

    // Discover preview guard: when true, external discover search for this zone
    // has already been executed at least once.
    discoverPreviewSearched: { type: Boolean, default: false }
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

zoneSchema.index({ parentZoneId: 1, slug: 1 }, { unique: true });
zoneSchema.index({ parentCountryId: 1, active: 1, "taxonomySnapshot.canonicalType": 1, priority: 1 });
zoneSchema.index({ ancestry: 1 });
zoneSchema.index({ source: 1, externalId: 1 }, { unique: true, sparse: true });
zoneSchema.index({ geo: "2dsphere" }, { sparse: true });

function defineSnapshotVirtual(virtualName, snapshotPath) {
  zoneSchema.virtual(virtualName)
    .get(function getVirtual() {
      const snapshot = this.taxonomySnapshot || {};
      const legacyValue =
        this?._doc && Object.prototype.hasOwnProperty.call(this._doc, virtualName)
          ? this._doc[virtualName]
          : null;
      return snapshot[snapshotPath] ?? legacyValue ?? null;
    })
    .set(function setVirtual(value) {
      if (!this.taxonomySnapshot || typeof this.taxonomySnapshot !== "object") {
        this.taxonomySnapshot = {};
      }
      this.taxonomySnapshot[snapshotPath] = value;
      if (this._doc && Object.prototype.hasOwnProperty.call(this._doc, virtualName)) {
        delete this._doc[virtualName];
      }
    });
}

defineSnapshotVirtual("canonicalType", "canonicalType");
defineSnapshotVirtual("typeCode", "typeCode");
defineSnapshotVirtual("qid", "qid");
defineSnapshotVirtual("taxonomyId", "taxonomyId");
defineSnapshotVirtual("numberOfSteps", "numberOfSteps");
defineSnapshotVirtual("displayTypeLabel", "displayTypeLabel");
defineSnapshotVirtual("wikidataName", "wikidataName");
defineSnapshotVirtual("auditStatus", "auditStatus");

// Backward-compatible aliases
defineSnapshotVirtual("type", "canonicalType");
defineSnapshotVirtual("typeQid", "qid");
defineSnapshotVirtual("zoneTypeTaxonomyId", "taxonomyId");

zoneSchema.methods.getDisplayName = function getDisplayName(locale) {
  if (this.names && this.names.get && this.names.get(locale)) {
    return this.names.get(locale);
  }
  return this.name;
};

zoneSchema.methods.getDisplayOfficialName = function getDisplayOfficialName(locale) {
  if (this.officialNames && this.officialNames.get && this.officialNames.get(locale)) {
    return this.officialNames.get(locale);
  }
  return this.officialName || this.name;
};

zoneSchema.methods.getDisplaySlug = function getDisplaySlug(locale) {
  if (this.slugs && this.slugs.get && this.slugs.get(locale)) {
    return this.slugs.get(locale);
  }
  return this.slug;
};

module.exports = model("Zone", zoneSchema, "zones");
