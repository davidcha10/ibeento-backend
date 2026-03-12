// google-places.controller.js
const axios = require('axios');
const googlePlacesService = require('../services/google-places.service');

function parseNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeCityFromTextQuery(rawTextQuery = '') {
  const textQuery = String(rawTextQuery || '').trim();
  if (!textQuery) return '';
  const inMatch = textQuery.match(/in (.+)$/i);
  if (inMatch && inMatch[1]) return String(inMatch[1]).trim();
  return textQuery;
}

async function getPlacePhoto(req, res) {
  try {
    const rawName = req.query.name;
    if (!rawName) {
      return res.status(400).json({ error: 'Missing "name" query param' });
    }

    const placePhotoName = decodeURIComponent(rawName);

    const maxWidthPx  = Number(req.query.maxWidthPx)  || 800;
    const maxHeightPx = Number(req.query.maxHeightPx) || 800;

    const url = `https://places.googleapis.com/v1/${placePhotoName}/media` +
      `?maxWidthPx=${maxWidthPx}&maxHeightPx=${maxHeightPx}&key=${process.env.GOOGLE_PLACES_API_KEY}`;

    const googleResp = await axios.get(url, {
      responseType: 'stream',
      validateStatus: (status) => status >= 200 && status < 500, // no lances error en 4xx
    });

    if (googleResp.status !== 200) {
      console.error('[GooglePlacesController] Google photo error', googleResp.status);
      return res.status(404).json({ error: 'Photo not found' });
    }

    // Sólo seteamos los headers que nos interesan; NO propagamos los de seguridad de Google
    const contentType = googleResp.headers['content-type'] || 'image/jpeg';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Pipe del stream de Google → cliente
    googleResp.data.pipe(res);

    googleResp.data.on('error', (err) => {
      console.error('[GooglePlacesController] Stream error', err);
      if (!res.headersSent) {
        res.status(500).end('Error streaming image');
      } else {
        res.end();
      }
    });
  } catch (err) {
    console.error('[GooglePlacesController] getPlacePhoto error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Photo not found' });
    } else {
      res.end();
    }
  }
}

async function autocomplete(req, res) {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json([]);

    const languageCode = String(req.query.languageCode || 'en').trim() || 'en';
    const mode = String(req.query.mode || 'location').trim().toLowerCase() || 'location';
    const rawRegionCodes = String(req.query.includedRegionCodes || '').trim();
    const includedRegionCodes = rawRegionCodes
      ? rawRegionCodes
          .split(',')
          .map((entry) => String(entry || '').trim().toUpperCase())
          .filter(Boolean)
      : undefined;

    const data = await googlePlacesService.autocompleteLocations(q, {
      languageCode,
      includedRegionCodes,
      mode,
    });
    return res.json(Array.isArray(data) ? data : []);
  } catch (err) {
    console.error('[GooglePlacesController] autocomplete error:', err);
    return res.status(500).json({ error: 'Unable to fetch autocomplete results' });
  }
}

async function getTopActivities(req, res) {
  try {
    const textQuery = String(req.query.textQuery || '').trim();
    const cityName = normalizeCityFromTextQuery(textQuery);
    if (!cityName) return res.json([]);

    const lat = parseNumber(req.query.lat);
    const lng = parseNumber(req.query.lng);
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 20, 50));

    const enriched = await googlePlacesService.enrichedSearch(
      cityName,
      lat ?? undefined,
      lng ?? undefined
    );
    const rows = Array.isArray(enriched) ? enriched : [];
    return res.json(rows.slice(0, limit));
  } catch (err) {
    console.error('[GooglePlacesController] getTopActivities error:', err);
    return res.status(500).json({ error: 'Unable to fetch activities' });
  }
}

async function getPlaceDetails(req, res) {
  try {
    const placeId = String(req.params.placeId || '').trim();
    if (!placeId) return res.status(400).json({ error: 'Missing placeId' });
    const languageCode = String(req.query.languageCode || 'en').trim() || 'en';
    const details = await googlePlacesService.getPlaceDetails(placeId, { languageCode });
    return res.json(details || null);
  } catch (err) {
    console.error('[GooglePlacesController] getPlaceDetails error:', err);
    return res.status(500).json({ error: 'Unable to fetch place details' });
  }
}

async function getPlaceLookup(req, res) {
  try {
    const placeId = String(req.params.placeId || '').trim();
    if (!placeId) return res.status(400).json({ error: 'Missing placeId' });
    const languageCode = String(req.query.languageCode || 'en').trim() || 'en';
    const details = await googlePlacesService.getPlaceLookup(placeId, { languageCode });
    return res.json(details || null);
  } catch (err) {
    console.error('[GooglePlacesController] getPlaceLookup error:', err);
    return res.status(500).json({ error: 'Unable to lookup place' });
  }
}

async function reverseGeocode(req, res) {
  try {
    const lat = parseNumber(req.query.lat);
    const lng = parseNumber(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: 'lat and lng are required' });
    }
    const languageCode = String(req.query.languageCode || 'en').trim() || 'en';
    const payload = await googlePlacesService.reverseGeocodeAddress(lat, lng, { languageCode });
    return res.json(payload || null);
  } catch (err) {
    console.error('[GooglePlacesController] reverseGeocode error:', err);
    return res.status(500).json({ error: 'Unable to reverse geocode coordinates' });
  }
}

module.exports = {
  autocomplete,
  getTopActivities,
  getPlaceDetails,
  getPlaceLookup,
  reverseGeocode,
  getPlacePhoto,
};
