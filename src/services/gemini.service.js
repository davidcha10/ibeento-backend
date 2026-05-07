const { GoogleGenerativeAI } = require('@google/generative-ai');
const AI_LOG_PREFIX = '[AI][gemini]';

const EXTRACTION_MODEL_ID = 'gemini-2.5-flash';
const EXTRACTION_FALLBACK_MODEL_IDS = ['gemini-2.0-flash'];
const LOCATION_CONTEXT_MODEL_ID = 'gemini-2.5-flash';

const PLACE_EXTRACTION_SYSTEM = `
You are a place name extractor for a travel app.
Your only task: find real, specific places mentioned in social media content.

What counts as a place:
- Named restaurants, cafes, bars, clubs, nightlife venues
- Hotels, hostels, resorts, vacation rentals
- Tourist attractions, museums, monuments, landmarks
- Beaches, parks, natural sites, viewpoints
- Shops, markets, malls, specific stores

What to ignore:
- Generic travel words: travel, vacation, explore, adventure, wanderlust, holiday
- Emotions, actions, opinions: amazing, loved, visited, recommended
- Hashtags that are not specific place names (#fyp, #viral, #travel, #foodie)
- Personal account handles (people, influencers, photographers): @username style that refers to a person
- App or brand names that are not physical venues
- Street addresses: lines that are just a number + street name + city/district (e.g. "21 donggyo-ro 34-gil, Mapo-gu, Seoul" — this is an address, not a place name)
- Postal/zip codes, floor numbers, unit numbers

Special rule for @mentions: if a mention clearly refers to a physical venue (restaurant, hotel, bar, cafe, attraction), extract it as a place name — remove the @ and convert the handle to a readable name (e.g. "@ramenlongseason" → "Ramen Long Season", "@noburestaurant" → "Nobu Restaurant"). If the mention refers to a person or it's ambiguous, ignore it.

Output ONLY valid JSON with no extra text:
{
  "places": [
    {
      "name": "<exact place name as mentioned>",
      "confidence": "high"|"medium"|"low",
      "type": "exact_place"|"area_mentioned"|"context_only",
      "evidence": "<short quote or cue from text>",
      "isPrimary": true|false
    }
  ]
}

Rules for fields:
- Prefer "exact_place" when the text clearly indicates a venue/business.
- Use "area_mentioned" for cities/neighborhoods or broad areas.
- Use "context_only" for weak mentions that should not be used as direct venue candidates.
- Keep "evidence" short (<= 120 chars).
- Mark isPrimary=true only for the strongest candidate in the content.

Confidence levels:
- high: specific named venue or attraction ("Sagrada Família", "Nobu Restaurant", "Central Park")
- medium: area, neighborhood, or city ("El Born", "Barcelona", "Tuscany")
- low: inferred from context, not explicitly named

Max 15 places. If none found, return: {"places":[]}
`.trim();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Advertencia suave si falta la key, pero no reventamos el proceso
if (!GEMINI_API_KEY) {
  console.warn('[Gemini] Missing GEMINI_API_KEY in environment variables');
}

// Modelo principal configurable. Recomendado: dejarlo en env.
const DEFAULT_MODEL_ID = process.env.GEMINI_MODEL_ID || 'gemini-2.5-pro';

// Modelos de respaldo para evitar respuestas vacias por disponibilidad/safety del modelo principal.
const FALLBACK_MODEL_IDS = (process.env.GEMINI_FALLBACK_MODEL_IDS || 'gemini-2.5-flash,gemini-2.0-flash')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean)
  .filter((v, i, arr) => arr.indexOf(v) === i && v !== DEFAULT_MODEL_ID);

