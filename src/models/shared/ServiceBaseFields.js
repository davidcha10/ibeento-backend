const { Schema } = require('mongoose');


const BaseFields = {

  BusinessUnitId: { type: Schema.Types.ObjectId, ref: 'BusinessUnit' },
  serviceName: { type: String, required: true, trim: true },
  serviceCategoryId: { type: Schema.Types.ObjectId, ref: 'ServiceCategory' },


  internalName: {type: String, trim: true},
  description: { type: String, trim: true },

  possibleRisksIds: [{ type: Schema.Types.ObjectId, ref: 'PossibleRiskItem' }],
  securityComplianceIds: [{ type: Schema.Types.ObjectId, ref: 'SecurityComplianceItem' }],
  requirementsIds: [{ type: Schema.Types.ObjectId, ref: 'ServiceRequirementItem' }],
  rulesIds: [{ type: Schema.Types.ObjectId, ref: 'ServiceRule' }],
  cancellationPolicyId: { type: Schema.Types.ObjectId, ref: 'CancellationPolicy' },
  waitTime: { type: Number, min: 0 },

















  providerId: { type: Schema.Types.ObjectId, ref: 'Provider', required: true },
  activityId: { type: Schema.Types.ObjectId, ref: 'Activity' },

  title:       { type: String, required: true, trim: true },

  location: {
    countryId: { type: Schema.Types.ObjectId, ref: 'Country' },
    regionId:  { type: Schema.Types.ObjectId, ref: 'Region'  },
    cityId:    { type: Schema.Types.ObjectId, ref: 'City'    },
    timeZone:  { type: String, trim: true },
    address:   { type: String, trim: true },
    geo: {
      type: { type: String, enum: ['Point'] },
      coordinates: { type: [Number], default: undefined } // [lng, lat]
    }
  },

  // Optional meeting point when it differs from the activity/service location.
  startingPoint: {
    address:  { type: String, trim: true },
    details:  { type: String, trim: true },
    timeZone: { type: String, trim: true },
    geo: {
      type: { type: String, enum: ['Point'] },
      coordinates: { type: [Number], default: undefined } // [lng, lat]
    }
  },

  pricing: {
    basePrice: { type: Number },
    currency:  { type: String, trim: true },
    per:       { type: String, enum: ['person','group'], default: 'person' }
  },

  timeWindow: {
    start: { type: String, trim: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
    end:   { type: String, trim: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ }
  },

  allowedGroupSize: {
    type: Object,
    validate: {
      validator: function(v) {
        if (!v) return true;                  // optional field
        if (v.min == null || v.max == null) return true; // only enforce when both exist
        return v.min < v.max;                 // strictly less than
      },
      message: 'allowedGroupSize.min must be less than allowedGroupSize.max'
    }
  },

  duration: {
    d: { type: Number, default: 0, min: 0},
    h: { type: Number, default: 0, min: 0 },
    m: { type: Number, default: 0, min: 0, max: 59 }
  },
  
  serviceType: { type: String, enum: ['experience', 'transport', 'accommodation'], required: true },

  isActive: { type: Boolean, default: true },
  tags:     [{ type: String, trim: true }],
  media: [{
    url:     { type: String, required: true, trim: true },
    type:    { type: String, enum: ['image','video','other'], default: 'image' },
    caption: { type: String, trim: true },
    order:   { type: Number, default: 0 } 
  }],

  status: { type: String, enum: ['draft','active', 'inactive', 'suspended'], default: 'active' },


};

const BaseFieldsSchema = new Schema(BaseFields, { _id: false });

// Virtual para obtener duración total en minutos
BaseFieldsSchema.virtual('durationMinutes').get(function() {
  const d = this.duration?.d ?? 0;
  const h = this.duration?.h ?? 0;
  const m = this.duration?.m ?? 0;
  return d * 1440 + h * 60 + m;
});

module.exports = { BaseFields, BaseFieldsSchema };
