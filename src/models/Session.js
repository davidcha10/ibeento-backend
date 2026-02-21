const { Schema, model, Types } = require('mongoose');

const sessionSchema = new Schema({
  userId: { 
    type: Types.ObjectId, 
    ref: 'User', 
    required: true, 
    index: true 
  },
  refreshTokenHash: { type: String, required: true },
  userAgent: { type: String, default: '' },
  ip: { type: String, default: '' },
  expiresAt: { 
    type: Date, 
    required: true 
  },
  revokedAt: { type: Date }
}, { timestamps: true });

// TTL: elimina sesiones expiradas automáticamente
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = model('Session', sessionSchema);
