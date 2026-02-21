const mongoose = require('mongoose');
const { Schema } = mongoose;

const CancellationPolicySchema = new Schema(
  {
    name: { type: String, required: true, trim: true }, // Flexible, Moderate, Firm, Strict
    slug: { type: String, required: true, unique: true, trim: true },
    description: { type: String, trim: true },

    businessTypes: [
      { type: String, enum: ['accommodation', 'experience', 'food_drinks', 'transport'], required: true }
    ],

    allowFreeCancellationWithinHoursFromBooking: { type: Number, default: 0 }, // Ej. 24


    rules: [
      {
        stage: { type: String, enum: ['free', 'partial', 'no_refund'], required: true },
        label: { type: String, required: true }, // e.g. "Until 5 days before check-in"
        fromHoursBeforeStart: { type: Number, required: true }, // e.g. 120 (5 days)
        toHoursBeforeStart: { type: Number, required: true }, // e.g. 24
        refundPercentage: { type: Number, required: true } // e.g. 100, 50, 0
      }
    ],

    order: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

CancellationPolicySchema.index({ isActive: 1, order: 1 });
CancellationPolicySchema.index({ businessTypes: 1 });

module.exports = mongoose.model('CancellationPolicy', CancellationPolicySchema);