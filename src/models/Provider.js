const mongoose = require('mongoose');
const { Schema, Types } = mongoose;

/* ==== ENUMS ==== */
const enumStatus = ['draft', 'active', 'blocked'];
const enumProviderType = ['individual', 'business'];

/* ==== SUBSCHEMAS ==== */
const GeoPointSchema = new Schema({
  type: { type: String, enum: ['Point'], default: 'Point' },
  coordinates: { type: [Number], required: true }, // [lng, lat]
  name: String
}, { _id: false });

const BaseLocationSchema = new Schema({
  addressLine1: String,
  cityId:    { type: Types.ObjectId, ref: 'City' },
  regionId:  { type: Types.ObjectId, ref: 'Region' },
  countryId: { type: Types.ObjectId, ref: 'Country' },
  geo: GeoPointSchema,
  coverageRadiusKm: { type: Number, default: 50 },
  timezone: { type: String, default: 'America/Bogota' }
}, { _id: false });

const PayoutSchema = new Schema({
  defaultCurrency: { type: String, default: 'USD', uppercase: true, minlength: 3, maxlength: 3 },
  stripeConnectId: String,
  paypalEmail: { type: String, lowercase: true, trim: true },
  taxId: String,
  taxCountry: { type: String, uppercase: true, minlength: 2, maxlength: 2 }
}, { _id: false });

const RatingStatsSchema = new Schema({
  average: { type: Number, default: 0 },
  count: { type: Number, default: 0 },
  lastReviewAt: Date
}, { _id: false });

/* ==== PROVIDER PROFILE ==== */
const ProviderProfileSchema = new Schema({
  userId: { type: Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, trim: true }, // visible si es negocio
  isPublicBusiness: { type: Boolean, default: false }, // controla visibilidad pública
  type: { type: String, enum: enumProviderType, default: 'individual' },
  status: { type: String, enum: enumStatus, default: 'draft', index: true },

  baseLocation: BaseLocationSchema,
  payout: PayoutSchema,
  rating: RatingStatsSchema,

  tags: [{ type: String, trim: true, lowercase: true, maxlength: 40 }]
}, { timestamps: true });

ProviderProfileSchema.index({ 'baseLocation.geo': '2dsphere' });
ProviderProfileSchema.index({ status: 1, 'baseLocation.countryId': 1 });

module.exports = mongoose.model('ProviderProfile', ProviderProfileSchema);