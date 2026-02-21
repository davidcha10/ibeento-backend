const mongoose = require('mongoose');
const UserFavorite = require('../models/UserFavorite');

// Create (toggle on)
exports.create = async (req, res) => {
  try {
    const { userId, type, serviceId, activityId, name, photoUrl, cityId, regionId, countryId } = req.body;

    //const userId = req.user || req.body.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'User not authenticated' });
    }


    if (!type) {
      return res.status(400).json({ success: false, message: 'Type is required' });
    }

    if (!serviceId && !activityId) {
      return res.status(400).json({
        success: false,
        message: 'serviceId or activityId is required'
      });
    }

    // Build query matching the unique indexes:
    // - (userId + type + serviceId) for service-based favorites
    // - (userId + type + activityId) for activity-based favorites
    const isActivity = type === 'activity';

    const filter = {
      userId,
      type,
      ...(isActivity
        ? { activityId: activityId || null }
        : { serviceId: serviceId || null }),
    };

    // Check if it already exists (toggle semantics)
    const existing = await UserFavorite.findOne(filter).lean();
    if (existing) {
      return res
        .status(200)
        .json({ success: true, favorite: existing, duplicated: true });
    }

    const fav = await UserFavorite.create({
      userId,
      type,
      serviceId: isActivity ? null : (serviceId || null),
      activityId: isActivity ? (activityId || null) : null,
      name,
      photoUrl,
      cityId,
      regionId,
      countryId,
    });

    return res.status(201).json({ success: true, favorite: fav });
  } catch (err) {
    console.error('[UserFavorite] Add error:', err);
    return res.status(500).json({ success: false, message: 'Failed to add favorite', error: err.message });
  }
};


// List favorites for authenticated user
exports.list = async (req, res) => {
  try {
    const userId = req.user?._id;
    if (!userId) {
      return res
        .status(401)
        .json({ success: false, message: 'User not authenticated' });
    }

    // Populate activityId / serviceId and luego exponemos como activity / service
    const favoritesDocs = await UserFavorite.find({ userId })
      .sort({ createdAt: -1 })
      .populate({ path: 'activityId', model: 'Activity' })
      .populate({ path: 'serviceId', model: 'Service' });

    const favorites = favoritesDocs.map((doc) => {
      const fav = doc.toObject({ virtuals: true });

      if (fav.type === 'activity' && fav.activityId) {
        fav.activity = fav.activityId;
      } else if (fav.type !== 'activity' && fav.serviceId) {
        fav.service = fav.serviceId;
      }

      return fav;
    });

    return res.status(200).json({ success: true, favorites });
  } catch (err) {
    console.error('[UserFavorite] List error:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch favorites',
      error: err.message,
    });
  }
};

// Remove
exports.remove = async (req, res) => {
  try {
    const userId = req.user?._id;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'User not authenticated' });
    }

    const { id } = req.params;
    const deleted = await UserFavorite.findOneAndDelete({ _id: id, userId });

    if (!deleted) {
      return res.status(404).json({ success: false, message: 'Favorite not found' });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[UserFavorite] Remove error:', err);
    return res.status(500).json({ success: false, message: 'Failed to remove favorite', error: err.message });
  }
};


// Top favorite tags for authenticated user
exports.topTags = async (req, res) => {
  try {
    const rawUserId = req.user?._id || req.query.userId || req.body.userId;
    if (!rawUserId) {
      return res.status(401).json({ success: false, message: 'User not authenticated' });
    }

    const userId = typeof rawUserId === 'string'
      ? new mongoose.Types.ObjectId(rawUserId)
      : rawUserId;

    const limit = Math.min(Math.max(parseInt(req.query.limit || '10', 10), 1), 50);

    const tags = await UserFavorite.aggregate([
      {
        $match: {
          userId,
          $or: [
            { activityId: { $ne: null } },
            { serviceId: { $ne: null } },
          ],
        },
      },
      {
        $lookup: {
          from: 'activities',
          localField: 'activityId',
          foreignField: '_id',
          as: 'activity',
        },
      },
      {
        $lookup: {
          from: 'services',
          localField: 'serviceId',
          foreignField: '_id',
          as: 'service',
        },
      },
      {
        $project: {
          tagsIds: {
            $cond: [
              { $eq: ['$type', 'activity'] },
              // Para favoritos de tipo "activity" usamos el campo "tags" del Activity populado
              { $ifNull: [{ $arrayElemAt: ['$activity.tags', 0] }, []] },
              // Para el resto (services, etc.), usamos el campo "tags" del Service populado
              { $ifNull: [{ $arrayElemAt: ['$service.tags', 0] }, []] },
            ],
          },
        },
      },
      { $unwind: '$tagsIds' },
      {
        $group: {
          _id: '$tagsIds',
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
      { $limit: limit },
      {
        $lookup: {
          from: 'servicetags',
          localField: '_id',
          foreignField: '_id',
          as: 'tag',
        },
      },
      { $unwind: '$tag' },
      {
        $project: {
          _id: '$tag._id',
          name: '$tag.name',
          slug: '$tag.slug',
          count: 1,
        },
      },
    ]);

    return res.status(200).json({ success: true, tags });
  } catch (err) {
    console.error('[UserFavorite] topTags error:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch favorite tags',
      error: err.message,
    });
  }
};
