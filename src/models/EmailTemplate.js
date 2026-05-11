const { Schema, model } = require('mongoose');

const emailTemplateSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 140, unique: true },
    key: { type: String, required: true, trim: true, maxlength: 140, unique: true, index: true },
    isActive: { type: Boolean, default: true, index: true },
    code: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

emailTemplateSchema.index({ isActive: 1, updatedAt: -1 });

module.exports = model('EmailTemplate', emailTemplateSchema);
