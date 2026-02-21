const { Schema, model } = require('mongoose');

const BusinessCategorySchema = new Schema(
  {
    businessType: { 
        type: String, 
        enum: ['accommodation', 'experience', 'transport', 'food_drinks', 'practical'], 
        required: true, 
        index: true 
    },

    name: { type: String, required: true, trim: true },

    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },

    icon: { type: String, default: null, trim: true },

    color: { type: String, default: null, trim: true },

    order: { type: Number, default: 0 },
    
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true, versionKey: false }
);

module.exports = model('BusinessCategory', BusinessCategorySchema);