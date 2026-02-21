const { Schema, model } = require('mongoose');

const AnalyticsEventSchema = new Schema(
  {
    event: { type: String, required: true, trim: true, maxlength: 120, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    sessionId: { type: String, trim: true, maxlength: 120, index: true },
    itineraryId: { type: Schema.Types.ObjectId, ref: 'Itinerary', index: true },
    source: { type: String, enum: ['web', 'ios', 'android', 'server'], default: 'web', index: true },
    platform: { type: String, enum: ['web', 'ios', 'android'], default: 'web', index: true },
    pathname: { type: String, trim: true, maxlength: 300, index: true },
    step: { type: String, trim: true, maxlength: 120 },
    success: { type: Boolean, default: true },
    metadata: { type: Schema.Types.Mixed, default: {} },
    occurredAt: { type: Date, default: Date.now, index: true },
    userAgent: { type: String, trim: true, maxlength: 500 },
    ipHash: { type: String, trim: true, maxlength: 128 },
  },
  { timestamps: true }
);

AnalyticsEventSchema.index({ event: 1, occurredAt: -1 });
AnalyticsEventSchema.index({ source: 1, occurredAt: -1 });
AnalyticsEventSchema.index({ userId: 1, occurredAt: -1 });
AnalyticsEventSchema.index({ sessionId: 1, occurredAt: -1 });

module.exports = model('AnalyticsEvent', AnalyticsEventSchema);
