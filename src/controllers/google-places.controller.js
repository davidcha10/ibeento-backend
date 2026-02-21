// google-places.controller.js
const axios = require('axios');

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

module.exports = {
  getPlacePhoto,
};