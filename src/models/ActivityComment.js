const { Schema, model, Types } = require('mongoose');

const activityCommentSchema = new Schema(
  {
    activityId: {
      type: Types.ObjectId,
      ref: 'Activity',
      required: true,
      index: true,
    },
    userId: {
      type: Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    text: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 1200,
    },
    authorNameSnapshot: {
      type: String,
      trim: true,
      maxlength: 120,
      default: '',
    },
    active: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  { timestamps: true }
);

activityCommentSchema.index({ activityId: 1, active: 1, createdAt: -1 });
activityCommentSchema.index({ userId: 1, createdAt: -1 });

module.exports = model('ActivityComment', activityCommentSchema, 'activity_comments');