async function generateWithModelParts(modelId, systemInstruction, parts, attempt) {
  console.log(`${AI_LOG_PREFIX} extraction:attempt`, { modelId, attempt });
  const model = getModel(modelId);

  let result;
  try {
    result = await model.generateContent({
      systemInstruction: { role: 'system', parts: [{ text: systemInstruction }] },
      contents: [{ role: 'user', parts }],
    });
  } catch (err) {
    console.error(`${AI_LOG_PREFIX} extraction:error`, { modelId, attempt, message: err?.message || err });
    return {
      ok: false,
      data: { rawText: null, parsingError: 'generateContent failed', meta: { modelId, attempt, message: err?.message || String(err) } },
    };
  }

  const response = result?.response;
  const text = extractTextFromResponse(response);

  if (!text) {
    return { ok: false, data: buildNoCandidatesError(response, modelId, attempt) };
  }

  const parsed = tryParseLenientJson(text);
  if (parsed.ok) {
    return { ok: true, data: { ...parsed.value, meta: { modelId, attempt } } };
  }

  console.warn(`${AI_LOG_PREFIX} extraction:invalid-json`, { modelId, attempt, textPreview: String(text).slice(0, 200) });
  return { ok: false, data: { rawText: text, parsingError: 'Invalid JSON', meta: { modelId, attempt } } };
}

/**
 * Extrae nombres de lugares desde contenido de redes sociales.
 * Primero intenta con texto. Si no encuentra nada y hay imagen, usa visión como fallback.
 *
 * @param {object} options
 * @param {string} [options.text]
 * @param {string|null} [options.imageBase64]
 * @param {string} [options.mimeType]
 * @returns {Promise<{places: Array<{name:string,confidence:string}>, method:string}>}
 */
async function extractPlacesFromSocialContent({ text = '', imageBase64 = null, mimeType = 'image/jpeg' } = {}) {
  const hasText = String(text || '').trim().length > 0;
  const hasImage = typeof imageBase64 === 'string' && imageBase64.length > 100;

  if (!hasText && !hasImage) {
    return { places: [], method: 'none' };
  }

  const modelsToTry = [EXTRACTION_MODEL_ID, ...EXTRACTION_FALLBACK_MODEL_IDS];

  if (hasText) {
    const parts = [{ text: `Extract places from this social media caption:\n\n${String(text).trim()}` }];
    for (let i = 0; i < modelsToTry.length; i += 1) {
      const out = await generateWithModelParts(modelsToTry[i], PLACE_EXTRACTION_SYSTEM, parts, i + 1);
      if (out.ok) {
        const places = Array.isArray(out.data?.places) ? out.data.places : [];
        if (places.length > 0) {
          console.log(`${AI_LOG_PREFIX} extraction:text:success`, { model: modelsToTry[i], count: places.length });
          return { places, method: 'text' };
        }
        break;
      }
    }
  }

  if (hasImage) {
    const parts = [
      { text: 'Extract places visible in this social media screenshot or thumbnail:' },
      { inlineData: { mimeType: mimeType || 'image/jpeg', data: imageBase64 } },
    ];
    for (let i = 0; i < modelsToTry.length; i += 1) {
      const out = await generateWithModelParts(modelsToTry[i], PLACE_EXTRACTION_SYSTEM, parts, i + 1);
      if (out.ok) {
        const places = Array.isArray(out.data?.places) ? out.data.places : [];
        console.log(`${AI_LOG_PREFIX} extraction:image:result`, { model: modelsToTry[i], count: places.length });
        return { places, method: 'image' };
      }
    }
  }

  console.warn(`${AI_LOG_PREFIX} extraction:all-failed`, { hasText, hasImage });
  return { places: [], method: 'failed' };
}

async function extractLocationContextFromSocialContent({ text = '' } = {}) {
  const cleanText = String(text || '').trim();
  if (!cleanText) {
    return { location: null, method: 'none' };
  }

  const systemInstruction = `
You extract ONLY geographic context from social media content for place resolution.

Return ONLY valid JSON:
{
  "location": {
    "country": "<country or empty>",
    "city": "<city or empty>",
    "areas": ["<area1>", "<area2>"],
    "confidence": "high"|"medium"|"low",
    "evidence": "<short quote>"
  }
}

Rules:
- Use only places explicitly or strongly implied in the text.
- If unknown, set empty strings/empty array.
- Keep evidence <= 120 chars.
`.trim();

  const parts = [{ text: `Extract geographic context from this post content:\n\n${cleanText.slice(0, 12000)}` }];
  const out = await generateWithModelParts(LOCATION_CONTEXT_MODEL_ID, systemInstruction, parts, 1);
  if (!out.ok || !out.data || typeof out.data !== 'object') {
    return { location: null, method: 'failed' };
  }
  const raw = out.data.location;
  if (!raw || typeof raw !== 'object') {
    return { location: null, method: 'empty' };
  }

  const country = String(raw.country || '').trim();
  const city = String(raw.city || '').trim();
  const areas = Array.isArray(raw.areas)
    ? raw.areas.map((v) => String(v || '').trim()).filter(Boolean).slice(0, 5)
    : [];
  const confidence = String(raw.confidence || '').trim().toLowerCase();
  const evidence = String(raw.evidence || '').trim();

  if (!country && !city && !areas.length) {
    return { location: null, method: 'empty' };
  }

  return {
    location: {
      country,
      city,
      areas,
      confidence: ['high', 'medium', 'low'].includes(confidence) ? confidence : 'low',
      evidence: evidence.slice(0, 120),
    },
    method: 'text',
  };
}

