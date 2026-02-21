const { Schema, model, Types } = require('mongoose');

const TX_PROVIDERS = ['stripe', 'apple', 'google', 'manual', 'other'];
const TX_EVENT_TYPES = [
  'purchase',
  'renewal',
  'refund',
  'chargeback',
  'failed_payment',
  'trial_started',
  'trial_converted',
  'upgrade',
  'downgrade',
  'subscription_created',
  'subscription_updated',
  'subscription_canceled',
];
const TX_STATUS = [
  'pending',
  'succeeded',
  'failed',
  'refunded',
  'partially_refunded',
  'canceled',
  'disputed',
];
const PLAN_INTERVALS = ['day', 'week', 'month', 'year', 'lifetime', 'unknown'];

const billingTransactionSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: 'User', required: true, index: true },

    provider: { type: String, enum: TX_PROVIDERS, required: true, index: true },
    providerCustomerId: { type: String, trim: true, index: true },
    providerSubscriptionId: { type: String, trim: true, index: true },
    providerInvoiceId: { type: String, trim: true, index: true },
    providerPaymentIntentId: { type: String, trim: true, index: true },
    webhookEventId: { type: String, trim: true, index: true },

    externalTransactionId: { type: String, trim: true, required: true },
    eventType: { type: String, enum: TX_EVENT_TYPES, required: true, index: true },
    status: { type: String, enum: TX_STATUS, required: true, index: true },

    plan: {
      planId: { type: String, trim: true, index: true },
      planName: { type: String, trim: true },
      interval: { type: String, enum: PLAN_INTERVALS, default: 'unknown' },
    },

    amount: {
      gross: { type: Number, default: 0 },
      fee: { type: Number, default: 0 },
      tax: { type: Number, default: 0 },
      net: { type: Number, default: 0 },
      currency: { type: String, trim: true, uppercase: true, default: 'USD' },
    },

    occurredAt: { type: Date, required: true, index: true },
    processedAt: { type: Date, default: Date.now },
    source: { type: String, trim: true, default: 'webhook' },

    metadata: { type: Map, of: String, default: {} },
    rawPayload: { type: Schema.Types.Mixed },
  },
  { timestamps: true, collection: 'billing_transactions' }
);

billingTransactionSchema.index({ provider: 1, externalTransactionId: 1 }, { unique: true });
billingTransactionSchema.index(
  { provider: 1, webhookEventId: 1 },
  { unique: true, partialFilterExpression: { webhookEventId: { $exists: true, $type: 'string' } } }
);
billingTransactionSchema.index({ userId: 1, occurredAt: -1 });
billingTransactionSchema.index({ 'plan.planId': 1, occurredAt: -1 });

module.exports = model('BillingTransaction', billingTransactionSchema);
module.exports.TX_PROVIDERS = TX_PROVIDERS;
module.exports.TX_EVENT_TYPES = TX_EVENT_TYPES;
module.exports.TX_STATUS = TX_STATUS;
