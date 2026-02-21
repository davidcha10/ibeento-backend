const mongoose = require('mongoose');
const { Schema } = mongoose;

const ServiceTagSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, trim: true },
    businessType: [
      {
        type: String,
        enum: ['accommodation', 'experience', 'food_drinks', 'transport'],
        required: true
      }
    ],
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
);

module.exports = mongoose.model('ServiceTag', ServiceTagSchema);