/**
 * Devuelve una instancia de modelo de Gemini configurada.
 */
function getModel(modelId = DEFAULT_MODEL_ID) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not set');
  }

  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

  const model = genAI.getGenerativeModel({
    model: modelId,
    generationConfig: {
      // Deterministic-ish planning output
      temperature: 0.35,
      topK: 32,
      topP: 0.85,
      maxOutputTokens: 1500,
      // Intentamos forzar respuesta en JSON
      responseMimeType: 'application/json',
    },
  });

  return model;
}

function extractTextFromResponse(response) {
  const candidates = Array.isArray(response?.candidates) ? response.candidates : [];
  const first = candidates[0];

  if (first?.content?.parts?.length) {
    const text = first.content.parts
      .map((p) => (typeof p?.text === 'string' ? p.text : ''))
      .join('')
      .trim();
    if (text) return text;
  }

  // Fallback: algunos SDK/modelos no devuelven parts poblado pero si response.text().
  try {
    if (typeof response?.text === 'function') {
      const text = String(response.text() || '').trim();
      if (text) return text;
    }
  } catch (_err) {
    // ignore
  }

  return '';
}

function buildNoCandidatesError(response, modelId, attempt) {
  const first = Array.isArray(response?.candidates) ? response.candidates[0] : null;
  const finishReason = first?.finishReason || null;
  const blockReason = response?.promptFeedback?.blockReason || null;

  return {
    rawText: null,
    parsingError: 'No candidates/parts in Gemini response',
    meta: {
      modelId,
      attempt,
      finishReason,
      blockReason,
      promptFeedback: response?.promptFeedback || null,
      candidateCount: Array.isArray(response?.candidates) ? response.candidates.length : 0,
    },
  };
}

function stripMarkdownFences(text = '') {
  const t = String(text || '').trim();
  if (!t) return '';
  return t
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function extractFirstJsonObject(text = '') {
  const src = String(text || '');
  const start = src.indexOf('{');
  if (start < 0) return '';

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < src.length; i += 1) {
    const ch = src[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return src.slice(start, i + 1);
      }
    }
  }
  return '';
}

function tryParseLenientJson(text = '') {
  const cleaned = stripMarkdownFences(text);
  const candidates = [
    cleaned,
    extractFirstJsonObject(cleaned),
  ].filter(Boolean);

  for (const raw of candidates) {
    // Attempt 1: strict parse
    try {
      return { ok: true, value: JSON.parse(raw), usedLenient: false };
    } catch (_e) {
      // continue
    }

    // Attempt 2: remove trailing commas before } or ]
    const withoutTrailingCommas = raw.replace(/,\s*([}\]])/g, '$1');
    try {
      return { ok: true, value: JSON.parse(withoutTrailingCommas), usedLenient: true };
    } catch (_e) {
      // continue
    }
  }

  return { ok: false, value: null, usedLenient: false };
}

