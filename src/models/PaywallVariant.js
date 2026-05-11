const { Schema, model } = require('mongoose');

const paywallVariantSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 140 },
    analyticsKey: { type: String, required: true, trim: true, maxlength: 140, index: true },
    appearancePercent: { type: Number, required: true, min: 0, max: 100, default: 0 },
    isActive: { type: Boolean, default: false, index: true },
    code: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

paywallVariantSchema.index({ name: 1 }, { unique: true });
paywallVariantSchema.index({ analyticsKey: 1 }, { unique: true });
paywallVariantSchema.index({ isActive: 1, appearancePercent: -1, updatedAt: -1 });

module.exports = model('PaywallVariant', paywallVariantSchema);
