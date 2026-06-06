const { Schema, model } = require('mongoose');

const ITEM_STATUS = [
  'draft',       // El usuario apenas está explorando
  'booked',      // Tiene servicios reservados pero no ha iniciado
  'in_progress', // El viaje está ocurriendo
  'completed'    // El viaje terminó
];

const BOOKING_STATUS = [
  'none',       // sin gestión con proveedor
  'requested',  // solicitud enviada / pendiente
  'confirmed',  // confirmado por proveedor
  'rejected',   // solicitud rechazada
  'cancelled'   // cancelado por el usuario o proveedor
];

const PAYMENT_STATUS = [
  'none',
  'pending',
  'authorized',
  'paid',
  'failed',
  'cancelled',
  'refunded',
  'partially_refunded'
];

const itineraryItemSchema = new Schema(
  {
    itineraryId: { type: Schema.Types.ObjectId, ref: 'Itinerary', required: true },

    serviceId: { type: Schema.Types.ObjectId, ref: 'Service' },
    activityId: { type: Schema.Types.ObjectId, ref: 'Activity' },

    customData: {
      kind: { type: String, enum: ['custom', 'flight'], default: 'custom' },
      activityCategoryId:   { type: Schema.Types.ObjectId, ref: 'ActivityCategory' },
      title: { type: String, trim: true },
      description:   { type: String, trim: true },
      flight: {
        flightNumber: { type: String, trim: true },
        manualEntry: { type: Boolean, default: false },
        provider: { type: String, trim: true },
        airlineName: { type: String, trim: true },
        airlineIata: { type: String, trim: true },
        airlineIcao: { type: String, trim: true },
        status: { type: String, trim: true },
        aircraftModel: { type: String, trim: true },
        durationMinutes: { type: Number, min: 0 },
        departure: {
          iata: { type: String, trim: true },
          icao: { type: String, trim: true },
          timeZone: { type: String, trim: true },
          terminal: { type: String, trim: true },
          gate: { type: String, trim: true },
          scheduledLocal: { type: String, trim: true },
          estimatedLocal: { type: String, trim: true },
          scheduledUtc: { type: String, trim: true },
          estimatedUtc: { type: String, trim: true },
        },
        arrival: {
          iata: { type: String, trim: true },
          icao: { type: String, trim: true },
          timeZone: { type: String, trim: true },
          terminal: { type: String, trim: true },
          gate: { type: String, trim: true },
          baggage: { type: String, trim: true },
          scheduledLocal: { type: String, trim: true },
          estimatedLocal: { type: String, trim: true },
          scheduledUtc: { type: String, trim: true },
          estimatedUtc: { type: String, trim: true },
        },
        lastLookupAt: { type: String, trim: true },
      },
    },

    status: { type: String, enum: ITEM_STATUS, default: 'draft' },
    bookingStatus: { type: String, enum: BOOKING_STATUS, default: 'none', required: true },

    booking: {
      serviceSnapshot: {
        providerId: { type: Schema.Types.ObjectId, ref: 'ProviderProfile' },
        serviceType: { type: String, trim: true },
        title: { type: String, trim: true },
        pricing: {
          basePrice: { type: Number },
          currency: { type: String, trim: true },
          per: { type: String, trim: true }
        },
        duration: {
          d: { type: Number, min: 0, default: 0 },
          h: { type: Number, min: 0, default: 0 },
          m: { type: Number, min: 0, max: 59, default: 0 }
        },
        location: {
          countryId: { type: Schema.Types.ObjectId, ref: 'Country' },
          regionId: { type: Schema.Types.ObjectId, ref: 'Region' },
          cityId: { type: Schema.Types.ObjectId, ref: 'City' },
          timeZone: { type: String, trim: true },
          address: { type: String, trim: true },
          geo: {
            type: { type: String, enum: ['Point'] },
            coordinates: { type: [Number], default: undefined },
          }
        },
        startingPoint: {
          address: { type: String, trim: true },
          details: { type: String, trim: true },
          timeZone: { type: String, trim: true },
          geo: {
            type: { type: String, enum: ['Point'] },
            coordinates: { type: [Number], default: undefined },
          }
        },
        capturedAt: { type: Date }
      },
      external: {
        providerBookingId: { type: String, trim: true },
        confirmationCode: { type: String, trim: true },
        bookingUrl: { type: String, trim: true }
      },
      schedule: {
        startDate: { type: Date },
        endDate: { type: Date },
        timeZone: { type: String, trim: true }
      },
      guestCheckIn: {
        guests: [
          {
            firstName: { type: String, trim: true },
            secondName: { type: String, trim: true },
            firstLastName: { type: String, trim: true },
            secondLastName: { type: String, trim: true },
            dateOfBirth: { type: Date },
            IdType: { type: String, trim: true },
            Id: { type: String, trim: true },
            nationality: { type: String, trim: true },
            role: { type: String, enum: ['Main guest', 'Guest'] },
            invoiceInformation: {
              email: { type: String, trim: true, lowercase: true },
              cellphone: { type: String, trim: true },
              address: { type: String, trim: true },
            },
            visitors: [
              {
                name: { type: String, trim: true },
                document: { type: String, trim: true },
              },
            ],
            regulation: {
              residence: {
                value: { type: String, trim: true },
                countryCode: { type: String, trim: true },
                countryName: { type: String, trim: true },
                cityCode: { type: String, trim: true },
                cityName: { type: String, trim: true },
              },
              origin: {
                value: { type: String, trim: true },
                countryCode: { type: String, trim: true },
                countryName: { type: String, trim: true },
                cityCode: { type: String, trim: true },
                cityName: { type: String, trim: true },
              },
              destination: {
                value: { type: String, trim: true },
                countryCode: { type: String, trim: true },
                countryName: { type: String, trim: true },
                cityCode: { type: String, trim: true },
                cityName: { type: String, trim: true },
              },
            },
          }
        ],
        visitors: [
          {
            name: { type: String, trim: true },
            document: { type: String, trim: true },
            role: { type: String, enum: ['Visitor'], default: 'Visitor' },
            ownerRole: { type: String, enum: ['Main guest', 'Guest'] },
            ownerIndex: { type: Number, min: 0, default: 0 },
          },
        ],
        dataTreatmentConsent: {
          accepted: { type: Boolean, default: false },
          acceptedAt: { type: Date },
          policyUrl: { type: String, trim: true },
          policyText: { type: String, trim: true },
        },
        apartmentRulesConsent: {
          accepted: { type: Boolean, default: false },
          acceptedAt: { type: Date },
          policyUrl: { type: String, trim: true },
          policyText: { type: String, trim: true },
        },
        submittedBy: {
          userId: { type: Schema.Types.ObjectId, ref: 'User' },
          email: { type: String, trim: true, lowercase: true },
          name: { type: String, trim: true },
        },
        signature: { type: Schema.Types.Mixed, default: null },
        completedAt: { type: Date }
      },
      reservedAt: { type: Date },
      confirmedAt: { type: Date },
      cancelledAt: { type: Date },
      notes: { type: String, trim: true }
    },

    payment: {
      status: {
        type: String,
        enum: PAYMENT_STATUS,
        default: 'none'
      },
      provider: {
        type: String,
        enum: ['none', 'stripe', 'manual', 'other'],
        default: 'none'
      },
      amount: { type: Number },
      currency: { type: String, trim: true },
      feeAmount: { type: Number },
      netAmount: { type: Number },
      checkoutSessionId: { type: String, trim: true },
      paymentIntentId: { type: String, trim: true },
      chargeId: { type: String, trim: true },
      billingTransactionId: { type: Schema.Types.ObjectId, ref: 'BillingTransaction' },
      paidAt: { type: Date },
      refundedAt: { type: Date },
      raw: { type: Schema.Types.Mixed }
    },

    pricingSelection: {
      mode: { type: String, enum: ['rule', 'grouped', 'travelers', 'manual'] },
      ruleId: { type: String, trim: true },
      label: { type: String, trim: true },
      amount: { type: Number },
      currency: { type: String, trim: true },
      groups: [
        {
          guestType: { type: String, enum: ['adults', 'children', 'babies', 'all'] },
          count: { type: Number, min: 0 },
          ruleId: { type: String, trim: true },
          label: { type: String, trim: true },
          ageLabel: { type: String, trim: true },
        }
      ],
      travelers: [
        {
          travelerId: { type: String, trim: true },
          travelerLabel: { type: String, trim: true },
          travelerAge: { type: Number, min: 0 },
          guestType: { type: String, enum: ['adults', 'children', 'babies', 'all'] },
          ruleId: { type: String, trim: true },
          label: { type: String, trim: true },
          ageLabel: { type: String, trim: true },
        }
      ],
    },

    // Resolved geo context for routing/maps at itinerary-item level.
    // geo: canonical activity coordinates
    // startPointGeo: where user should actually start (defaults to geo)
    location: {
      countryId: { type: Schema.Types.ObjectId, ref: 'Country' },
      regionId: { type: Schema.Types.ObjectId, ref: 'Region' },
      cityId: { type: Schema.Types.ObjectId, ref: 'City' },
      timeZone: { type: String, trim: true },
      address: { type: String, trim: true },
      geo: {
        type: { type: String, enum: ['Point'] },
        coordinates: { type: [Number], default: undefined },
      },
      startPointAddress: { type: String, trim: true },
      startPointGeo: {
        type: { type: String, enum: ['Point'] },
        coordinates: { type: [Number], default: undefined },
      },
    },

    notes: { type: String, trim: true },

    timelineStartDate: { type: Date },
    timelineEndDate: { type: Date },

    guests: {
      adults:   { type: Number, min: 0, default: 0 },
      children: { type: Number, min: 0, default: 0 },
      babies:   { type: Number, min: 0, default: 0 },
      total:    { type: Number, min: 0, default: 0 }
    },


  },
  {
    timestamps: true,
    toJSON:   { virtuals: true },
    toObject: { virtuals: true }
  }
);

