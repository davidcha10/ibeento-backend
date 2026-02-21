const { Schema, model } = require('mongoose');

const ITINERARY_STATUS = [
  'draft',        
  'booked',      
  'in_progress', 
  'completed'    
];

const ITINERARY_SHARE_ROLE = ['viewer', 'editor'];
const ITINERARY_SHARE_STATUS = ['invited', 'accepted'];

const itinerarySchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    name: { type: String, trim: true, maxlength: 120 },

    tripStartDate: { type: Date },
    tripEndDate: { type: Date },

    status: {
      type: String,
      enum: ITINERARY_STATUS,
      default: 'draft'
    },

    destinations: {
      countries: [
        {
          countryId: { type: Schema.Types.ObjectId, ref: 'Country' }
        }
      ],
      regions: [
        {
          regionId: { type: Schema.Types.ObjectId, ref: 'Region' }
        }
      ],
      cities: [
        {
          cityId: { type: Schema.Types.ObjectId, ref: 'City' }
        }
      ]
    }
    ,
    visitPlaces: [
      {
        _id: { type: Schema.Types.Mixed },
        type: { type: String },
        label: { type: String },
        countryIso2: { type: String },
        country: { type: Schema.Types.Mixed },
        region: { type: Schema.Types.Mixed }
      }
    ],
    guests: {
      adults:   { type: Number, min: 0, default: 0 },
      children: { type: Number, min: 0, default: 0 },
      babies:   { type: Number, min: 0, default: 0 },
      total:    { type: Number, min: 0, default: 0 }
    },
    sharedWith: [
      {
        userId: { type: Schema.Types.ObjectId, ref: 'User' },
        email: { type: String, trim: true, lowercase: true },
        role: { type: String, enum: ITINERARY_SHARE_ROLE, default: 'viewer' },
        status: { type: String, enum: ITINERARY_SHARE_STATUS, default: 'invited' },
        invitedBy: { type: Schema.Types.ObjectId, ref: 'User' },
        invitedAt: { type: Date, default: Date.now },
        acceptedAt: { type: Date },
      }
    ]
  },
  { timestamps: true }
);

// Normalize guests counts and compute total
function normalizeGuests(obj) {
  if (!obj) return;
  const a = Math.max(0, Number(obj.adults || 0));
  const c = Math.max(0, Number(obj.children || 0));
  const b = Math.max(0, Number(obj.babies || 0));
  obj.adults = a; obj.children = c; obj.babies = b;
  obj.total = a + c + b;
}

itinerarySchema.pre('save', function(next) {
  if (this.guests) normalizeGuests(this.guests);
  next();
});

itinerarySchema.pre('findOneAndUpdate', function(next) {
  const update = this.getUpdate() || {};
  if (update.$set && update.$set.guests) {
    normalizeGuests(update.$set.guests);
  } else if (update.guests) {
    normalizeGuests(update.guests);
  }
  next();
});

itinerarySchema.index({ userId: 1, createdAt: -1 });
itinerarySchema.index({ 'sharedWith.userId': 1, 'sharedWith.status': 1 });
itinerarySchema.index({ 'sharedWith.email': 1, 'sharedWith.status': 1 });

module.exports = model('Itinerary', itinerarySchema);
module.exports.ITINERARY_STATUS = ITINERARY_STATUS;
module.exports.ITINERARY_SHARE_ROLE = ITINERARY_SHARE_ROLE;
module.exports.ITINERARY_SHARE_STATUS = ITINERARY_SHARE_STATUS;
