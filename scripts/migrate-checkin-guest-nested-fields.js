require('dotenv').config();
const mongoose = require('mongoose');
const ProviderGuestLink = require('../src/models/ProviderGuestLink');
const ItineraryItem = require('../src/models/ItineraryItem');

function cleanText(value) {
  const text = String(value || '').trim();
  return text || null;
}

function normalizeInvoiceInformationPayload(raw = {}) {
  return {
    email: cleanText(raw?.email),
    cellphone: cleanText(raw?.cellphone),
    address: cleanText(raw?.address),
  };
}

function normalizeRegulationPayload(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const normalizeScope = (scopeRaw = {}, legacy = {}) => {
    const countryCode = cleanText(scopeRaw?.countryCode || legacy?.countryCode);
    const countryName = cleanText(scopeRaw?.countryName || legacy?.countryName);
    const cityCode = cleanText(scopeRaw?.cityCode || legacy?.cityCode);
    const cityName = cleanText(scopeRaw?.cityName || legacy?.cityName);
    const value = cleanText(
      scopeRaw?.value ||
      scopeRaw?.city ||
      scopeRaw?.name ||
      legacy?.value ||
      legacy?.city ||
      legacy?.name ||
      cityName ||
      countryName
    );
    return {
      value: value || null,
      countryCode: countryCode || null,
      countryName: countryName || null,
      cityCode: cityCode || null,
      cityName: cityName || null,
    };
  };

  return {
    residence: normalizeScope(source?.residence || {}, {
      value: source?.residenceCity || source?.cityOfResidence,
      countryCode: source?.residenceCountryCode,
      countryName: source?.residenceCountryName,
      cityCode: source?.residenceCityCode,
      cityName: source?.residenceCityName,
    }),
    origin: normalizeScope(source?.origin || {}, {
      value: source?.originCity,
      countryCode: source?.originCountryCode,
      countryName: source?.originCountryName,
      cityCode: source?.originCityCode,
      cityName: source?.originCityName,
    }),
    destination: normalizeScope(source?.destination || {}, {
      value: source?.destinationCity,
      countryCode: source?.destinationCountryCode,
      countryName: source?.destinationCountryName,
      cityCode: source?.destinationCityCode,
      cityName: source?.destinationCityName,
    }),
  };
}

function mergeInvoiceInformation(preferred = null, fallback = null) {
  const p = normalizeInvoiceInformationPayload(preferred || {});
  const f = normalizeInvoiceInformationPayload(fallback || {});
  return {
    email: p.email || f.email || null,
    cellphone: p.cellphone || f.cellphone || null,
    address: p.address || f.address || null,
  };
}

function mergeRegulation(preferred = null, fallback = null) {
  const p = normalizeRegulationPayload(preferred || {});
  const f = normalizeRegulationPayload(fallback || {});
  const mergeScope = (preferredScope = {}, fallbackScope = {}) => ({
    value: preferredScope?.value || fallbackScope?.value || null,
    countryCode: preferredScope?.countryCode || fallbackScope?.countryCode || null,
    countryName: preferredScope?.countryName || fallbackScope?.countryName || null,
    cityCode: preferredScope?.cityCode || fallbackScope?.cityCode || null,
    cityName: preferredScope?.cityName || fallbackScope?.cityName || null,
  });
  return {
    residence: mergeScope(p?.residence, f?.residence),
    origin: mergeScope(p?.origin, f?.origin),
    destination: mergeScope(p?.destination, f?.destination),
  };
}

function shallowEqualJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function buildGuestsWithNestedData(rawGuests, rootInvoice, rootRegulation) {
  const guests = Array.isArray(rawGuests) ? rawGuests : [];
  if (!guests.length) return [];
  const explicitMainIndex = guests.findIndex((entry) => String(entry?.role || '').trim() === 'Main guest');
  const mainIndex = explicitMainIndex >= 0 ? explicitMainIndex : 0;
  return guests.map((entry, index) => {
    const role = String(entry?.role || '').trim() === 'Main guest' ? 'Main guest' : 'Guest';
    const isMainGuest = index === mainIndex || role === 'Main guest';
    return {
      ...entry,
      role,
      invoiceInformation: mergeInvoiceInformation(
        entry?.invoiceInformation,
        isMainGuest ? rootInvoice : null
      ),
      regulation: mergeRegulation(
        entry?.regulation,
        isMainGuest ? rootRegulation : null
      ),
    };
  });
}

