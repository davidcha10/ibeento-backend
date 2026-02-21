const mongoose = require('mongoose');
const { Schema } = mongoose;

const BusinessUnitSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true }, // propietario
    entityType: { type: String, enum: ['individual', 'business'] ,default: 'individual' }, // true = empresa, false = individual

    businessType: {
      type: String,
      enum: ['accommodation', 'experience', 'food_drinks', 'transport', 'practical_services'],
      index: true,
    },

    businessCategory: { type: String, trim: true }, // hotel, restaurant, tour company, etc.
    businessName: { type: String, trim: true },
    description: { type: String, trim: true },
    logo: { type: String, trim: true },

    locationData: {
      address: { type: String, trim: true },
      cityId: { type: Schema.Types.ObjectId, ref: 'City' },
      regionId: { type: Schema.Types.ObjectId, ref: 'Region' },
      countryId: { type: Schema.Types.ObjectId, ref: 'Country' },
      geo: {
        type: { type: String, enum: ['Point'], default: 'Point' },
        coordinates: { type: [Number], index: '2dsphere' },
        details: {type: String, trim: true}
      },
    },


    contact: {
      phone: { type: String, match: /^[0-9+\-() ]{7,20}$/ },
      email: { type: String, match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ },
    },

    media: [{
      url: { type: String, required: true, trim: true, match: /^https?:\/\/.+/ },
      type: { type: String, enum: ['image','video'], default: 'image' },
      category: { type: String, enum: ['cover','gallery','menu','room','promo','other'], default: 'gallery' },
      caption: { type: String, trim: true },
      order: { type: Number, default: 0 }
    }],

    isVerified: { type: Boolean, default: false },
    status: { type: String, enum: ['draft','active', 'inactive', 'suspended'], default: 'active' },
  },
  { timestamps: true, minimize: false }
);

// Indexes for optimized queries
BusinessUnitSchema.index({ 'locationData.countryId': 1, 'locationData.regionId': 1, 'locationData.cityId': 1 });
BusinessUnitSchema.index({ user: 1, businessType: 1 });

module.exports = mongoose.model('BusinessUnit', BusinessUnitSchema);