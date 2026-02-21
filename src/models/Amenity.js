const mongoose = require('mongoose');
const { Schema } = mongoose;

const AmenitySchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true, unique: true },
    icon: { type: String, trim: true }, // SVG file name
    businessTypes: [
      {
        type: String,
        enum: ['accommodation', 'experience', 'food_drinks', 'transport', 'practical'],
        required: true,
      },
    ],
    isActive: { type: Boolean, default: true }, // Soft delete flag
    order: { type: Number, default: 0 }, // UI ordering
  },
  { timestamps: true }
);

module.exports = mongoose.model('Amenity', AmenitySchema);