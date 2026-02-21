// src/services/activity/activity-scoring.service.js

const User = require('../../models/User');
const UserFavorite = require('../../models/UserFavorite');

/**
 * Score activities for a given user (or anonymous).
 *
 * @param {Array} activities - raw list from discover()
 * @param {String|null} userId
 * @returns {Array} sorted activities with "score" field
 */
async function scoreActivitiesForUser(activities, userId) {

  if (!activities || activities.length === 0) {
    return [];
  }

  // ------------------------------------------------------
  // 1. Load explicit user preferences
  // ------------------------------------------------------
  let userPreferences = {
    trip: {
      activityCategories: [],
      serviceCategories: [],
      tags: []
    }
  };

  if (userId) {
    const user = await User.findById(userId).lean();
    if (user?.preferences?.trip) {
      userPreferences = {
        trip: {
          activityCategories: user.preferences.trip.activityCategories || [],
          serviceCategories: user.preferences.trip.serviceCategories || [],
          tags: user.preferences.trip.tags || []
        }
      };
    }
  }

  // ------------------------------------------------------
  // 2. Favorite signals (explicit user behavior)
  // ------------------------------------------------------
  const favoriteActivityIds = new Set(); // activityId directly favorited by user
  const favoriteCityIds = new Set();
  const favoriteRegionIds = new Set();
  const favoriteCountryIds = new Set();

  if (userId) {
    const favorites = await UserFavorite.find({ userId })
      .select('type activityId cityId regionId countryId')
      .lean();

    for (const fav of favorites) {
      if (fav?.type === 'activity' && fav?.activityId) {
        favoriteActivityIds.add(String(fav.activityId));
      }
      if (fav?.cityId) favoriteCityIds.add(String(fav.cityId));
      if (fav?.regionId) favoriteRegionIds.add(String(fav.regionId));
      if (fav?.countryId) favoriteCountryIds.add(String(fav.countryId));
    }
  }

  // ------------------------------------------------------
  // 3. Score each activity
  // ------------------------------------------------------
  const scored = activities.map(a => {
    let score = 0;



    // ------------------------------
    // A) Rating & reviews (baseline)
    // ------------------------------
    const rating = a.ranking?.ratingAvg ?? 0;
    const reviews = a.ranking?.reviewsCount ?? 0;

    // Rating base (0–50)
    const ratingScore = rating * 10; // 4.8 → 48 pts

    // Reviews con todavía más impacto:
    //  - Cap en 3000 reviews
    //  - Escala lineal a 0–100 (3000 → 100 pts)
    //  - Con peso alto en el score final
    const cappedReviews = Math.min(reviews, 100000);
    const reviewScore = cappedReviews / 1000; // 3000 → 100 pts

    // Mucho más sesgo hacia actividades con muchos reviews
    score += ratingScore * 0.2; // 10% rating
    score += reviewScore * 0.6; // 80% reviews → ranking fuertemente dominado por volumen de reviews

    // ------------------------------
    // B) Explicit preferences
    // ------------------------------
    let explicitScore = 0;

    if (Array.isArray(a.tags)) {
      for (const t of a.tags) {
        if (userPreferences.trip.tags.includes(String(t))) {
          explicitScore += 8; // strong match
        }
      }
    }


    const preferredActivityCategories =
      Array.isArray(userPreferences.trip.activityCategories) && userPreferences.trip.activityCategories.length
        ? userPreferences.trip.activityCategories
        : (Array.isArray(userPreferences.trip.serviceCategories) ? userPreferences.trip.serviceCategories : []);

    const activityCategoryIds = Array.isArray(a.activityCategoryIds)
      ? a.activityCategoryIds.map((x) => String(x))
      : [];

    for (const categoryId of activityCategoryIds) {
      if (preferredActivityCategories.includes(String(categoryId))) {
        explicitScore += 6;
      }
    }

    score += explicitScore * 0.2; // 20%

    // ------------------------------
    // C) Favorite boost
    // ------------------------------
    const activityId = a?._id ? String(a._id) : null;
    if (activityId && favoriteActivityIds.has(activityId)) {
      // Strong boost for activities the user explicitly favorited.
      score += 35;
    }

    const cityId = a?.location?.cityId?._id
      ? String(a.location.cityId._id)
      : (a?.location?.cityId ? String(a.location.cityId) : null);
    const regionId = a?.location?.regionId?._id
      ? String(a.location.regionId._id)
      : (a?.location?.regionId ? String(a.location.regionId) : null);
    const countryId = a?.location?.countryId?._id
      ? String(a.location.countryId._id)
      : (a?.location?.countryId ? String(a.location.countryId) : null);

    // Light contextual boosts to keep "familiar" areas near top without
    // destroying global relevance.
    if (cityId && favoriteCityIds.has(cityId)) score += 6;
    if (regionId && favoriteRegionIds.has(regionId)) score += 4;
    if (countryId && favoriteCountryIds.has(countryId)) score += 2;

    // ------------------------------
    // Normalize score (0–100)
    // ------------------------------
    if (score > 100) score = 100;
    if (score < 0) score = 0;

    return { ...a, score };
  });


  // ------------------------------------------------------
  // 4. Sort by score DESC
  // ------------------------------------------------------
  return scored.sort((a, b) => b.score - a.score);
}

module.exports = {
  scoreActivitiesForUser
};
