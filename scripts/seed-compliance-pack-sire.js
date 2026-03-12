#!/usr/bin/env node
/* eslint-disable no-console */
const path = require('path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const CompliancePack = require('../src/models/CompliancePack');
const Zone = require('../src/models/Zone');

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/travelplanner';
  await mongoose.connect(uri);
  console.log('[seed:compliance:sire] Connected to MongoDB');

  const filter = {
    countryIso2: 'CO',
    code: 'CO_SIRE',
    version: 1,
  };

  const explicitCountryZoneId = String(process.env.SIRE_COUNTRY_ZONE_ID || '').trim();
  let countryZoneId = explicitCountryZoneId;
  if (!countryZoneId) {
    const countryZone = await Zone.findOne({
      source: 'wikidata',
      externalId: 'Q739', // Colombia
    })
      .select('_id')
      .lean();
    countryZoneId = String(countryZone?._id || '').trim();
  }

  if (!mongoose.Types.ObjectId.isValid(countryZoneId)) {
    throw new Error('Unable to resolve countryZoneId for CO_SIRE. Set SIRE_COUNTRY_ZONE_ID or ensure Colombia (Q739) exists in zones.');
  }

  const payload = {
    countryIso2: 'CO',
    countryZoneId,
    code: 'CO_SIRE',
    version: 1,
    submissionMode: 'manual',
    status: 'draft',
    fields: [
      { path: 'guests[].firstName', required: false, appliesTo: 'all_guests' },
      { path: 'guests[].secondName', required: false, appliesTo: 'all_guests' },
      { path: 'guests[].firstLastName', required: false, appliesTo: 'all_guests' },
      { path: 'guests[].secondLastName', required: false, appliesTo: 'all_guests' },
      { path: 'guests[].IdType', required: false, appliesTo: 'all_guests' },
      { path: 'guests[].Id', required: false, appliesTo: 'all_guests' },
      { path: 'guests[].nationality', required: false, appliesTo: 'all_guests' },
      { path: 'guests[].dateOfBirth', required: false, appliesTo: 'all_guests' },
      { path: 'invoiceInformation.email', required: false, appliesTo: 'main_guest' },
      { path: 'invoiceInformation.cellphone', required: false, appliesTo: 'main_guest' },
      { path: 'invoiceInformation.address', required: false, appliesTo: 'main_guest' },
      { path: 'checkIn.residenceCity', required: false, appliesTo: 'main_guest' },
      { path: 'checkIn.originCity', required: false, appliesTo: 'main_guest' },
      { path: 'checkIn.destinationCity', required: false, appliesTo: 'main_guest' },
    ],
    mapping: {
      target: 'sire_form_v1',
    },
  };

  const doc = await CompliancePack.findOneAndUpdate(
    filter,
    { $set: payload },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();

  console.log('[seed:compliance:sire] Upserted pack:', {
    id: String(doc?._id || ''),
    countryIso2: doc?.countryIso2,
    countryZoneId: String(doc?.countryZoneId || ''),
    code: doc?.code,
    version: doc?.version,
    status: doc?.status,
    submissionMode: doc?.submissionMode,
    fields: Array.isArray(doc?.fields) ? doc.fields.length : 0,
  });

  await mongoose.disconnect();
  console.log('[seed:compliance:sire] Done');
}

main().catch(async (err) => {
  console.error('[seed:compliance:sire] Error:', err);
  try {
    await mongoose.disconnect();
  } catch (_) {
    // ignore
  }
  process.exit(1);
});
