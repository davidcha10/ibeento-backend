const axios = require('axios');

// Google Places API endpoint
const GOOGLE_PLACES_URL =
  'https://places.googleapis.com/v1/places:searchText';

const AUTOCOMPLETE_URL =
  'https://places.googleapis.com/v1/places:autocomplete';

const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';

// Reverse geocoding to normalize city/region/country
async function reverseGeocode(lat, lng) {
  try {
    const response = await axios.get(GEOCODE_URL, {
      params: {
        latlng: `${lat},${lng}`,
        key: process.env.GOOGLE_PLACES_API_KEY,
        language: 'en'
      }
    });

    const results = response.data.results || [];
    if (!results.length) {
      return { city: null, region: null, country: null, countryIso: null };
    }

    return parseGeocodeComponents(results[0].address_components || []);
  } catch (err) {
    console.error('[GooglePlacesService] reverseGeocode error:', err.response?.data || err);
    return { city: null, region: null, country: null, countryIso: null };
  }
}

function parseGeocodeComponents(components) {
  let city = null;
  let region = null;
  let country = null;
  let countryIso = null;

  for (const comp of components) {
    const types = comp.types || [];

    // Detect city, prioritize locality > postal_town, only set if city is null
    if (city === null) {
      if (types.includes('locality')) {
        city = comp.long_name;
      } else if (types.includes('postal_town')) {
        city = comp.long_name;
      }
    }

    // Detect region, prioritize administrative_area_level_1 > administrative_area_level_2
    if (types.includes('administrative_area_level_1')) {
      region = comp.long_name;
    } else if (types.includes('administrative_area_level_2')) {
      if (region === null) {
        region = comp.long_name;
      }
    }

    // Detect country
    if (types.includes('country')) {
      country = comp.long_name;
      countryIso = comp.short_name;
    }
  }

  return { city, region, country, countryIso };
}

// Field mask (optimized)
const FIELDS = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.rating',
  'places.userRatingCount',
  'places.photos',
  'places.types',
  'places.regularOpeningHours.periods',
  'places.regularOpeningHours.weekdayDescriptions',
  'places.editorialSummary.text',
  'places.timeZone.id'
].join(',');

// Build headers
function buildHeaders() {
  return {
    'Content-Type': 'application/json',
    'X-Goog-Api-Key': process.env.GOOGLE_PLACES_API_KEY,
    'X-Goog-FieldMask': FIELDS
  };
}

// Build internal proxy URL for Google Places photos (avoids exposing API key)
function buildInternalPhotoUrl(photoName) {
  if (!photoName) return null;
  return `/api/google-places/photo?name=${encodeURIComponent(photoName)}`;
}

// Map Google Place response to internal structure
function mapPlace(p) {
  const mainPhotoName = p?.photos?.[0]?.name || null;
  const photoUrl = mainPhotoName ? buildInternalPhotoUrl(mainPhotoName) : null;

  return {
    id: p.id,
    name: p.displayName?.text || '',
    formattedAddress: p.formattedAddress || '',
    description: p.editorialSummary?.text || '',
    lat: p.location?.latitude,
    lng: p.location?.longitude,
    rating: p.rating,
    openingHours: p.regularOpeningHours,
    timeZone: p.timeZone?.id || null, // IANA, ej: "Europe/Paris"
    userRatingsTotal: p.userRatingCount,
    photoUrl,
    photos: (p.photos || []).map((ph) => {
      const photoName = ph.name;
      return {
        name: photoName,
        url: buildInternalPhotoUrl(photoName),
        width: ph.widthPx,
        height: ph.heightPx
      };
    }),
    types: p.types || []
  };
}

// Queries used for enrichment
function buildQueryList(name) {
  return [
    { textQuery: `top attractions in ${name}`, maxResultCount: 10 },
    { textQuery: `things to do in ${name}`, maxResultCount: 10 },
    { textQuery: `best restaurants in ${name}`, maxResultCount: 8 },
    { textQuery: `best cafes in ${name}`, maxResultCount: 6 },
    { textQuery: `best museums in ${name}`, maxResultCount: 6 },
    { textQuery: `best parks in ${name}`, maxResultCount: 6 },
    { textQuery: `best bars in ${name}`, maxResultCount: 6 },
    { textQuery: `shopping in ${name}`, maxResultCount: 5 },
    { textQuery: `hidden gems in ${name}`, maxResultCount: 5 }
  ];
}

