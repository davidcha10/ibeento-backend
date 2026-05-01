#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const fixturePath = path.resolve(__dirname, 'fixtures/social-import-cases.json');
const apiBase = String(process.env.SOCIAL_IMPORT_API_BASE || process.env.API_BASE || 'http://localhost:4000').replace(/\/$/, '');
const limit = Number(process.env.SOCIAL_IMPORT_LIMIT || 20);
const filters = process.argv.slice(2).map((value) => String(value || '').trim()).filter(Boolean);

function normalize(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function namesFor(row = {}) {
  return [
    row.name,
    row.googleCache?.name,
    row.googleCache?.formattedAddress,
    row.location?.address,
    row._socialImport?.originalLabel,
  ].filter(Boolean);
}

function rowMatches(row, expected = {}) {
  const haystack = namesFor(row).map(normalize).join(' | ');
  const options = expected.anyNameContains || expected.nameContains || expected.googleNameContains || [];
  return options.some((needle) => haystack.includes(normalize(needle)));
}

function hasUnexpected(rows = [], unexpected = []) {
  const haystack = rows.flatMap(namesFor).map(normalize).join(' | ');
  return unexpected.filter((needle) => haystack.includes(normalize(needle)));
}

async function previewCase(testCase) {
  const response = await fetch(`${apiBase}/api/activities/import/social/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...(testCase.payload || {}),
      url: testCase.url,
      source: testCase.source || 'instagram',
      limit,
      bypassCache: true,
    }),
  });

  const body = await response.json().catch(() => ({}));
  return { response, body };
}

function validateCase(testCase, result) {
  const errors = [];
  const expected = testCase.expected || {};
  const rows = Array.isArray(result.body?.data) ? result.body.data : [];
  const meta = result.body?.meta || {};

  if (!result.response.ok) {
    errors.push(`HTTP ${result.response.status}`);
  }

  if (expected.status && meta.status !== expected.status) {
    errors.push(`expected status=${expected.status}, received=${meta.status || 'undefined'}`);
  }

  if (typeof expected.needsMediaAnalysis === 'boolean' && Boolean(meta.needsMediaAnalysis) !== expected.needsMediaAnalysis) {
    errors.push(`expected needsMediaAnalysis=${expected.needsMediaAnalysis}, received=${Boolean(meta.needsMediaAnalysis)}`);
  }

  if (Number.isFinite(Number(expected.exactResults)) && rows.length !== Number(expected.exactResults)) {
    errors.push(`expected ${expected.exactResults} results, received ${rows.length}`);
  }

  if (Number.isFinite(Number(expected.minResults)) && rows.length < Number(expected.minResults)) {
    errors.push(`expected at least ${expected.minResults} results, received ${rows.length}`);
  }

  if (Number.isFinite(Number(expected.maxResults)) && rows.length > Number(expected.maxResults)) {
    errors.push(`expected at most ${expected.maxResults} results, received ${rows.length}`);
  }

  for (const expectedRow of expected.results || []) {
    if (!rows.some((row) => rowMatches(row, expectedRow))) {
      const names = (expectedRow.anyNameContains || expectedRow.nameContains || expectedRow.googleNameContains || []).join(' OR ');
      errors.push(`missing expected result: ${names}`);
    }
  }

  const unexpected = hasUnexpected(rows, expected.unexpectedNameContains || []);
  if (unexpected.length) {
    errors.push(`unexpected result matched: ${unexpected.join(', ')}`);
  }

  return errors;
}

function resultSummary(rows = []) {
  if (!rows.length) return '[]';
  return rows.map((row) => row.googleCache?.name || row.name || row._socialImport?.originalLabel || 'unknown').join(' | ');
}

async function main() {
  const allCases = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const cases = filters.length
    ? allCases.filter((testCase) => filters.some((filter) => testCase.id.includes(filter) || testCase.url.includes(filter)))
    : allCases;

  if (!cases.length) {
    console.error(`No social import cases matched filters: ${filters.join(', ')}`);
    process.exit(1);
  }

  console.log(`Social import preview regression suite`);
  console.log(`API: ${apiBase}`);
  console.log(`Cases: ${cases.length}\n`);

  let failed = 0;
  for (const testCase of cases) {
    try {
      const result = await previewCase(testCase);
      const rows = Array.isArray(result.body?.data) ? result.body.data : [];
      const errors = validateCase(testCase, result);
      const prefix = errors.length ? 'FAIL' : 'PASS';
      if (errors.length) failed += 1;

      console.log(`${prefix} ${testCase.id}`);
      console.log(`  status=${result.body?.meta?.status || 'undefined'} results=${rows.length}`);
      console.log(`  found=${resultSummary(rows)}`);
      if (errors.length) {
        for (const error of errors) console.log(`  - ${error}`);
      }
    } catch (err) {
      failed += 1;
      console.log(`FAIL ${testCase.id}`);
      console.log(`  - ${err?.message || err}`);
    }
  }

  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  if (failed) process.exit(1);
}

main();
