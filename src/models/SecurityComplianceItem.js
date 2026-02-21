const mongoose = require('mongoose');
const { Schema } = mongoose;

const SecurityComplianceItemSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true, unique: true },
    icon: { type: String, trim: true },
    businessType: [
      {
        type: String,
        enum: ['accommodation', 'experience', 'food_drinks', 'transport'],
        required: true
      }
    ],
    isActive: { type: Boolean, default: true },
    order: { type: Number, default: 0 }
  },
  { timestamps: true }
);

module.exports = mongoose.model('SecurityComplianceItem', SecurityComplianceItemSchema);