// Autocomplete (for header suggestions)
async function autocompleteLocations(input, options = {}) {
  const {
    languageCode = 'en',
    locationBias,
    includedRegionCodes,
  } = options;

  if (!input || !input.trim()) {
    return [];
  }

  try {
    const payload = {
      input: input.trim(),
      languageCode,
    };

    // Opcional: sesgo geográfico
    if (locationBias) {
      payload.locationBias = locationBias;
    }

    // Limitar a ciertos códigos de región si se proporcionan (ej: ['CO','ES'])
    if (Array.isArray(includedRegionCodes) && includedRegionCodes.length) {
      payload.includedRegionCodes = includedRegionCodes;
    }

    const response = await axios.post(
      AUTOCOMPLETE_URL,
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': process.env.GOOGLE_PLACES_API_KEY,
          // Field mask optimized for predictions: placeId, text, types
          'X-Goog-FieldMask':
            'suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.types'
        }
      }
    );

    const suggestions = response.data.suggestions || [];

    // Each suggestion can be a placePrediction or queryPrediction.
    // For our use case we only care about placePrediction.
    const placePredictions = suggestions
      .map((s) => s.placePrediction)
      .filter((p) => !!p);

    // Filtrar solo predicciones que aparentan ser locaciones (ciudades, regiones, países)
    const locationTypes = new Set([
      'locality',
      'postal_town',
      'administrative_area_level_1',
      'administrative_area_level_2',
      'country',
      'political',
    ]);

    const filteredPredictions = placePredictions.filter((pred) =>
      (pred.types || []).some((t) => locationTypes.has(t))
    );

    return filteredPredictions.map((pred) => ({
      placeId: pred.placeId,
      description: pred.text?.text || '',
      types: pred.types || []
    }));
  } catch (err) {
    console.error(
      '[GooglePlacesService] autocomplete error:',
      err.response?.data || err
    );
    return [];
  }
}

// Main search
async function search({ textQuery, lat, lng }) {
  try {
    const payload = { 
      textQuery,
      languageCode: 'en'
    };

    // optional location bias
    if (lat && lng) {
      payload.locationBias = {
        circle: {
          center: { latitude: lat, longitude: lng },
          radius: 5000
        }
      };
    }

    const response = await axios.post(
      GOOGLE_PLACES_URL,
      payload,
      { headers: buildHeaders() }
    );

    const places = response.data.places || [];
    return places.map(mapPlace);

  } catch (err) {
    console.error('[GooglePlacesService] search error:', err.response?.data || err);
    return [];
  }
}

// Enriched multi-query search (like frontend)
async function enrichedSearch(name, lat, lng) {
  const queries = buildQueryList(name);
  const allResults = [];

  for (const q of queries) {
    const partial = await search({
      textQuery: q.textQuery,
      lat,
      lng
    });

    console.log('[GooglePlacesService] enrichedSearch partial openingHours:', {
      query: q.textQuery,
      sample: partial.slice(0, 3).map(p => ({
        id: p.id,
        name: p.name,
        openingHours: p.openingHours
      }))
    });

    allResults.push(...partial.slice(0, q.maxResultCount));
  }

  // Deduplicate by id
  const map = new Map();
  for (const p of allResults) {
    if (!map.has(p.id)) map.set(p.id, p);
  }

  return Array.from(map.values());
}

async function nearbySearchV1(lat, lng) {
  try {
    const payload = {
      maxResultCount: 5,
      locationRestriction: {
        circle: {
          center: { latitude: lat, longitude: lng },
          radius: 500
        }
      },
      languageCode: "en"
    };

    const response = await axios.post(
      "https://places.googleapis.com/v1/places:searchNearby",
      payload,
      {
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": process.env.GOOGLE_PLACES_API_KEY,
          "X-Goog-FieldMask": "places.id,places.addressComponents"
        }
      }
    );

    return response.data.places || [];
  } catch (err) {
    console.error("[GooglePlacesService] nearbySearchV1 error:", err.response?.data || err);
    return [];
  }
}

