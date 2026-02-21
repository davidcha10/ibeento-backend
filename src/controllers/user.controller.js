const User = require('../models/User');
const UserFavorite = require('../models/UserFavorite');
const ServiceCategory = require('../models/serviceCategory');

// Get current authenticated user
exports.me = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
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
    const updates = req.body;

    const user = await User.findByIdAndUpdate(
      req.user.id,
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

    allowedFields.forEach(field => {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    });

    const user = await User.findByIdAndUpdate(
      req.user.id,
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

// Get user preference analytics (tags + service categories) based on favorites
exports.getPreferenceAnalytics = async (req, res) => {
  try {
    const userId = req.user.id;

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