function getMainGuest(guests = []) {
  if (!Array.isArray(guests) || !guests.length) return null;
  return guests.find((entry) => String(entry?.role || '').trim() === 'Main guest') || guests[0] || null;
}

async function migrateProviderGuestLinks() {
  const docs = await ProviderGuestLink.find(
    {
      $or: [
        { 'checkIn.guests.0': { $exists: true } },
        { 'checkIn.regulation': { $exists: true } },
      ],
    },
    {
      _id: 1,
      checkIn: 1,
    }
  ).lean();

  let updated = 0;
  for (const doc of docs) {
    const checkIn = doc?.checkIn || {};
    const guests = buildGuestsWithNestedData(
      checkIn?.guests || [],
      checkIn?.invoiceInformation || {},
      checkIn?.regulation || {}
    );

    const nextCheckIn = {
      ...checkIn,
      guests,
    };
    delete nextCheckIn.invoiceInformation;
    delete nextCheckIn.regulation;

    if (shallowEqualJson(nextCheckIn, checkIn)) continue;
    await ProviderGuestLink.updateOne(
      { _id: doc._id },
      {
        $set: { checkIn: nextCheckIn },
      }
    );
    updated += 1;
  }
  await ProviderGuestLink.updateMany(
    { $or: [{ 'checkIn.invoiceInformation': { $exists: true } }, { 'checkIn.regulation': { $exists: true } }] },
    {
      $unset: {
        'checkIn.invoiceInformation': 1,
        'checkIn.regulation': 1,
      },
    }
  );
  return { scanned: docs.length, updated };
}

async function migrateItineraryItems() {
  const docs = await ItineraryItem.find(
    {
      $or: [
        { 'booking.guestCheckIn.guests.0': { $exists: true } },
        { 'booking.guestCheckIn.regulation': { $exists: true } },
      ],
    },
    {
      _id: 1,
      'booking.guestCheckIn': 1,
    }
  ).lean();

  let updated = 0;
  for (const doc of docs) {
    const checkIn = doc?.booking?.guestCheckIn || {};
    const guests = buildGuestsWithNestedData(
      checkIn?.guests || [],
      checkIn?.invoiceInformation || {},
      checkIn?.regulation || {}
    );

    const nextCheckIn = {
      ...checkIn,
      guests,
    };
    delete nextCheckIn.invoiceInformation;
    delete nextCheckIn.regulation;
    if (shallowEqualJson(nextCheckIn, checkIn)) continue;
    await ItineraryItem.updateOne(
      { _id: doc._id },
      {
        $set: { 'booking.guestCheckIn': nextCheckIn },
      }
    );
    updated += 1;
  }
  await ItineraryItem.updateMany(
    {
      $or: [
        { 'booking.guestCheckIn.invoiceInformation': { $exists: true } },
        { 'booking.guestCheckIn.regulation': { $exists: true } },
      ],
    },
    {
      $unset: {
        'booking.guestCheckIn.invoiceInformation': 1,
        'booking.guestCheckIn.regulation': 1,
      },
    }
  );
  return { scanned: docs.length, updated };
}

async function main() {
  const uri =
    process.env.MONGODB_URI ||
    process.env.LOCAL_MONGODB_URI ||
    'mongodb://127.0.0.1:27017/travelplanner';
  await mongoose.connect(uri);
  try {
    const [providerGuestLinks, itineraryItems] = await Promise.all([
      migrateProviderGuestLinks(),
      migrateItineraryItems(),
    ]);

    console.log(
      JSON.stringify(
        {
          ok: true,
          providerGuestLinks,
          itineraryItems,
        },
        null,
        2
      )
    );
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