async function resolveLocationByNearbySearch(lat, lng) {
  try {
    const nearbyPlaces = await nearbySearchV1(lat, lng);
    const detailsList = nearbyPlaces.map(p =>
      parseAddressComponents(p.addressComponents || [])
    );


    let city = null;
    let region = null;
    let country = null;
    let countryIso = null;

    let cityLang = null;
    let regionLang = null;
    let countryLang = null;

    let lastCity = null;
    let lastRegion = null;
    let lastCountryIso = null;

    let cityCount = 0;
    let regionCount = 0;
    let countryCount = 0;

    for (const details of detailsList) {
      if (details.region === lastRegion) regionCount++;
      else { regionCount = 1; lastRegion = details.region; }
      if (regionCount >= 2 && region === null && details.region) {
        region = details.region;
        regionLang = details.regionLang || regionLang;
      }

      if (details.countryIso === lastCountryIso && details.countryIso) countryCount++;
      else { countryCount = 1; lastCountryIso = details.countryIso; }
      if (countryCount >= 2 && country === null && details.country) {
        country = details.country;
        countryIso = details.countryIso;
        countryLang = details.countryLang || countryLang;
      }

      if (details.city === lastCity) cityCount++;
      else { cityCount = 1; lastCity = details.city; }
      if (cityCount >= 2 && city === null && details.city) {
        city = details.city;
        cityLang = details.cityLang || cityLang;
      }
    }

    return {
      city,
      region,
      country,
      countryIso,
      cityLang,
      regionLang,
      countryLang
    };
  } catch (err) {
    console.error("[GooglePlacesService] resolveLocationByNearbySearch error:", err.response?.data || err);
    return { city: null, region: null, country: null, countryIso: null };
  }
}

async function fallbackResolveLocation(formattedAddress, partial) {
  const {
    city: existingCity,
    region: existingRegion,
    country: existingCountry,
    countryIso: existingCountryIso,
    cityLang: existingCityLang,
    regionLang: existingRegionLang,
    countryLang: existingCountryLang
  } = partial || {};

  try {
    const payload = {
      textQuery: `city near ${formattedAddress}`,
      languageCode: 'en'
    };

    const response = await axios.post(
      GOOGLE_PLACES_URL,
      payload,
      { headers: buildHeaders() }
    );

    const places = response.data.places || [];
    const extracted = places.slice(0, 7).map(p =>
      parseAddressComponents(p.addressComponents || [])
    );

    let city = existingCity || null;
    let region = existingRegion || null;
    let country = existingCountry || null;
    let countryIso = existingCountryIso || null;

    let cityLang = existingCityLang || null;
    let regionLang = existingRegionLang || null;
    let countryLang = existingCountryLang || null;

    let lastCity = null;
    let lastRegion = null;
    let lastCountryIso = null;

    let cityCount = existingCity ? 2 : 0;
    let regionCount = existingRegion ? 2 : 0;
    let countryCount = existingCountry ? 2 : 0;

    for (const d of extracted) {
      if (city === null) {
        if (d.city === lastCity) cityCount++;
        else { cityCount = 1; lastCity = d.city; }
        if (cityCount >= 2 && d.city) {
          city = d.city;
          cityLang = d.cityLang || cityLang;
        }
      }
      if (region === null) {
        if (d.region === lastRegion) regionCount++;
        else { regionCount = 1; lastRegion = d.region; }
        if (regionCount >= 2 && d.region) {
          region = d.region;
          regionLang = d.regionLang || regionLang;
        }
      }
      if (country === null) {
        if (d.countryIso === lastCountryIso && d.countryIso) countryCount++;
        else { countryCount = 1; lastCountryIso = d.countryIso; }
        if (countryCount >= 2 && d.country) {
          country = d.country;
          countryIso = d.countryIso;
          countryLang = d.countryLang || countryLang;
        }
      }
    }

    return {
      city,
      region,
      country,
      countryIso,
      cityLang,
      regionLang,
      countryLang
    };
  } catch (err) {
    console.error("[GooglePlacesService] fallbackResolveLocation error:", err.response?.data || err);
    return {
      city: existingCity || null,
      region: existingRegion || null,
      country: existingCountry || null,
      countryIso: existingCountryIso || null,
      cityLang: existingCityLang || null,
      regionLang: existingRegionLang || null,
      countryLang: existingCountryLang || null
    };
  }
}

