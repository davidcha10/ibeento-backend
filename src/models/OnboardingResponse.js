const mongoose = require('mongoose');

const { Schema } = mongoose;

const OnboardingQuestionOptionSchema = new Schema(
  {
    id: { type: String, trim: true, required: true },
    label: { type: String, trim: true, default: '' },
  },
  { _id: false }
);

const OnboardingQuestionStepSchema = new Schema(
  {
    stepId: { type: String, trim: true, required: true },
    stepIndex: { type: Number, required: true, min: 1 },
    title: { type: String, trim: true, default: '' },
    selectionMode: { type: String, enum: ['single', 'multiple'], default: 'multiple' },
    options: { type: [OnboardingQuestionOptionSchema], default: [] },
    selectedOptionIds: { type: [String], default: [] },
    selectedOptionLabels: { type: [String], default: [] },
    reached: { type: Boolean, default: false },
    reachedAt: { type: Date, default: null },
    answered: { type: Boolean, default: false },
    answeredAt: { type: Date, default: null },
  },
  { _id: false }
);

const OnboardingResponseSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    sessionId: { type: String, trim: true, required: true, index: true },
    flowVersion: { type: String, trim: true, default: 'v1' },
    platform: { type: String, enum: ['web', 'ios', 'android', 'unknown'], default: 'web' },
    startedAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now, index: true },
    completedAt: { type: Date, default: null, index: true },
    maxStepIndex: { type: Number, default: 1, min: 1 },
    totalSteps: { type: Number, default: null, min: 1 },
    questionSteps: { type: [OnboardingQuestionStepSchema], default: [] },
  },
  { timestamps: true }
);

OnboardingResponseSchema.index({ sessionId: 1, flowVersion: 1 }, { unique: true });

module.exports = mongoose.model('OnboardingResponse', OnboardingResponseSchema);
