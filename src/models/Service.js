

`use strict`;

const { Schema, model } = require('mongoose');
const { BaseFields } = require('./shared/ServiceBaseFields');

// ---------------- Base (single collection: services) ----------------
const ServiceBaseSchema = new Schema(
  { ...BaseFields },
  {
    timestamps: true,
    collection: 'services',          
    discriminatorKey: 'serviceType',
  }
);

/** Virtual: duración total en minutos (replica la de BaseFieldsSchema) */
ServiceBaseSchema.virtual('durationMinutes').get(function () {
  const h = this.duration?.h ?? 0;
  const m = this.duration?.m ?? 0;
  return h * 60 + m;
});

/** Índices base (comparten todas las variantes) */
ServiceBaseSchema.index({ isActive: 1 });
ServiceBaseSchema.index({ 'location.primaryZoneId': 1, isActive: 1 });
ServiceBaseSchema.index({ 'location.zonePathIds': 1, isActive: 1 });
ServiceBaseSchema.index({ providerId: 1 });
ServiceBaseSchema.index({ activityId: 1, isActive: 1 });
ServiceBaseSchema.index(
  { 'location.geo': '2dsphere' },
  {
    partialFilterExpression: {
      'location.geo.type': 'Point',
      'location.geo.coordinates.0': { $exists: true },
      'location.geo.coordinates.1': { $exists: true },
    },
  }
);
ServiceBaseSchema.index(
  { 'startingPoint.geo': '2dsphere' },
  {
    partialFilterExpression: {
      'startingPoint.geo.type': 'Point',
      'startingPoint.geo.coordinates.0': { $exists: true },
      'startingPoint.geo.coordinates.1': { $exists: true },
    },
  }
);

/** Modelo base */
const Service = model('Service', ServiceBaseSchema);

// ---------------- Accommodation discriminator ----------------
const AccommodationSpecific = {
  accommodation: {
    unitType:   { type: String, enum: ['hotel_room','house','apartment'], default: 'hotel_room' },
    totalUnits: { type: Number, default: 1 },
    maxGuests: { type: Number, min: 0 },
    roomsNumber: { type: Number, min: 0 },
    rooms: [{
      name: { type: String, trim: true },
      beds: [{ type: { type: String, trim: true } }],
      bathrooms: [{ type: { type: String, trim: true } }]
    }],
    socialAreasIds: [{ type: Schema.Types.ObjectId, ref: 'SocialArea' }],
    checkIn: { type: String, trim: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
    checkOut: { type: String, trim: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
    minNights: { type: Number, min: 0 },
    maxNights: { type: Number, min: 0 },
    noticePeriod: { type: String, trim: true },
    availabilityWindow: { type: String, trim: true },
    amenitiesIds: [{ type: Schema.Types.ObjectId, ref: 'Amenity' }],
    wifiNetwork: { type: String, trim: true },
    wifiPassword: { type: String, trim: true },
    welcomeMessage: { type: String, trim: true },
    entryMethod: {
      type: String,
      enum: ['code', 'key', 'lockbox', 'reception', 'smart_lock', 'other'],
      default: 'other',
    },
    entryDetails: { type: String, trim: true },
    luggageStorage: { type: Boolean, default: false }
  }
};

const ServiceAccommodationSchema = new Schema(AccommodationSpecific);

const ServiceAccommodation = Service.discriminator('ServiceAccommodation', ServiceAccommodationSchema, 'accommodation');

// ---------------- Transport discriminator ----------------
const TransportSpecific = {
  waitTime: { type: Number, min: 0 },
  transport: {
    vehicleType: { type: String, trim: true },
    capacity:    { type: Number },

    schedule: [{
      kind:       { type: String, enum: ['daily','weekly','seasonal'], required: true },
      daysOfWeek: [{ type: String, enum: ['mon','tue','wed','thu','fri','sat','sun'] }],
      startTime:  { type: String },
      endTime:    { type: String },
      startDate:  { type: Date },
      endDate:    { type: Date }
    }],

    surcharges: [{
      name:       { type: String, trim: true },
      daysOfWeek: [{ type: String, enum: ['mon','tue','wed','thu','fri','sat','sun'] }],
      startTime:  { type: String },
      endTime:    { type: String },
      feeType:    { type: String, enum: ['flat','percent'], default: 'flat' },
      amount:     { type: Number }
    }]
  }
};

const ServiceTransportSchema = new Schema(TransportSpecific);
const ServiceTransport = Service.discriminator('ServiceTransport', ServiceTransportSchema, 'transport');

// ---------------- Experience discriminator ----------------
const ExperienceSpecific = {
  waitTime: { type: Number, min: 0 },
  experience: {
    durationHours:   { type: Number },
    groupSize:       { type: Number },
    minParticipants: { type: Number },
    languages:       [{ type: String, trim: true }],
    amenitiesIds:    [{ type: Schema.Types.ObjectId, ref: 'Amenity' }],
    whatGuestsBring: { type: String, trim: true },
    schedule: [{
      kind:       { type: String, enum: ['daily','weekly','seasonal'], required: true },
      daysOfWeek: [{ type: String, enum: ['mon','tue','wed','thu','fri','sat','sun'] }],
      startTime:  { type: String },
      endTime:    { type: String },
      startDate:  { type: Date },
      endDate:    { type: Date }
    }]
  }
};

const ServiceExperienceSchema = new Schema(ExperienceSpecific);
const ServiceExperience = Service.discriminator('ServiceExperience', ServiceExperienceSchema, 'experience');

// ---------------- Exports ----------------
module.exports = {
  Service,
  ServiceAccommodation,
  ServiceTransport,
  ServiceExperience,
};