const normalizeGeoPoint = (raw) => {
  const coords = Array.isArray(raw)
    ? raw
    : (Array.isArray(raw?.coordinates) ? raw.coordinates : null);
  if (!coords || coords.length < 2) return undefined;
  const lng = Number(coords[0]);
  const lat = Number(coords[1]);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return undefined;
  return { type: 'Point', coordinates: [lng, lat] };
};

// Keep booking/payment only for items linked to a service.
itineraryItemSchema.pre('validate', function(next) {
  // Sanitize custom activity category and custom geo payloads.
  if (this.customData && typeof this.customData === 'object') {
    const categoryId = String(this.customData.activityCategoryId || '').trim();
    if (!categoryId) {
      this.customData.activityCategoryId = undefined;
    }
    // customData.location was deprecated. Location is now persisted in itineraryItem.location.
    this.customData.location = undefined;
  }

  // Defensive cleanup for itinerary-level geo point too.
  if (this.location && typeof this.location === 'object') {
    const normalizedGeo = normalizeGeoPoint(this.location.geo);
    if (normalizedGeo) this.location.geo = normalizedGeo;
    else this.location.geo = undefined;
    const normalizedStartPointGeo = normalizeGeoPoint(this.location.startPointGeo);
    if (normalizedStartPointGeo) this.location.startPointGeo = normalizedStartPointGeo;
    else this.location.startPointGeo = undefined;
  }

  if (!this.serviceId) {
    this.booking = undefined;
    this.payment = undefined;
  }
  next();
});

