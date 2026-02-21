const { Schema, model } = require('mongoose');

const ServiceRequirementItemSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true, unique: true, index: true },
    businessTypes: [
      {
        type: String,
        enum: ['accommodation', 'experience', 'food_drinks', 'transport'],
        required: true
      }
    ],
    type: {
      type: String,
      enum: ['boolean', 'text_input', 'file_upload', 'digital_signature', 'acknowledge_only', 'multi_select'],
      required: true
    },
    description: { type: String, trim: true },
    icon: { type: String, trim: true },
    order: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    deletedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

module.exports = model('ServiceRequirementItem', ServiceRequirementItemSchema);