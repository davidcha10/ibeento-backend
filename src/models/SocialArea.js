const mongoose = require('mongoose');
const { Schema } = mongoose;

const SocialAreaSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true, unique: true },
    icon: { type: String, trim: true },
    order: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
);

module.exports = mongoose.model('SocialArea', SocialAreaSchema);