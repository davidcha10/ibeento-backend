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
    travelers: [
      {
        id: { type: String, trim: true },
        name: { type: String, trim: true, maxlength: 80 },
        age: { type: Number, min: 0, max: 120 },
      }
    ],
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

function normalizeTravelers(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((entry, index) => {
      const age = Number(entry?.age);
      const name = String(entry?.name || '').trim();
      return {
        id: String(entry?.id || `traveler_${index + 1}`).trim(),
        ...(name ? { name: name.slice(0, 80) } : {}),
        age: Number.isFinite(age) ? Math.max(0, Math.min(120, Math.round(age))) : 30,
      };
    })
    .filter((entry) => !!entry.id);
}

function deriveGuestsFromTravelers(list) {
  const travelers = normalizeTravelers(list);
  let adults = 0;
  let children = 0;
  let babies = 0;
  for (const traveler of travelers) {
    const age = Number(traveler.age);
    if (!Number.isFinite(age)) continue;
    if (age <= 2) babies += 1;
    else if (age <= 12) children += 1;
    else adults += 1;
  }
  return { adults, children, babies, total: travelers.length };
}

itinerarySchema.pre('save', function(next) {
  if (Array.isArray(this.travelers) && this.travelers.length) {
    this.travelers = normalizeTravelers(this.travelers);
    this.guests = deriveGuestsFromTravelers(this.travelers);
  }
  if (this.guests) normalizeGuests(this.guests);
  next();
});

itinerarySchema.pre('findOneAndUpdate', function(next) {
  const update = this.getUpdate() || {};
  if (update.$set && Array.isArray(update.$set.travelers)) {
    update.$set.travelers = normalizeTravelers(update.$set.travelers);
    update.$set.guests = deriveGuestsFromTravelers(update.$set.travelers);
  } else if (Array.isArray(update.travelers)) {
    update.travelers = normalizeTravelers(update.travelers);
    update.guests = deriveGuestsFromTravelers(update.travelers);
  }
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
