'use strict';

const { fetchFlightByNumber } = require('../services/flight-lookup.service');

exports.lookupByNumber = async (req, res) => {
  try {
    const flightNumber = String(req.query?.flightNumber || req.body?.flightNumber || '').trim();
    if (!flightNumber) {
      return res.status(400).json({ success: false, message: 'flightNumber is required' });
    }

    const data = await fetchFlightByNumber(flightNumber);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    const status = Number(error?.statusCode || error?.status || 500);
    const message = String(error?.message || '').trim() || 'Failed to lookup flight';
    return res.status(status).json({ success: false, message });
  }
};
