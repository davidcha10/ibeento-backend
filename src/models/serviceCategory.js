const { Schema, model } = require('mongoose');

const ServiceCategorySchema = new Schema({
  businessCategories: [
    { type: Schema.Types.ObjectId, ref: 'BusinessCategory', required: true }
  ],

  businessType: {
    type: String,
    enum: ['accommodation', 'experience', 'food_drinks', 'transport'],
    required: true
  },
  
  name: { type: String, required: true, trim: true },
  slug: { type: String, required: true, trim: true, unique: true },
  icon: { type: String, trim: true },
  order: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

ServiceCategorySchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});


module.exports = model('ServiceCategory', ServiceCategorySchema);