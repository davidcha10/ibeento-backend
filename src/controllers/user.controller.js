const User = require('../models/User');
const UserFavorite = require('../models/UserFavorite');
const ServiceCategory = require('../models/serviceCategory');
const Session = require('../models/Session');
const UserPreference = require('../models/UserPreference');
const OnboardingResponse = require('../models/OnboardingResponse');
const Itinerary = require('../models/Itinerary');
const ItineraryItem = require('../models/ItineraryItem');
const ProviderProfile = require('../models/Provider');
const ProviderGuestLink = require('../models/ProviderGuestLink');
const { Service } = require('../models/Service');
const BusinessUnit = require('../models/BusinessUnit');
const Activity = require('../models/Activity');
const UserSubscription = require('../models/UserSubscription');
const BillingTransaction = require('../models/BillingTransaction');

function getAuthenticatedUserId(req) {
  return req.user?._id || req.user?.id || null;
}

// Get current authenticated user
exports.me = async (req, res) => {
  try {
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    const user = await User.findById(userId);
    if (!user)
      return res.status(404).json({ success: false, message: 'User not found' });

    res.status(200).json({ success: true, data: user });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// Update explicit user preferences
exports.updatePreferences = async (req, res) => {
  try {
    const updates = (req.body && typeof req.body === 'object' && !Array.isArray(req.body))
      ? { ...req.body }
      : {};
    // Keep onboarding state at root-level user.onboarding only.
    if (Object.prototype.hasOwnProperty.call(updates, 'onboarding')) {
      delete updates.onboarding;
    }
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const user = await User.findByIdAndUpdate(
      userId,
      { preferences: updates },
      { new: true }
    );

    if (!user)
      return res.status(404).json({ success: false, message: 'User not found' });

    res.status(200).json({ success: true, data: user.preferences });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// Update profile (name, avatar, nationality, etc.)
exports.updateProfile = async (req, res) => {
  try {
    const allowedFields = ['name', 'nationality', 'profile'];
    const updates = {};
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    allowedFields.forEach(field => {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    });

    const user = await User.findByIdAndUpdate(
      userId,
      updates,
      { new: true }
    );

    if (!user)
      return res.status(404).json({ success: false, message: 'User not found' });

    res.status(200).json({ success: true, data: user });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// Get any user by ID (admin only)
exports.get = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user)
      return res.status(404).json({ success: false, message: 'User not found' });

    res.status(200).json({ success: true, data: user });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// Soft delete user (status = deleted)
exports.deactivate = async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { status: 'deleted' },
      { new: true }
    );

    if (!user)
      return res.status(404).json({ success: false, message: 'User not found' });

    res.status(200).json({ success: true, data: user });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// Restore user
exports.restore = async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { status: 'active' },
      { new: true }
    );

    if (!user)
      return res.status(404).json({ success: false, message: 'User not found' });

    res.status(200).json({ success: true, data: user });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// Hard delete user
exports.remove = async (req, res) => {
  try {
    const user = await User.findByIdAndDelete(req.params.id);

    if (!user)
      return res.status(404).json({ success: false, message: 'User not found' });

    res.status(200).json({ success: true, message: 'User permanently deleted' });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// Self account deletion (authenticated user)
exports.removeMe = async (req, res) => {
  try {
    const userId = String(req.user?._id || req.user?.id || '').trim();
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const user = await User.findById(userId).select('_id');
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Remove user itineraries and linked itinerary items.
    const itineraries = await Itinerary.find({ userId: user._id }).select('_id');
    const itineraryIds = itineraries.map((it) => it._id);
    if (itineraryIds.length) {
      await ItineraryItem.deleteMany({ itineraryId: { $in: itineraryIds } });
    }
    await Itinerary.deleteMany({ userId: user._id });

    // Remove provider-owned data created by this user.
    const providerProfiles = await ProviderProfile.find({ userId: user._id }).select('_id');
    const providerIds = providerProfiles.map((p) => p._id);
    let serviceIds = [];
    if (providerIds.length) {
      const services = await Service.find({ providerId: { $in: providerIds } }).select('_id');
      serviceIds = services.map((s) => s._id);
      if (serviceIds.length) {
        await Service.deleteMany({ _id: { $in: serviceIds } });
      }
      await ProviderGuestLink.deleteMany({ providerId: { $in: providerIds } });
      await ProviderProfile.deleteMany({ _id: { $in: providerIds } });
    }

    // Remove business-unit data owned by this user and related business-owned activities.
    const businessUnits = await BusinessUnit.find({ user: user._id }).select('_id');
    const businessUnitIds = businessUnits.map((bu) => bu._id);
    if (businessUnitIds.length) {
      await Activity.deleteMany({
        $or: [
          { 'ownership.mode': 'business_unit', 'ownership.businessUnitId': { $in: businessUnitIds } },
          ...(serviceIds.length ? [{ 'ownership.createdFromServiceId': { $in: serviceIds } }] : []),
        ],
      });
      await BusinessUnit.deleteMany({ _id: { $in: businessUnitIds } });
    }

    // Remove user-scoped support documents.
    await Promise.all([
      Session.deleteMany({ userId: user._id }),
      UserFavorite.deleteMany({ userId: user._id }),
      UserPreference.deleteMany({ userId: user._id }),
      OnboardingResponse.deleteMany({ userId: user._id }),
      UserSubscription.deleteMany({ userId: user._id }),
      BillingTransaction.deleteMany({ userId: user._id }),
    ]);

    await User.deleteOne({ _id: user._id });

    // Ensure refresh token cookie is removed server-side.
    res.clearCookie('refresh_token', {
      path: '/api/auth',
      domain: process.env.COOKIE_DOMAIN || 'localhost',
    });

    return res.status(200).json({
      success: true,
      message: 'Your account was permanently deleted.',
    });
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message });
  }
};

// Get user preference analytics (tags + service categories) based on favorites
exports.getPreferenceAnalytics = async (req, res) => {
  try {
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    // TAGS AGGREGATION (derived from Activity.tags and Experience.tags via lookup)
    const [tagsFromActivities, tagsFromExperiences] = await Promise.all([
      // Favorites linked to Activities
      UserFavorite.aggregate([
        { $match: { userId, activityId: { $exists: true, $ne: null } } },
        {
          $lookup: {
            from: 'activities',
            localField: 'activityId',
            foreignField: '_id',
            as: 'activity'
          }
        },
        { $unwind: '$activity' },
        { $unwind: '$activity.tags' },
        {
          $group: {
            _id: '$activity.tags',
            count: { $sum: 1 }
          }
        }
      ]),
      // Favorites linked to Experiences
      UserFavorite.aggregate([
        { $match: { userId, experienceId: { $exists: true, $ne: null } } },
        {
          $lookup: {
            from: 'experiences',
            localField: 'experienceId',
            foreignField: '_id',
            as: 'experience'
          }
        },
        { $unwind: '$experience' },
        { $unwind: '$experience.tags' },
        {
          $group: {
            _id: '$experience.tags',
            count: { $sum: 1 }
          }
        }
      ])
    ]);

    // Merge tag counts from activities and experiences
    const tagCountMap = {};

    tagsFromActivities.forEach(item => {
      const key = String(item._id);
      tagCountMap[key] = (tagCountMap[key] || 0) + item.count;
    });

    tagsFromExperiences.forEach(item => {
      const key = String(item._id);
      tagCountMap[key] = (tagCountMap[key] || 0) + item.count;
    });

    const tags = Object.entries(tagCountMap)
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count);

    // SERVICE CATEGORIES AGGREGATION
    // Assumes UserFavorite has a `serviceCategory` field (ObjectId -> ServiceCategory)
    const serviceCategoriesAgg = await UserFavorite.aggregate([
      { $match: { userId, serviceCategory: { $exists: true, $ne: null } } },
      { $group: { _id: '$serviceCategory', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    // Optionally enrich with ServiceCategory name/slug
    const serviceCategoryIds = serviceCategoriesAgg.map(item => item._id);
    const serviceCategoriesMap = await ServiceCategory.find({ _id: { $in: serviceCategoryIds } })
      .select('_id name slug')
      .then(rows =>
        rows.reduce((acc, row) => {
          acc[String(row._id)] = { name: row.name, slug: row.slug };
          return acc;
        }, {})
      );

    const serviceCategories = serviceCategoriesAgg.map(item => {
      const info = serviceCategoriesMap[String(item._id)] || {};
      return {
        serviceCategoryId: item._id,
        name: info.name,
        slug: info.slug,
        count: item.count
      };
    });

    return res.status(200).json({
      success: true,
      data: {
        tags,
        serviceCategories
      }
    });
  } catch (err) {
    console.error('User.getPreferenceAnalytics error:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
};
