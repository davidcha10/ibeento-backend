const mongoose = require('mongoose');
const { Schema } = mongoose;

const userFavoriteSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    // The type of favorite (required)
    type: {
      type: String,
      required: true,
      enum: ['activity', 'experience', 'accommodation', 'transport', 'food_drinks'], // extensible
    },

    serviceId: { type: Schema.Types.ObjectId, ref: 'Service' },

    activityId: { type: Schema.Types.ObjectId, ref: 'Activity' },

    // Optional contextual data to help with personalization
    cityId: { type: Schema.Types.ObjectId, ref: 'City' },
    regionId: { type: Schema.Types.ObjectId, ref: 'Region' },
    countryId: { type: Schema.Types.ObjectId, ref: 'Country' },
  },
  { timestamps: true }
);

// Prevent duplicates of the same favorite per user
userFavoriteSchema.index(
  { userId: 1, type: 1, serviceId: 1, activityId: 1 },
  { unique: true }
);

module.exports = mongoose.model('UserFavorite', userFavoriteSchema);
