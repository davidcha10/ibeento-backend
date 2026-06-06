const {
  getLatestExchangeRateSnapshot,
  syncLatestExchangeRates,
} = require('../services/exchange-rate-sync.service');

function serializeSnapshot(snapshot) {
  const rates = snapshot?.rates instanceof Map
    ? Object.fromEntries(snapshot.rates)
    : (snapshot?.rates && typeof snapshot.rates === 'object' ? snapshot.rates : {});

  return {
    provider: String(snapshot?.provider || 'frankfurter').trim() || 'frankfurter',
    baseCurrency: String(snapshot?.baseCurrency || 'USD').trim().toUpperCase() || 'USD',
    effectiveDate: String(snapshot?.effectiveDate || '').trim(),
    fetchedAt: snapshot?.fetchedAt || null,
    availableCurrencies: Array.isArray(snapshot?.availableCurrencies) ? snapshot.availableCurrencies : [],
    rates,
  };
}

exports.getLatest = async (_req, res) => {
  try {
    let snapshot = await getLatestExchangeRateSnapshot();
    let serialized = snapshot ? serializeSnapshot(snapshot) : null;
    const hasUsableRates = serialized && Object.keys(serialized.rates || {}).length > 0;

    if (!hasUsableRates) {
      await syncLatestExchangeRates({ trigger: 'endpoint_fallback' });
      snapshot = await getLatestExchangeRateSnapshot();
      serialized = snapshot ? serializeSnapshot(snapshot) : null;
    }

    if (!serialized || !Object.keys(serialized.rates || {}).length) {
      return res.status(503).json({
        success: false,
        message: 'Exchange rate snapshot unavailable and provider fallback failed',
      });
    }

    return res.status(200).json({
      success: true,
      data: serialized,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error?.message || 'Failed to load exchange rates',
    });
  }
};
