const { Schema, model } = require('mongoose');


const PossibleRiskItemSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true, unique: true, index: true },
    icon: { type: String, trim: true },
    businessType: [
      {
        type: String,
        enum: ['accommodation', 'experience', 'food_drinks', 'transport'],
        required: true
      }
    ],
    order:       { type: Number, default: 0 },
    isActive:    { type: Boolean, default: true },
    deletedAt:   { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = model('PossibleRiskItem', PossibleRiskItemSchema);