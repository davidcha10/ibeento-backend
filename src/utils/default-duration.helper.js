/**
 * Helper para estimar una duración por defecto (rango) en minutos
 * basado en los place types de Google.
 *
 * La idea es:
 *  - Recibir un array de tipos de Google (googleTypes / place types).
 *  - Detectar a qué "macro-categorías" pertenece (Cultura, Entretenimiento, Comidas).
 *  - Ajustar un rango [minMinutes, maxMinutes] razonable.
 *  - Marcar el source como 'tags' para dejar claro de dónde sale.
 *
 * Nota: Los valores son heurísticos iniciales pensados para IBeento.
 * Más adelante podemos refinarlos con analítica real o IA.
 */

/** Tags de Google por macro-categoría **/

const CULTURE_TAGS = new Set([
  'art_gallery',
  'art_studio',
  'auditorium',
  'cultural_landmark',
  'historical_place',
  'monument',
  'museum',
  'performing_arts_theater',
  'sculpture',
  'cultural_center',
  'historical_landmark',
  'planetarium',
  'plaza',
]);

const ENTERTAINMENT_TAGS = new Set([
  'adventure_sports_center',
  'amphitheatre',
  'amusement_center',
  'amusement_park',
  'aquarium',
  'banquet_hall',
  'barbecue_area',
  'botanical_garden',
  'bowling_alley',
  'casino',
  'childrens_camp',
  'comedy_club',
  'community_center',
  'concert_hall',
  'convention_center',
  'cycling_park',
  'dance_hall',
  'dog_park',
  'event_venue',
  'ferris_wheel',
  'garden',
  'hiking_area',
  'internet_cafe',
  'karaoke',
  'marina',
  'movie_rental',
  'movie_theater',
  'national_park',
  'night_club',
  'observation_deck',
  'off_roading_area',
  'opera_house',
  'park',
  'philharmonic_hall',
  'picnic_ground',
  'roller_coaster',
  'skateboard_park',
  'state_park',
  'tourist_attraction',
  'video_arcade',
  'visitor_center',
  'water_park',
  'wedding_venue',
  'wildlife_park',
  'wildlife_refuge',
  'zoo',
]);

const FOOD_TAGS = new Set([
  'acai_shop',
  'afghani_restaurant',
  'african_restaurant',
  'american_restaurant',
  'asian_restaurant',
  'bagel_shop',
  'bakery',
  'bar',
  'bar_and_grill',
  'barbecue_restaurant',
  'brazilian_restaurant',
  'breakfast_restaurant',
  'brunch_restaurant',
  'buffet_restaurant',
  'cafe',
  'cafeteria',
  'candy_store',
  'cat_cafe',
  'chinese_restaurant',
  'chocolate_factory',
  'chocolate_shop',
  'coffee_shop',
  'confectionery',
  'deli',
  'dessert_restaurant',
  'dessert_shop',
  'diner',
  'dog_cafe',
  'donut_shop',
  'fast_food_restaurant',
  'fine_dining_restaurant',
  'food_court',
  'french_restaurant',
  'greek_restaurant',
  'hamburger_restaurant',
  'ice_cream_shop',
  'indian_restaurant',
  'indonesian_restaurant',
  'italian_restaurant',
  'japanese_restaurant',
  'juice_shop',
  'korean_restaurant',
  'lebanese_restaurant',
  'meal_delivery',
  'meal_takeaway',
  'mediterranean_restaurant',
  'mexican_restaurant',
  'middle_eastern_restaurant',
  'pizza_restaurant',
  'pub',
  'ramen_restaurant',
  'restaurant',
  'sandwich_shop',
  'seafood_restaurant',
  'spanish_restaurant',
  'steak_house',
  'sushi_restaurant',
  'tea_house',
  'thai_restaurant',
  'turkish_restaurant',
  'vegan_restaurant',
  'vegetarian_restaurant',
  'vietnamese_restaurant',
  'wine_bar',
]);

/**
 * Algunos tags marcados con * en tu listado indican actividades más “long form”
 * (tour complejo, experiencia larga, parque grande, etc.).
 * Los usamos para extender un poco el rango base.
 */
