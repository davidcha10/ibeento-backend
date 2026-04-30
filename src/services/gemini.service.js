const { GoogleGenerativeAI } = require('@google/generative-ai');
const AI_LOG_PREFIX = '[AI][gemini]';

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

module.exports = {
  generateItineraryResponse,
};