async function generateWithModel(modelId, systemInstruction, userPrompt, attempt) {
  console.log(`${AI_LOG_PREFIX} attempt:start`, { modelId, attempt });
  const model = getModel(modelId);

  let result;
  try {
    result = await model.generateContent({
      systemInstruction: {
        role: 'system',
        parts: [{ text: systemInstruction }],
      },
      contents: [
        {
          role: 'user',
          parts: [{ text: userPrompt }],
        },
      ],
    });
  } catch (err) {
    console.error(`${AI_LOG_PREFIX} attempt:error`, { modelId, attempt, message: err?.message || err });
    return {
      ok: false,
      error: err,
      data: {
        rawText: null,
        parsingError: 'Gemini generateContent failed',
        meta: { modelId, attempt, message: err?.message || String(err) },
      },
    };
  }

  const response = result?.response;
  const text = extractTextFromResponse(response);

  if (!text) {
    const noCandidates = buildNoCandidatesError(response, modelId, attempt);
    console.warn(`${AI_LOG_PREFIX} attempt:empty`, {
      modelId,
      attempt,
      finishReason: noCandidates?.meta?.finishReason || null,
      blockReason: noCandidates?.meta?.blockReason || null,
      candidateCount: noCandidates?.meta?.candidateCount || 0,
    });
    return {
      ok: false,
      data: noCandidates,
    };
  }

  const parsedTry = tryParseLenientJson(text);
  if (parsedTry.ok) {
    return {
      ok: true,
      data: {
        ...parsedTry.value,
        meta: {
          modelId,
          attempt,
          usedLenientJsonParse: parsedTry.usedLenient,
          candidateCount: Array.isArray(response?.candidates) ? response.candidates.length : 0,
        },
      },
    };
  }

  console.warn(`${AI_LOG_PREFIX} attempt:invalid-json`, {
    modelId,
    attempt,
    textPreview: String(text || '').slice(0, 220),
  });
  return {
    ok: false,
    data: {
      rawText: text,
      parsingError: 'Invalid JSON format from model',
      meta: {
        modelId,
        attempt,
        candidateCount: Array.isArray(response?.candidates) ? response.candidates.length : 0,
      },
    },
  };
}

/**
 * Llama a Gemini para que genere recomendaciones de itinerario
 * a partir del AiItineraryInput que le arma el frontend.
 *
 * @param {object} aiInput - Payload que viene del front (AiItineraryInput)
 * @param {object} [options]
 * @param {string} [options.extraInstructions] - Texto adicional para afinar el comportamiento.
 * @returns {Promise<object>} - Objeto JSON parseado con la respuesta del modelo.
 */
async function generateItineraryResponse(aiInput, options = {}) {
  if (!aiInput) {
    throw new Error('aiInput is required');
  }

  const { extraInstructions } = options;

  const systemInstruction = `
You are IBeento itinerary planner.
Goal: return a valid, high-quality, day-complete plan in one pass.

Hard rules:
- Output ONLY valid JSON.
- Use ONLY IDs from input (activities._id, itinerary.items._id).
- Prefer concrete operations: add_activity, update_activity, remove_activity, reorder_activity.
- Respect chronology; avoid overlap in the same day.
- Never place an add_activity in a time slot that is already used by an update_activity or reorder_activity.
- If you update/reorder an existing itinerary item for a slot, do not add another activity overlapping that same slot.
- Use geo proximity when activities/itinerary items include geo (lng/lat); prefer nearby sequences.
- Prioritize favorites.activityIds and favorites.topActivityCategoryIds (favorites > inertia).
- Fill each trip day with 2-4 activities when candidates allow.
- For EVERY day in trip range, include at least:
  - 1 morning activity (09:00-12:30)
  - 1 afternoon activity (14:00-19:30)
- Keep all activities within active window; if wake/sleep missing, use existing itinerary pattern.
- Keep 30-90 min buffer between consecutive activities.
- defaultDurationMin is a baseline only; you may extend/shorten duration when it improves pacing and day quality.
- Avoid leaving a day with <2 activities unless candidate set is insufficient.
${extraInstructions || ''}
  `.trim();

  const userPrompt = `
USER_TRIP_INPUT (JSON):
${JSON.stringify(aiInput)}

Return ONLY valid JSON with this minimal structure:
{
  "dayPlan": [
    { "day": "YYYY-MM-DD", "activityIds": ["id1","id2"] }
  ],
  "actions": [
    {
      "type": "add_activity" | "update_activity" | "remove_activity" | "reorder_activity",
      "itineraryItemId": string | null,
      "activityId": string | null,
      "timelineStartDate": string | null,
      "timelineEndDate": string | null
    }
  ],
  "meta": {
    "planQuality": number | null
  }
}
Constraints:
1) Do not invent IDs.
2) If itinerary is empty and activities exist, return add_activity actions with timelineStartDate.
3) Return up to 8 actions.
4) Keep output compact (no explanations).
5) Prioritize day coverage and schedule quality over narrative.
6) You can modify duration by adjusting timelineEndDate (not fixed to defaultDurationMin).
7) Before final output, self-check: every day has morning+afternoon coverage.
8) Do not return conflicting actions for the same time slot (especially add vs update/reorder).
  `.trim();

  const modelsToTry = [DEFAULT_MODEL_ID, ...FALLBACK_MODEL_IDS];
  console.log(`${AI_LOG_PREFIX} request`, {
    modelsToTry,
    visitPlaces: Array.isArray(aiInput?.tripContext?.visitPlaces) ? aiInput.tripContext.visitPlaces.length : 0,
    itineraryItems: Array.isArray(aiInput?.itinerary?.items) ? aiInput.itinerary.items.length : 0,
    activities: Array.isArray(aiInput?.activities) ? aiInput.activities.length : 0,
  });
  const failures = [];

  for (let i = 0; i < modelsToTry.length; i += 1) {
    const modelId = modelsToTry[i];
    const attempt = i + 1;
    const out = await generateWithModel(modelId, systemInstruction, userPrompt, attempt);
    if (out.ok) {
      console.log(`${AI_LOG_PREFIX} request:success`, {
        modelId,
        attempt,
        actions: Array.isArray(out?.data?.actions) ? out.data.actions.length : 0,
      });
      if (failures.length) {
        return {
          ...out.data,
          diagnostics: {
            fallbackUsed: attempt > 1,
            failures,
          },
        };
      }
      return out.data;
    }
    failures.push(out.data);
  }

  console.warn(`${AI_LOG_PREFIX} request:all-failed`, {
    attempts: failures.length,
    lastParsingError: failures[failures.length - 1]?.parsingError || null,
  });

  // Fallaron todos los modelos: devolvemos el ultimo error + historial.
  const last = failures[failures.length - 1] || {
    rawText: null,
    parsingError: 'Gemini request failed',
  };

  return {
    ...last,
    diagnostics: {
      fallbackUsed: failures.length > 1,
      failures,
    },
  };
}