const LONG_FORM_TAGS = new Set([
  // Cultura
  'art_studio',
  'museum',
  'auditorium',
  'planetarium',
  'cultural_landmark',
  // Entretenimiento
  'adventure_sports_center',
  'amphitheatre',
  'botanical_garden',
  'childrens_camp',
  'comedy_club',
  'concert_hall',
  'cycling_park',
  'ferris_wheel',
  'garden',
  'hiking_area',
  'off_roading_area',
  'opera_house',
  'philharmonic_hall',
  'video_arcade',
  'water_park',
  'wildlife_park',
  // Comida
  'fine_dining_restaurant',
]);

/**
 * Calcula un rango base en función de las categorías detectadas.
 *
 * Cultura solamente       → 90–150 min
 * Entretenimiento solo    → 90–180 min
 * Comida solamente        → 45–90 min
 * Cultura + Entretenimiento → 120–210 min
 * Cultura + Comida          → 90–150 min
 * Entretenimiento + Comida  → 90–180 min
 * Mixto / genérico          → 90–150 min
 *
 * Luego, si encontramos tags "long form", extendemos un poco el rango.
 */
function computeBaseRangeFromCategories({ hasCulture, hasEntertainment, hasFood }) {
  let min = 90;
  let max = 150;

  if (hasFood && !hasCulture && !hasEntertainment) {
    // Solo comida: sentarse, comer, quizá postre
    min = 45;
    max = 90;
  } else if (hasEntertainment && !hasCulture && !hasFood) {
    // Solo entretenimiento: actividades, parques, etc.
    min = 90;
    max = 180;
  } else if (hasCulture && !hasEntertainment && !hasFood) {
    // Solo cultura: museo, galería, sitio histórico
    min = 90;
    max = 150;
  } else if (hasCulture && hasEntertainment) {
    // Cultura + entretenimiento: tours largos, complejos
    min = 120;
    max = 210;
  } else if (hasCulture && hasFood) {
    // Cultura + comida: plan combinado, pero no necesariamente maratón
    min = 90;
    max = 150;
  } else if (hasEntertainment && hasFood) {
    // Entretenimiento + comida
    min = 90;
    max = 180;
  } else {
    // Genérico/default
    min = 90;
    max = 150;
  }

  return { min, max };
}

/**
 * Aumenta el rango si encontramos tags que suelen implicar experiencias más largas.
 */
function extendRangeForLongForm({ min, max }, hasLongForm) {
  if (!hasLongForm) return { min, max };
  return {
    min: min + 30,
    max: max + 30,
  };
}

/**
 * Estima el rango de duración por defecto para una actividad, a partir
 * de los Google place types / tags.
 *
 * @param {string[]} googleTypes - lista de place types de Google asociadas al lugar
 * @returns {{ minMinutes: number, maxMinutes: number, source: 'tags' }}
 */
function estimateDefaultDurationFromTags(googleTypes = []) {
  const types = Array.from(new Set(googleTypes || []));

  const hasCulture = types.some((t) => CULTURE_TAGS.has(t));
  const hasEntertainment = types.some((t) => ENTERTAINMENT_TAGS.has(t));
  const hasFood = types.some((t) => FOOD_TAGS.has(t));

  const hasLongForm = types.some((t) => LONG_FORM_TAGS.has(t));

  let { min, max } = computeBaseRangeFromCategories({
    hasCulture,
    hasEntertainment,
    hasFood,
  });

  ({ min, max } = extendRangeForLongForm({ min, max }, hasLongForm));

  // Valores de seguridad si algo sale muy raro
  if (!Number.isFinite(min) || min <= 0) min = 90;
  if (!Number.isFinite(max) || max <= 0 || max < min) max = min + 60;

  return {
    minMinutes: min,
    maxMinutes: max,
    source: 'tags',
  };
}

/**
 * Helper opcional: a partir de un objeto defaultDurationMin,
 * calcula un valor efectivo en minutos (p. ej. promedio del rango).
 *
 * @param {{ minMinutes?: number, maxMinutes?: number }} defaultDurationMin
 * @returns {number} minutos efectivos
 */
function getEffectiveDurationMinutes(defaultDurationMin) {
  if (!defaultDurationMin) return 120;

  const { minMinutes, maxMinutes } = defaultDurationMin;

  if (typeof minMinutes === 'number' && typeof maxMinutes === 'number') {
    return Math.round((minMinutes + maxMinutes) / 2);
  }

  if (typeof minMinutes === 'number') return minMinutes;
  if (typeof maxMinutes === 'number') return maxMinutes;

  return 120;
}

module.exports = {
  estimateDefaultDurationFromTags,
  getEffectiveDurationMinutes,
};