// Fetch place details (addressComponents)
// options: { languageCode?: string }
async function getPlaceDetails(placeId, options = {}) {
  try {
    const languageCode = options.languageCode || 'en';
    const url = `https://places.googleapis.com/v1/places/${placeId}?languageCode=${encodeURIComponent(languageCode)}`;
    const response = await axios.get(url, {
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': process.env.GOOGLE_PLACES_API_KEY,
        'X-Goog-FieldMask': 'addressComponents'
      }
    });

    return parseAddressComponents(response.data.addressComponents || []);
  } catch (err) {
    console.error('[GooglePlacesService] getPlaceDetails error:', err.response?.data || err);
    return { city: null, region: null, country: null, countryIso: null };
  }
}

// Helper: searchLocationCanonic - canonical location name extractor
async function searchLocationCanonicLongText(query, type) {
  try {
    if (!query || !query.trim()) {
      return null;
    }

    const payload = {
      textQuery: query.trim(),
      languageCode: 'en'
    };

    const response = await axios.post(
      GOOGLE_PLACES_URL,
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': process.env.GOOGLE_PLACES_API_KEY,
          // Solo necesitamos los addressComponents para este helper
          'X-Goog-FieldMask': 'places.addressComponents'
        }
      }
    );

    const places = response.data.places || [];
    if (!places.length) return null;

    const getLong = (c) => c.longText || c.long_name || null;

    for (const place of places) {
      const components = place.addressComponents || [];

      if (type === 'city') {
        for (const comp of components) {
          const types = comp.types || [];
          if (types.includes('locality') || types.includes('postal_town')) {
            const name = getLong(comp);
            if (name) return name;
          }
        }
      } else if (type === 'region') {
        let level2Candidate = null;

        for (const comp of components) {
          const types = comp.types || [];
          const name = getLong(comp);
          if (!name) continue;

          // Preferimos administrative_area_level_1
          if (types.includes('administrative_area_level_1')) {
            return name;
          }

          // Guardamos administrative_area_level_2 solo como candidato
          if (!level2Candidate && types.includes('administrative_area_level_2')) {
            level2Candidate = name;
          }
        }

        // Si no hubo level_1 pero sí level_2, usamos el level_2
        if (level2Candidate) return level2Candidate;

      } else if (type === 'country') {
        for (const comp of components) {
          const types = comp.types || [];
          if (types.includes('country')) {
            const name = getLong(comp);
            if (name) return name;
          }
        }
      }
    }

    // Si no encontramos nada que coincida con el type
    return null;
  } catch (err) {
    console.error('[GooglePlacesService] searchLocationCanonic error:', err.response?.data || err);
    return null;
  }
}
// Parse addressComponents into structured location fields
function parseAddressComponents(components) {
  let city = null;
  let region = null;
  let country = null;
  let countryIso = null;

  let cityLang = null;
  let regionLang = null;
  let countryLang = null;

  for (const c of components) {
    const types = c.types || [];

    // Detect city, prioritize locality > postal_town, only set if city is null
    if (city === null) {
      if (types.includes('locality')) {
        city = c.longText;
        cityLang = c.languageCode || null;
      } else if (types.includes('postal_town')) {
        city = c.longText;
        cityLang = c.languageCode || null;
      }
    }

    // Detect region, prioritize administrative_area_level_1 > administrative_area_level_2
    if (types.includes('administrative_area_level_1')) {
      region = c.longText;
      regionLang = c.languageCode || null;
    } else if (types.includes('administrative_area_level_2')) {
      if (region === null) {
        region = c.longText;
        regionLang = c.languageCode || null;
      }
    }

    // Detect country
    if (types.includes('country')) {
      country = c.longText;
      countryIso = c.shortText;
      countryLang = c.languageCode || null;
    }
  }

  return {
    city,
    region,
    country,
    countryIso,
    cityLang,
    regionLang,
    countryLang
  };
}

module.exports = {
  autocompleteLocations,
  search,
  searchLocationCanonicLongText,
  enrichedSearch,
  nearbySearchV1,
  resolveLocationByNearbySearch,
  fallbackResolveLocation,
  getPlaceDetails,
  parseAddressComponents,
  reverseGeocode,
  parseGeocodeComponents
};
