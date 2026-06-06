'use strict';

const axios = require('axios');
const tzLookup = require('tz-lookup');

const AIRLABS_BASE_URL = 'https://airlabs.co/api/v9';
const airportTimeZoneCache = new Map();

function getApiKey() {
  return String(process.env.AIRLABS_API_KEY || '').trim();
}

function normalizeFlightNumber(value = '') {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
}

function toTrimmedString(value) {
  const next = String(value || '').trim();
  return next || '';
}

function toIsoString(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toISOString();
}

function normalizeLookupPayload(raw = {}) {
  const flightNumber = normalizeFlightNumber(raw?.flight_iata || raw?.flight_icao || raw?.flight_number || '');
  const depScheduledUtc = toIsoString(raw?.dep_time_utc || raw?.dep_time);
  const depEstimatedUtc = toIsoString(raw?.dep_estimated_utc || raw?.dep_estimated);
  const arrScheduledUtc = toIsoString(raw?.arr_time_utc || raw?.arr_time);
  const arrEstimatedUtc = toIsoString(raw?.arr_estimated_utc || raw?.arr_estimated);
  const durationMinutes = Number(raw?.duration);

  return {
    provider: 'airlabs',
    flightNumber,
    airlineName: toTrimmedString(raw?.airline_name) || toTrimmedString(raw?.airline_iata) || toTrimmedString(raw?.airline_icao),
    airlineIata: toTrimmedString(raw?.airline_iata),
    airlineIcao: toTrimmedString(raw?.airline_icao),
    status: toTrimmedString(raw?.status),
    aircraftModel: toTrimmedString(raw?.model) || toTrimmedString(raw?.aircraft_icao),
    durationMinutes: Number.isFinite(durationMinutes) && durationMinutes >= 0 ? durationMinutes : null,
    departure: {
      iata: toTrimmedString(raw?.dep_iata),
      icao: toTrimmedString(raw?.dep_icao),
      timeZone: '',
      terminal: toTrimmedString(raw?.dep_terminal),
      gate: toTrimmedString(raw?.dep_gate),
      scheduledLocal: toTrimmedString(raw?.dep_time),
      estimatedLocal: toTrimmedString(raw?.dep_estimated),
      scheduledUtc: depScheduledUtc,
      estimatedUtc: depEstimatedUtc,
    },
    arrival: {
      iata: toTrimmedString(raw?.arr_iata),
      icao: toTrimmedString(raw?.arr_icao),
      timeZone: '',
      terminal: toTrimmedString(raw?.arr_terminal),
      gate: toTrimmedString(raw?.arr_gate),
      baggage: toTrimmedString(raw?.arr_baggage),
      scheduledLocal: toTrimmedString(raw?.arr_time),
      estimatedLocal: toTrimmedString(raw?.arr_estimated),
      scheduledUtc: arrScheduledUtc,
      estimatedUtc: arrEstimatedUtc,
    },
    lastLookupAt: new Date().toISOString(),
  };
}

async function fetchAirportTimeZone(iataCode) {
  const iata = toTrimmedString(iataCode).toUpperCase();
  if (!iata) return '';
  if (airportTimeZoneCache.has(iata)) {
    return airportTimeZoneCache.get(iata) || '';
  }

  const apiKey = getApiKey();
  const response = await axios.get(`${AIRLABS_BASE_URL}/airports`, {
    params: {
      api_key: apiKey,
      iata_code: iata,
    },
    timeout: 15000,
  });

  const airport = Array.isArray(response?.data?.response)
    ? response.data.response[0]
    : response?.data?.response;

  const lat = Number(airport?.lat);
  const lng = Number(airport?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    airportTimeZoneCache.set(iata, '');
    return '';
  }

  let timeZone = '';
  try {
    timeZone = String(tzLookup(lat, lng) || '').trim();
  } catch {
    timeZone = '';
  }
  airportTimeZoneCache.set(iata, timeZone);
  return timeZone;
}

async function fetchFlightByNumber(flightNumber) {
  const apiKey = getApiKey();
  if (!apiKey) {
    const err = new Error('AIRLABS_API_KEY is not configured');
    err.statusCode = 503;
    throw err;
  }

  const normalizedFlightNumber = normalizeFlightNumber(flightNumber);
  if (!normalizedFlightNumber) {
    const err = new Error('flightNumber is required');
    err.statusCode = 400;
    throw err;
  }

  const params = {
    api_key: apiKey,
  };

  if (/^[A-Z]{2,3}\d+/i.test(normalizedFlightNumber)) {
    params.flight_iata = normalizedFlightNumber;
  } else {
    params.flight_number = normalizedFlightNumber.replace(/[^0-9A-Z]/gi, '');
  }

  const response = await axios.get(`${AIRLABS_BASE_URL}/flight`, {
    params,
    timeout: 15000,
  });

  const raw = response?.data?.response;
  if (!raw || typeof raw !== 'object') {
    const err = new Error(`No flight data found for ${normalizedFlightNumber}`);
    err.statusCode = 404;
    throw err;
  }

  const normalized = normalizeLookupPayload(raw);
  if (!normalized.flightNumber) {
    normalized.flightNumber = normalizedFlightNumber;
  }

  const [departureTimeZone, arrivalTimeZone] = await Promise.all([
    fetchAirportTimeZone(normalized.departure?.iata),
    fetchAirportTimeZone(normalized.arrival?.iata),
  ]);
  normalized.departure.timeZone = departureTimeZone;
  normalized.arrival.timeZone = arrivalTimeZone;

  return normalized;
}

module.exports = {
  fetchFlightByNumber,
};
