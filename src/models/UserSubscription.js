const { Schema, model, Types } = require('mongoose');

const SUBSCRIPTION_PROVIDERS = ['stripe', 'apple', 'google', 'manual', 'other'];
const SUBSCRIPTION_STATUS = [
  'trialing',
  'active',
  'past_due',
  'incomplete',
  'paused',
  'canceled',
  'expired',
];
const PLAN_INTERVALS = ['day', 'week', 'month', 'year', 'lifetime', 'unknown'];

const userSubscriptionSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: 'User', required: true, unique: true, index: true },

    provider: { type: String, enum: SUBSCRIPTION_PROVIDERS, required: true, index: true },
    providerCustomerId: { type: String, trim: true, index: true },
    providerSubscriptionId: { type: String, trim: true, index: true },

    status: { type: String, enum: SUBSCRIPTION_STATUS, required: true, index: true },
    isPro: { type: Boolean, default: false, index: true },
    autoRenew: { type: Boolean, default: true },

    plan: {
      planId: { type: String, trim: true, index: true },
      planName: { type: String, trim: true },
      interval: { type: String, enum: PLAN_INTERVALS, default: 'unknown' },
      amount: { type: Number, default: 0 },
      currency: { type: String, trim: true, uppercase: true, default: 'USD' },
    },

    startedAt: { type: Date },
    trialEndsAt: { type: Date },
    currentPeriodStart: { type: Date },
    currentPeriodEnd: { type: Date, index: true },
    canceledAt: { type: Date },
    lastTransactionAt: { type: Date },

    metadata: { type: Map, of: String, default: {} },
  },
  { timestamps: true, collection: 'user_subscriptions' }
);

userSubscriptionSchema.index(
  { provider: 1, providerSubscriptionId: 1 },
  { unique: true, partialFilterExpression: { providerSubscriptionId: { $exists: true, $type: 'string' } } }
);
userSubscriptionSchema.index({ isPro: 1, status: 1 });

module.exports = model('UserSubscription', userSubscriptionSchema);
module.exports.SUBSCRIPTION_PROVIDERS = SUBSCRIPTION_PROVIDERS;
module.exports.SUBSCRIPTION_STATUS = SUBSCRIPTION_STATUS;
