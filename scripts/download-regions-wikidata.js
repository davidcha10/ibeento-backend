/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");

const SUPPORTED_LOCALES = [
  "en",
  "zh-CN",
  "es",
  "de",
  "fr",
  "ja",
  "ru",
  "it",
  "pt",
  "ar",
  "ko",
  "nl",
  "sv",
  "pl",
  "hi",
  "id",
  "tr",
  "th",
  "vi",
  "uk",
  "he",
];

const WIKIDATA_LANG_MAP = {
  "zh-CN": "zh-hans",
};

function toWikidataLang(locale) {
  return WIKIDATA_LANG_MAP[locale] || locale;
}

function buildLabelsQuery() {
  const lines = [];
  for (const locale of SUPPORTED_LOCALES) {
    const lang = toWikidataLang(locale);
    const field = `label_${locale.replace(/[^a-z0-9]/gi, "_")}`;
    lines.push(
      `  OPTIONAL { ?item rdfs:label ?${field} FILTER(LANG(?${field}) = "${lang}") }`
    );
  }
  return lines.join("\n");
}

async function fetchWithRetry(url, options, maxRetries = 3) {
  let attempt = 0;
  while (attempt <= maxRetries) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;
      const text = await response.text();
      const err = new Error(`Wikidata query failed: ${response.status} ${text}`);
      err.status = response.status;
      throw err;
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const delayMs = 1000 * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      attempt += 1;
    }
  }
  throw new Error("Wikidata query failed after retries");
}

function buildRegionsQuery({ labelLines, adminFilter, minPopulation, iso2, limit }) {
  const populationFilter = minPopulation ? `  FILTER(BOUND(?population) && ?population >= ${minPopulation})` : "";
  const limitClause = limit ? `LIMIT ${limit}` : "";
  return `
SELECT ?item ?parent ?adminLevel ?population ?label_en ${SUPPORTED_LOCALES
    .filter((l) => l !== "en")
    .map((l) => `?label_${l.replace(/[^a-z0-9]/gi, "_")}`)
    .join(" ")}
WHERE {
  ?item wdt:P31/wdt:P279* wd:Q56061.
  ?item wdt:P17 ?country.
  ?country wdt:P297 "${iso2}".
  OPTIONAL { ?item wdt:P131 ?parent. }
  OPTIONAL { ?item wdt:P274 ?adminLevel. }
  OPTIONAL { ?item wdt:P1082 ?population. }
${labelLines}
${adminFilter}
${populationFilter}
}
ORDER BY DESC(?population)
${limitClause}
`;
}

async function run() {
  const iso2 = String(process.env.COUNTRY_ISO2 || "").trim().toUpperCase();
  if (!iso2) {
    throw new Error("COUNTRY_ISO2 is required (e.g. JP)");
  }

  const maxAdminLevel = process.env.MAX_ADMIN_LEVEL;
  const minPopulationRaw = process.env.MIN_POPULATION;
  const minPopulation = minPopulationRaw && minPopulationRaw !== "0" ? Number(minPopulationRaw) : null;
  const limit = process.env.LIMIT ? Number(process.env.LIMIT) : null;

  const adminFilter = maxAdminLevel
    ? `  FILTER(BOUND(?adminLevel) && ?adminLevel <= ${Number(maxAdminLevel)})`
    : "";

  const labelLines = buildLabelsQuery();
  const query = buildRegionsQuery({ labelLines, adminFilter, minPopulation, iso2, limit });

  const url = "https://query.wikidata.org/sparql";
  const response = await fetchWithRetry(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/sparql-query",
      "Accept": "application/sparql-results+json",
      "User-Agent": "TripPlannerSeed/1.0 (contact@example.com)",
    },
    body: query,
  });

  const data = await response.json();
  const rows = data?.results?.bindings || [];

  const outDir = path.join(__dirname, "cache");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `regions-${iso2}.json`);

  const payload = {
    iso2,
    generatedAt: new Date().toISOString(),
    count: rows.length,
    rows,
  };

  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf8");
  console.log(`[download] saved ${rows.length} regions to ${outPath}`);
}

run().catch((err) => {
  console.error("[download] failed:", err);
  process.exitCode = 1;
});
