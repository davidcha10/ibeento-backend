const { Schema, model } = require('mongoose');

const BusinessCategorySchema = new Schema(
  {
    businessType: { 
        type: String, 
        enum: ['accommodation', 'experience', 'transport', 'food_drinks', 'practical_services'], 
        required: true, 
        index: true 
    },

    name: { type: String, required: true, trim: true },

    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },

    icon: { type: String, default: null, trim: true },

    color: { type: String, default: null, trim: true },

    order: { type: Number, default: 0 },

    // When true, providers can add multiple services from Wizard Step 5.
    multiservice: { type: Boolean, default: true },

    // Defines whether services under this category are delivered at a fixed place.
    serviceDeliveryMode: {
      type: String,
      enum: ['fixed_place', 'not_fixed_place', 'hybrid'],
      default: 'hybrid',
      index: true,
    },
    
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true, versionKey: false }
);

module.exports = model('BusinessCategory', BusinessCategorySchema);
