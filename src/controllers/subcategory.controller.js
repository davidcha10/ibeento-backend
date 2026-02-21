

const mongoose = require('mongoose');
const Subcategory = require('../models/Subcategory');

// List subcategories with pagination, filters, sorting
exports.list = async (req, res, next) => {
  try {
    let {
      page = 1,
      limit = 20,
      skip = 0,
      sort = '-createdAt',
      categoryId,
      active,
      q
    } = req.query;
    page = parseInt(page, 10);
    limit = parseInt(limit, 10);
    skip = parseInt(skip, 10);
    const filter = {};
    if (categoryId) {
      if (!mongoose.Types.ObjectId.isValid(categoryId)) {
        return res.status(400).json({ message: 'Invalid categoryId' });
      }
      filter.category = categoryId;
    }
    if (typeof active !== 'undefined') {
      filter.active = active === 'true' || active === true;
    }
    if (q) {
      // Search in all translations of 'name'
      filter['$or'] = [
        { 'name.en': { $regex: q, $options: 'i' } },
        { 'name.es': { $regex: q, $options: 'i' } },
        { 'name.fr': { $regex: q, $options: 'i' } },
        { 'name.de': { $regex: q, $options: 'i' } },
        { 'name.ru': { $regex: q, $options: 'i' } },
        { 'name': { $regex: q, $options: 'i' } }
      ];
    }
    const docs = await Subcategory.find(filter)
      .sort(sort)
      .skip(skip + (page - 1) * limit)
      .limit(limit);
    const total = await Subcategory.countDocuments(filter);
    res.json({
      data: docs,
      total,
      page,
      limit
    });
  } catch (err) {
    next(err);
  }
};

// Get a single subcategory by id
exports.get = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid subcategory id' });
    }
    const doc = await Subcategory.findById(id);
    if (!doc) {
      return res.status(404).json({ message: 'Subcategory not found' });
    }
    res.json(doc);
  } catch (err) {
    next(err);
  }
};

// Create a new subcategory
exports.create = async (req, res, next) => {
  try {
    const { name } = req.body;
    const { categoryId } = req.params;
    if (!name || !categoryId) {
      return res.status(400).json({ message: 'Missing required fields: name, categoryId' });
    }
    if (!mongoose.Types.ObjectId.isValid(categoryId)) {
      return res.status(400).json({ message: 'Invalid category id' });
    }
    //req.body.category = categoryId;
    const subcategory = new Subcategory(req.body);
    await subcategory.save();
    res.status(201).json(subcategory);
  } catch (err) {
    next(err);
  }
};

// Update subcategory
exports.update = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid subcategory id' });
    }
    const doc = await Subcategory.findByIdAndUpdate(
      id,
      req.body,
      { new: true, runValidators: true }
    );
    if (!doc) {
      return res.status(404).json({ message: 'Subcategory not found' });
    }
    res.json(doc);
  } catch (err) {
    next(err);
  }
};

// Remove (soft delete or hard delete) subcategory
exports.remove = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { hard } = req.query;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid subcategory id' });
    }
    if (hard === 'true' || hard === true) {
      const doc = await Subcategory.findByIdAndDelete(id);
      if (!doc) {
        return res.status(404).json({ message: 'Subcategory not found' });
      }
      return res.json({ message: 'Subcategory permanently deleted' });
    } else {
      const doc = await Subcategory.findByIdAndUpdate(
        id,
        { active: false },
        { new: true }
      );
      if (!doc) {
        return res.status(404).json({ message: 'Subcategory not found' });
      }
      res.json({ message: 'Subcategory deactivated', subcategory: doc });
    }
  } catch (err) {
    next(err);
  }
};

// Restore subcategory (set active=true)
exports.restore = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid subcategory id' });
    }
    const doc = await Subcategory.findByIdAndUpdate(
      id,
      { active: true },
      { new: true }
    );
    if (!doc) {
      return res.status(404).json({ message: 'Subcategory not found' });
    }
    res.json({ message: 'Subcategory restored', subcategory: doc });
  } catch (err) {
    next(err);
  }
};