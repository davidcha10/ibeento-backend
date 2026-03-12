const mongoose = require('mongoose');
const { Schema, Types } = mongoose;

const complianceFieldSchema = new Schema(
  {
    path: { type: String, required: true, trim: true },
    required: { type: Boolean, default: false },
    appliesTo: {
      type: String,
      enum: ['main_guest', 'all_guests'],
      default: 'all_guests',
    },
  },
  { _id: false }
);

const compliancePackSchema = new Schema(
  {
    code: { type: String, required: true, trim: true, uppercase: true },
    version: { type: Number, required: true, min: 1 },
    countryIso2: { type: String, required: true, trim: true, uppercase: true },
    countryZoneId: { type: Types.ObjectId, ref: 'Zone', required: true, index: true },
    submissionMode: {
      type: String,
      enum: ['manual', 'api'],
      default: 'manual',
    },
    fields: { type: [complianceFieldSchema], default: [] },
    mapping: { type: Schema.Types.Mixed, default: {} },
    status: {
      type: String,
      enum: ['draft', 'active'],
      default: 'draft',
    },
  },
  { timestamps: true }
);

compliancePackSchema.index({ countryIso2: 1, code: 1, version: 1 }, { unique: true });

module.exports = mongoose.model('CompliancePack', compliancePackSchema, 'compliance_packs');