// Guardrail for direct findOneAndUpdate calls outside controllers.
itineraryItemSchema.pre('findOneAndUpdate', function(next) {
  const update = this.getUpdate() || {};
  const set = update.$set || {};
  const unset = update.$unset || {};
  const hasExplicitServiceInSet = Object.prototype.hasOwnProperty.call(set, 'serviceId');
  const hasExplicitServiceAtTop = Object.prototype.hasOwnProperty.call(update, 'serviceId');
  const hasExplicitServiceUnset = Object.prototype.hasOwnProperty.call(unset, 'serviceId');
  const serviceValue = hasExplicitServiceInSet ? set.serviceId : (hasExplicitServiceAtTop ? update.serviceId : undefined);
  const removingService = hasExplicitServiceUnset || serviceValue === undefined || serviceValue === null || serviceValue === '';

  if (hasExplicitServiceInSet || hasExplicitServiceAtTop || hasExplicitServiceUnset) {
    if (removingService) {
      update.$unset = { ...(update.$unset || {}), booking: 1, payment: 1 };
      if (update.$set) {
        delete update.$set.booking;
        delete update.$set.payment;
      }
      delete update.booking;
      delete update.payment;
    }
    this.setUpdate(update);
  }
  next();
});

// --- Derived movement policy for timeline (virtual, no persistido) ---
// 'hard_fixed'  -> no movible
// 'soft_request'-> movible con solicitud
// 'free'        -> movible libre
itineraryItemSchema.virtual('movePolicy').get(function () {
  if (this.bookingStatus === 'confirmed') return 'hard_fixed';
  if (this.bookingStatus === 'requested') return 'soft_request';
  return 'free';
});

// Helper estático para servicios / lógica fuera del doc
itineraryItemSchema.statics.deriveMovePolicy = function (item) {
  const status = (item.bookingStatus || 'none').toLowerCase();
  if (status === 'confirmed') return 'hard_fixed';
  if (status === 'requested') return 'soft_request';
  return 'free';
};

// Índices de apoyo para filtros y reporting
itineraryItemSchema.index({ category: 1, bookingStatus: 1 });
itineraryItemSchema.index({ itineraryId: 1, serviceId: 1 });
itineraryItemSchema.index({ itineraryId: 1, activityId: 1 });
itineraryItemSchema.index(
  { 'location.geo': '2dsphere' },
  {
    partialFilterExpression: {
      'location.geo.type': 'Point',
      'location.geo.coordinates.0': { $exists: true },
      'location.geo.coordinates.1': { $exists: true },
    },
  }
);
itineraryItemSchema.index(
  { 'location.startPointGeo': '2dsphere' },
  {
    partialFilterExpression: {
      'location.startPointGeo.type': 'Point',
      'location.startPointGeo.coordinates.0': { $exists: true },
      'location.startPointGeo.coordinates.1': { $exists: true },
    },
  }
);

module.exports = model('ItineraryItem', itineraryItemSchema);
module.exports.ITEM_STATUS = ITEM_STATUS;
module.exports.BOOKING_STATUS = BOOKING_STATUS;
module.exports.PAYMENT_STATUS = PAYMENT_STATUS;
