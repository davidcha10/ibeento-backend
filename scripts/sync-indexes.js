const path = require('path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const Activity = require('../src/models/Activity');
const Zone = require('../src/models/Zone');
const ZoneTypeTaxonomy = require('../src/models/ZoneTypeTaxonomy');

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is required');
  }

  await mongoose.connect(uri);
  console.log('Connected to MongoDB');

  const models = [
    { name: 'Zone', model: Zone },
    { name: 'ZoneTypeTaxonomy', model: ZoneTypeTaxonomy },
    { name: 'Activity', model: Activity },
  ];

  for (const entry of models) {
    const res = await entry.model.syncIndexes();
    console.log(`[syncIndexes] ${entry.name}`, res);
  }

  await mongoose.disconnect();
  console.log('Done');
}

main().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch (_) {
    // ignore
  }
  process.exit(1);
});
