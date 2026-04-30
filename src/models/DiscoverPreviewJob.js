const { Schema, model } = require('mongoose');

const discoverProgressDestinationSchema = new Schema(
  {
    locationId: { type: String, trim: true },
    label: { type: String, trim: true },
    status: { type: String, trim: true, default: 'pending' },
    acceptedCount: { type: Number, default: 0 },
  },
  { _id: false }
);

const discoverPreviewJobSchema = new Schema(
  {
    jobId: { type: String, required: true, unique: true, index: true, trim: true },
    requestKey: { type: String, required: true, unique: true, index: true, trim: true },
    payload: { type: Schema.Types.Mixed, default: {} },

    status: {
      type: String,
      enum: ['queued', 'running', 'done', 'failed'],
      default: 'queued',
      index: true,
    },
    stage: { type: String, default: 'preparing', trim: true },
    message: { type: String, default: 'Preparing results...', trim: true },

    progress: {
      percent: { type: Number, default: 0 },
      destinationsTotal: { type: Number, default: 0 },
      destinationsCompleted: { type: Number, default: 0 },
      destinations: { type: [discoverProgressDestinationSchema], default: [] },
      currentDestinationId: { type: String, default: null },
      currentDestinationLabel: { type: String, default: null },
      currentDestinationIndex: { type: Number, default: null },
      currentStep: { type: String, default: null },
    },

    result: {
      data: { type: [Schema.Types.Mixed], default: null },
      meta: { type: Schema.Types.Mixed, default: null },
    },
    error: {
      message: { type: String, default: null, trim: true },
    },

    attempts: { type: Number, default: 0 },
    cycleStartedAt: { type: Date, default: () => new Date(), index: true },
    nextRunAt: { type: Date, default: () => new Date(), index: true },
    lockedAt: { type: Date, default: null, index: true },
    lockToken: { type: String, default: null },

    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    lastErrorAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    collection: 'discover_preview_jobs',
  }
);

discoverPreviewJobSchema.index({ status: 1, nextRunAt: 1, updatedAt: 1 });

module.exports = model('DiscoverPreviewJob', discoverPreviewJobSchema, 'discover_preview_jobs');
