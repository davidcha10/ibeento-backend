const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const ServiceRuleSchema = new Schema({
  name: { type: String, required: true, trim: true },
  slug: { type: String, required: true, trim: true, unique: true },
  businessTypes: [{ type: String, enum: ['accommodation', 'experience', 'food_drinks', 'transport'], required: true }],
  icon: { type: String, trim: true },
  order: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

module.exports = mongoose.model('ServiceRule', ServiceRuleSchema);