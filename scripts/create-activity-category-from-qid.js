#!/usr/bin/env node
const https = require('https');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

dotenv.config({ path: '.env' });

const ActivityCategory = require('../src/models/ActivityCategory');

function parseArgs(argv) {
  const out = { qid: null };
  for (let i = 2; i < argv.length; i += 1) {
    const token = String(argv[i] || '').trim();
    if (!token) continue;
    if (token.startsWith('--qid=')) {
      out.qid = token.split('=')[1];
      continue;
    }
    if (token === '--qid' && argv[i + 1]) {
      out.qid = argv[i + 1];
      i += 1;
      continue;
    }
    if (!out.qid && /^Q\d+$/i.test(token)) {
      out.qid = token;
    }
  }
  out.qid = String(out.qid || '').trim().toUpperCase();
  return out;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        {
          headers: {
            'User-Agent': 'IBeento-Admin/1.0 (activity-category-qid)',
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch (err) {
              reject(err);
            }
          });
        }
      )
      .on('error', reject);
  });
}

async function main() {
  const { qid } = parseArgs(process.argv);
  if (!/^Q\d+$/i.test(qid)) {
    throw new Error('Usage: node scripts/create-activity-category-from-qid.js --qid Q30022');
  }

  const prodUri = String(process.env.PROD_MONGODB_URI || '').replace(/^"|"$/g, '');
  if (!prodUri) {
    throw new Error('PROD_MONGODB_URI is missing in backend/.env');
  }

  await mongoose.connect(prodUri, { family: 4 });

  const existing = await ActivityCategory.findOne({ source: 'wikidata', externalId: qid }).lean();
  if (existing) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          status: 'exists',
          id: String(existing._id),
          qid,
          name: existing.name,
          slug: existing.slug,
        },
        null,
        2
      )
    );
    await mongoose.disconnect();
    return;
  }

  const wikidataUrl = `https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`;
  const wikidata = await fetchJson(wikidataUrl);
  const entity = wikidata?.entities?.[qid] || {};

  const labelEn = entity?.labels?.en?.value || null;
  const labelEs = entity?.labels?.es?.value || null;
  const descriptionEn = entity?.descriptions?.en?.value || null;

  const name = labelEn || labelEs || qid;
  const names = {
    ...(labelEn ? { en: labelEn } : {}),
    ...(labelEs ? { es: labelEs } : {}),
  };

  const created = await ActivityCategory.create({
    name,
    source: 'wikidata',
    externalId: qid,
    names,
    group: 'food_drinks',
    icon: 'coffee',
    order: 0,
    defaultDurationMin: {
      minMinutes: 30,
      maxMinutes: 90,
      source: 'manual',
    },
    discover: {
      enabled: true,
      targetPerZone: 12,
    },
    isActive: true,
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        status: 'created',
        id: String(created._id),
        qid,
        name: created.name,
        slug: created.slug,
        descriptionEn,
      },
      null,
      2
    )
  );

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('[create-activity-category-from-qid] Error:', err?.message || err);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
