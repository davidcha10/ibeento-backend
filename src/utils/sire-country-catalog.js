const fs = require('fs');
const path = require('path');

const SIRE_COLOMBIA_COUNTRY_CODE = '169';

function normalizeSireText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function parseCatalogRows(raw) {
  return String(raw || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(.+)$/);
      if (!match) return null;
      return {
        code: String(match[1] || '').trim(),
        name: String(match[2] || '').trim(),
      };
    })
    .filter((item) => !!item && !!item.code && !!item.name);
}

function loadCountriesFromFrontendCatalog() {
  const catalogPath = path.resolve(
    __dirname,
    '../../../frontend/src/app/components/user/guest-link/sire-location-catalog.ts'
  );

  try {
    const source = fs.readFileSync(catalogPath, 'utf8');
    const match = source.match(
      /const\s+SIRE_COUNTRIES_RAW\s*=\s*`([\s\S]*?)`;\s*const\s+SIRE_COLOMBIA_CITIES_RAW\s*=/
    );

    if (!match || !match[1]) return [];
    return parseCatalogRows(match[1]);
  } catch (_) {
    return [];
  }
}

const countries = loadCountriesFromFrontendCatalog();

const countryByCode = new Map(countries.map((item) => [item.code, item]));
const countryCodeByNormalizedName = new Map(
  countries.map((item) => [normalizeSireText(item.name), item.code])
);

const DEMONYM_ALIASES = new Map([
  ['COLOMBIANO', SIRE_COLOMBIA_COUNTRY_CODE],
  ['COLOMBIANA', SIRE_COLOMBIA_COUNTRY_CODE],
  ['COLOMBIAN', SIRE_COLOMBIA_COUNTRY_CODE],
  ['ESTADOUNIDENSE', '249'],
  ['AMERICANO', '249'],
  ['AMERICANA', '249'],
]);

function resolveSireCountryCode(rawValue) {
  const raw = String(rawValue || '').trim();
  if (!raw) return '';

  if (/^\d+$/.test(raw)) {
    if (countryByCode.has(raw)) return raw;
    return raw;
  }

  const trailingCodeMatch = raw.match(/\((\d+)\)\s*$/);
  if (trailingCodeMatch?.[1]) {
    const code = String(trailingCodeMatch[1] || '').trim();
    if (code) return code;
  }

  const normalized = normalizeSireText(raw);
  if (!normalized) return '';

  const direct = countryCodeByNormalizedName.get(normalized);
  if (direct) return direct;

  const alias = DEMONYM_ALIASES.get(normalized);
  if (alias) return alias;

  return '';
}

module.exports = {
  SIRE_COLOMBIA_COUNTRY_CODE,
  normalizeSireText,
  resolveSireCountryCode,
};
