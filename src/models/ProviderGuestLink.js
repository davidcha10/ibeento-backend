const mongoose = require('mongoose');
const { Schema, Types } = mongoose;

const PROVIDER_GUEST_LINK_STATUS = ['draft', 'sent', 'opened', 'completed', 'cancelled'];

const ProviderGuestLinkSchema = new Schema(
  {
    providerId: { type: Types.ObjectId, ref: 'ProviderProfile', required: true, index: true },
    serviceId: { type: Types.ObjectId, ref: 'Service', default: null },
    createdByUserId: { type: Types.ObjectId, ref: 'User', default: null, index: true },

    guestName: { type: String, required: true, trim: true, maxlength: 160 },

    checkInDate: { type: Date, default: null },
    checkOutDate: { type: Date, default: null },
    guestsCount: { type: Number, default: 1, min: 1, max: 30 },
    quotedValue: {
      amount: { type: Number, min: 0, default: null },
      currency: { type: String, trim: true, uppercase: true, default: null },
    },
    status: { type: String, enum: PROVIDER_GUEST_LINK_STATUS, default: 'draft', index: true },

    token: { type: String, required: true, unique: true, index: true },
    shareUrl: { type: String, required: true, trim: true },

    sentAt: { type: Date, default: null },
    openedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    openCount: { type: Number, default: 0, min: 0 },
    checkIn: {
      guests: [
        {
          firstName: { type: String, trim: true, default: null },
          secondName: { type: String, trim: true, default: null },
          firstLastName: { type: String, trim: true, default: null },
          secondLastName: { type: String, trim: true, default: null },
          dateOfBirth: { type: Date, default: null },
          IdType: { type: String, trim: true, default: null },
          Id: { type: String, trim: true, default: null },
          nationality: { type: String, trim: true, default: null },
          role: { type: String, enum: ['Main guest', 'Guest'], default: 'Guest' },
          invoiceInformation: {
            email: { type: String, trim: true, lowercase: true, default: null },
            cellphone: { type: String, trim: true, default: null },
            address: { type: String, trim: true, default: null },
          },
          visitors: [
            {
              name: { type: String, trim: true, default: null },
              document: { type: String, trim: true, default: null },
            },
          ],
          regulation: {
            residence: {
              value: { type: String, trim: true, default: null },
              countryCode: { type: String, trim: true, default: null },
              countryName: { type: String, trim: true, default: null },
              cityCode: { type: String, trim: true, default: null },
              cityName: { type: String, trim: true, default: null },
            },
            origin: {
              value: { type: String, trim: true, default: null },
              countryCode: { type: String, trim: true, default: null },
              countryName: { type: String, trim: true, default: null },
              cityCode: { type: String, trim: true, default: null },
              cityName: { type: String, trim: true, default: null },
            },
            destination: {
              value: { type: String, trim: true, default: null },
              countryCode: { type: String, trim: true, default: null },
              countryName: { type: String, trim: true, default: null },
              cityCode: { type: String, trim: true, default: null },
              cityName: { type: String, trim: true, default: null },
            },
          },
        }
      ],
      visitors: [
        {
          name: { type: String, trim: true, default: null },
          document: { type: String, trim: true, default: null },
          role: { type: String, enum: ['Visitor'], default: 'Visitor' },
          ownerRole: { type: String, enum: ['Main guest', 'Guest'], default: 'Main guest' },
          ownerIndex: { type: Number, min: 0, default: 0 },
        },
      ],
      dataTreatmentConsent: {
        accepted: { type: Boolean, default: false },
        acceptedAt: { type: Date, default: null },
        policyUrl: { type: String, trim: true, default: null },
        policyText: { type: String, trim: true, default: null },
      },
      apartmentRulesConsent: {
        accepted: { type: Boolean, default: false },
        acceptedAt: { type: Date, default: null },
        policyUrl: { type: String, trim: true, default: null },
        policyText: { type: String, trim: true, default: null },
      },
      submittedBy: {
        userId: { type: Types.ObjectId, ref: 'User', default: null },
        email: { type: String, trim: true, lowercase: true, default: null },
        name: { type: String, trim: true, default: null },
      },
      signature: { type: Schema.Types.Mixed, default: null },
      submittedAt: { type: Date, default: null },
    },
    convertedByUserId: { type: Types.ObjectId, ref: 'User', default: null, index: true },
    itineraryId: { type: Types.ObjectId, ref: 'Itinerary', default: null },
    itineraryItemId: { type: Types.ObjectId, ref: 'ItineraryItem', default: null },
  },
  { timestamps: true }
);

ProviderGuestLinkSchema.index({ providerId: 1, createdAt: -1 });
ProviderGuestLinkSchema.index({ providerId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('ProviderGuestLink', ProviderGuestLinkSchema);
