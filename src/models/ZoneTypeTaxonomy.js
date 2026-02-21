const { Schema, model } = require('mongoose');

const zoneTypeTaxonomySchema = new Schema(
  {
    qid: { type: String, required: true, unique: true, uppercase: true, trim: true },
    canonicalType: {
      type: String,
      required: true,
      enum: ['country', 'region', 'province', 'emirate', 'city', 'town', 'village', 'commune', 'neighborhood', 'locality', 'district', 'subdistrict'],
      trim: true
    },
    typeCode: { type: String, required: true, trim: true },
    wikidataName: { type: String, trim: true, default: null },

    labels: {
      type: Map,
      of: String,
      default: {}
    },

    countryOverrides: {
      type: [
        new Schema(
          {
            countryIso2: { type: String, uppercase: true, trim: true, default: null },
            countryQid: { type: String, uppercase: true, trim: true, default: null },
            labels: {
              type: Map,
              of: String,
              default: {}
            }
          },
          { _id: false }
        )
      ],
      default: []
    },

    active: { type: Boolean, default: true },
    priority: { type: Number, default: 100 }
  },
  { timestamps: true }
);

zoneTypeTaxonomySchema.index({ canonicalType: 1, typeCode: 1, active: 1, priority: 1 });

module.exports = model('ZoneTypeTaxonomy', zoneTypeTaxonomySchema, 'zone_type_taxonomy');