/**
 * Uses Gemini to identify the primary place featured in a social post.
 * Returns the index of the best candidate from the list, or -1 if it can't decide.
 *
 * @param {string} text - Full caption/metadata text of the post
 * @param {Array<{label: string, source: string, context?: string}>} candidates - Extracted candidates
 * @returns {Promise<number>} - 0-based index of the primary candidate, or -1
 */
async function selectPrimaryPlaceWithAI(text = '', candidates = []) {
  if (!candidates.length || !text) return -1;

  const candidateList = candidates
    .map((c, i) => `${i}: "${c.label}"${c.context ? ` (context: ${c.context})` : ''} [source: ${c.source}]`)
    .join('\n');

  const systemInstruction = `You are a place-extraction assistant. Given the caption or metadata of a social media post and a list of place candidates, identify which single candidate is the PRIMARY subject of the post — i.e., the place the video is actually about or filmed at. Respond with ONLY a JSON object: {"index": <number>}. If you cannot determine a primary place with confidence, respond with {"index": -1}.`;

  const userPrompt = `POST TEXT:\n${String(text).slice(0, 3000)}\n\nCANDIDATES:\n${candidateList}`;

  try {
    const result = await generateWithModel(DEFAULT_MODEL_ID, systemInstruction, userPrompt, 0);
    if (result?.ok && typeof result.data?.index === 'number') {
      const idx = result.data.index;
      return idx >= 0 && idx < candidates.length ? idx : -1;
    }
    // Try flash as fallback for speed
    const fallback = await generateWithModel('gemini-2.5-flash', systemInstruction, userPrompt, 0);
    if (fallback?.ok && typeof fallback.data?.index === 'number') {
      const idx = fallback.data.index;
      return idx >= 0 && idx < candidates.length ? idx : -1;
    }
  } catch (err) {
    console.warn('[Gemini][selectPrimaryPlace] error', err?.message);
  }
  return -1;
}

module.exports = {
  generateItineraryResponse,
  extractPlacesFromSocialContent,
  extractLocationContextFromSocialContent,
  selectPrimaryPlaceWithAI,
};
