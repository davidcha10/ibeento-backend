const mongoose = require('mongoose');

const Activity = require('../models/Activity');
const ActivityComment = require('../models/ActivityComment');

function serializeComment(row) {
  const userObj = row?.userId && typeof row.userId === 'object' ? row.userId : null;
  const authorId = String(userObj?._id || row?.userId || '').trim();
  const authorName = String(userObj?.name || row?.authorNameSnapshot || '').trim() || 'Traveler';

  return {
    _id: String(row?._id || ''),
    activityId: String(row?.activityId || ''),
    text: String(row?.text || ''),
    createdAt: row?.createdAt || null,
    updatedAt: row?.updatedAt || null,
    author: {
      _id: authorId || null,
      name: authorName,
    },
  };
}

exports.listByActivity = async (req, res) => {
  try {
    const activityId = String(req.params.id || '').trim();
    if (!mongoose.Types.ObjectId.isValid(activityId)) {
      return res.status(400).json({ success: false, message: 'Invalid activityId' });
    }

    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.round(limitRaw), 1), 50) : 20;

    const rows = await ActivityComment.find({
      activityId,
      active: true,
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate({ path: 'userId', select: 'name' })
      .lean();

    return res.status(200).json({
      success: true,
      comments: rows.map((row) => serializeComment(row)),
    });
  } catch (err) {
    console.error('[ActivityComment] listByActivity error:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch comments',
      error: err?.message || 'unknown_error',
    });
  }
};

exports.createForActivity = async (req, res) => {
  try {
    const activityId = String(req.params.id || '').trim();
    if (!mongoose.Types.ObjectId.isValid(activityId)) {
      return res.status(400).json({ success: false, message: 'Invalid activityId' });
    }

    const userId = req.user?._id;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const text = String(req.body?.text || '').trim();
    if (text.length < 2) {
      return res.status(400).json({ success: false, message: 'Comment must be at least 2 characters.' });
    }
    if (text.length > 1200) {
      return res.status(400).json({ success: false, message: 'Comment must be 1200 characters or less.' });
    }

    const activity = await Activity.findById(activityId).select('_id ranking.reviewsCount');
    if (!activity) {
      return res.status(404).json({ success: false, message: 'Activity not found' });
    }

    const created = await ActivityComment.create({
      activityId,
      userId,
      text,
      authorNameSnapshot: String(req.user?.name || '').trim(),
      active: true,
    });

    const hydrated = await ActivityComment.findById(created._id)
      .populate({ path: 'userId', select: 'name' })
      .lean();

    const reviewsCount = await ActivityComment.countDocuments({ activityId, active: true });
    await Activity.updateOne(
      { _id: activityId },
      { $set: { 'ranking.reviewsCount': Number(reviewsCount) } }
    );

    return res.status(201).json({
      success: true,
      comment: serializeComment(hydrated || created),
      reviewsCount: Number(reviewsCount),
    });
  } catch (err) {
    console.error('[ActivityComment] createForActivity error:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to create comment',
      error: err?.message || 'unknown_error',
    });
  }
};
