const { Schema, model, Types } = require('mongoose');

const socialImportLinkSchema = new Schema(
  {
    source: {
      type: String,
      enum: ['instagram', 'tiktok', 'social_import', 'unknown'],
      default: 'unknown',
      index: true,
    },
    normalizedUrl: { type: String, required: true, trim: true, unique: true, index: true },
    originalUrls: [{ type: String, trim: true }],
    postId: { type: String, trim: true, index: true },

    extraction: {
      status: {
        type: String,
        enum: ['pending', 'resolved', 'failed'],
        default: 'pending',
        index: true,
      },
      fetchedAt: { type: Date },
      method: { type: String, trim: true },
      rawMetaHash: { type: String, trim: true },
      candidates: [{
        name: { type: String, trim: true },
        context: { type: String, trim: true },
        type: {
          type: String,
          enum: ['exact_place', 'area_mentioned', 'alternative_location', 'context_only', 'unknown'],
          default: 'unknown',
        },
        confidence: { type: Number, min: 0, max: 1 },
        evidence: { type: String, trim: true },
      }],
      error: { type: String, trim: true },
    },

    resolvedActivities: [{
      activityId: { type: Types.ObjectId, ref: 'Activity', required: true },
      role: {
        type: String,
        enum: ['primary', 'secondary', 'context'],
        default: 'primary',
      },
      candidateType: {
        type: String,
        enum: ['exact_place', 'area_mentioned', 'alternative_location', 'context_only', 'unknown'],
        default: 'exact_place',
      },
      confidence: { type: Number, min: 0, max: 1 },
      status: {
        type: String,
        enum: ['pending_review', 'approved', 'rejected', 'merged'],
        default: 'pending_review',
      },
    }],

    usage: {
      shareCount: { type: Number, default: 0, min: 0 },
      uniqueUserCount: { type: Number, default: 0, min: 0 },
      lastSharedAt: { type: Date },
      users: [{
        userId: { type: Types.ObjectId, ref: 'User' },
        firstSharedAt: { type: Date },
        lastSharedAt: { type: Date },
        count: { type: Number, default: 0, min: 0 },
      }],
    },

    admin: {
      priorityScore: { type: Number, default: 0 },
      reviewed: { type: Boolean, default: false },
      reviewedAt: { type: Date },
      reviewedBy: { type: Types.ObjectId, ref: 'User' },
      notes: { type: String, trim: true },
    },
  },
  { timestamps: true }
);

socialImportLinkSchema.index({ source: 1, postId: 1 });
socialImportLinkSchema.index({ 'resolvedActivities.activityId': 1 });
socialImportLinkSchema.index({ 'usage.shareCount': -1, updatedAt: -1 });

module.exports = model('SocialImportLink', socialImportLinkSchema);
