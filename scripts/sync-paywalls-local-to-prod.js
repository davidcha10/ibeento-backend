#!/usr/bin/env node
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const mongoose = require('mongoose');

const localUri = process.env.LOCAL_MONGODB_URI || process.env.MONGODB_URI;
const prodUri = String(process.env.PROD_MONGODB_URI || '').replace(/^"|"$/g, '');

const TARGET_KEYS = new Set([
  'current_onboard_paywall',
  'onboard_weekly_yearly_paywall',
]);

async function main() {
  if (!localUri || !prodUri) {
    throw new Error('Missing LOCAL_MONGODB_URI/MONGODB_URI or PROD_MONGODB_URI in backend/.env');
  }

  const localConn = await mongoose.createConnection(localUri).asPromise();
  const prodConn = await mongoose.createConnection(prodUri, { family: 4 }).asPromise();

  const schema = new mongoose.Schema(
    {
      name: String,
      analyticsKey: String,
      appearancePercent: Number,
      isActive: Boolean,
      code: String,
    },
    { timestamps: true, strict: false, collection: 'paywallvariants' }
  );

  const Local = localConn.model('PaywallVariantLocalSync', schema);
  const Prod = prodConn.model('PaywallVariantProdSync', schema);

  const source = await Local.find({ analyticsKey: { $in: Array.from(TARGET_KEYS) } }).lean();

  if (!source.length) {
    console.log('No local paywalls found for target keys.');
    await localConn.close();
    await prodConn.close();
    return;
  }

  console.log('Local paywalls to sync:');
  for (const row of source) {
    console.log(`- ${row.analyticsKey} (active=${row.isActive}, percent=${row.appearancePercent})`);
  }

  let inserted = 0;
  let updated = 0;

  for (const doc of source) {
    const payload = {
      name: doc.name,
      analyticsKey: doc.analyticsKey,
      appearancePercent: doc.appearancePercent,
      isActive: doc.isActive,
      code: doc.code,
      updatedAt: new Date(),
    };

    const existing = await Prod.findOne({ analyticsKey: doc.analyticsKey }).lean();

    if (existing) {
      await Prod.updateOne({ _id: existing._id }, { $set: payload });
      updated += 1;
      console.log(`Updated: ${doc.analyticsKey}`);
    } else {
      await Prod.create({ ...payload, createdAt: doc.createdAt || new Date() });
      inserted += 1;
      console.log(`Inserted: ${doc.analyticsKey}`);
    }
  }

  const prodSnapshot = await Prod.find(
    { analyticsKey: { $in: Array.from(TARGET_KEYS) } },
    { analyticsKey: 1, name: 1, appearancePercent: 1, isActive: 1 }
  ).lean();

  console.log('\nProduction snapshot after sync:');
  for (const row of prodSnapshot) {
    console.log(`- ${row.analyticsKey} | ${row.name} | active=${row.isActive} | percent=${row.appearancePercent}`);
  }

  console.log(`\nDone. Inserted=${inserted}, Updated=${updated}`);

  await localConn.close();
  await prodConn.close();
}

main().catch((err) => {
  console.error('[sync-paywalls-local-to-prod] Error:', err.message);
  process.exit(1);
});
