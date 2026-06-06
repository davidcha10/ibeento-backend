const { Schema, model } = require('mongoose');

const exchangeRateSnapshotSchema = new Schema(
  {
    key: { type: String, required: true, unique: true, trim: true, default: 'latest' },
    provider: { type: String, required: true, trim: true, default: 'frankfurter' },
    baseCurrency: { type: String, required: true, trim: true, uppercase: true, default: 'USD' },
    effectiveDate: { type: String, required: true, trim: true },
    fetchedAt: { type: Date, required: true },
    availableCurrencies: [{ type: String, trim: true, uppercase: true }],
    rates: {
      type: Map,
      of: Number,
      default: {},
    },
    scheduler: {
      lastScheduledRunDayKey: { type: String, trim: true, default: '' },
    },
  },
  { timestamps: true, minimize: false }
);

module.exports = model('ExchangeRateSnapshot', exchangeRateSnapshotSchema);
