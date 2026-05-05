const express = require('express');
const router = express.Router();
const SavedView = require('../models/SavedView');
const { protect } = require('../middleware/auth');
const { AppError } = require('../middleware/error');

router.use(protect);

// GET /api/saved-views?page=pipeline — list this user's views for a page
router.get('/', async (req, res, next) => {
  try {
    const filter = { orgId: req.orgId, userId: req.user._id };
    if (req.query.page) filter.page = req.query.page;
    const views = await SavedView.find(filter).sort({ createdAt: 1 }).lean();
    res.json({ views });
  } catch (err) { next(err); }
});

// POST /api/saved-views — create a new saved view for the current user
router.post('/', async (req, res, next) => {
  try {
    const { page, name, filters } = req.body;
    if (!['pipeline', 'contacts', 'tasks', 'documents'].includes(page)) {
      throw new AppError('Invalid page', 400);
    }
    if (!name || !name.trim()) throw new AppError('Name is required', 400);

    const view = await SavedView.create({
      orgId:  req.orgId,
      userId: req.user._id,
      page,
      name:   name.trim(),
      filters: filters || {},
    });
    res.status(201).json({ view });
  } catch (err) {
    if (err.code === 11000) {
      return next(new AppError('You already have a view with that name on this page', 409));
    }
    next(err);
  }
});

// PUT /api/saved-views/:id — rename or replace filters
router.put('/:id', async (req, res, next) => {
  try {
    const { name, filters } = req.body;
    const updates = {};
    if (name !== undefined)    updates.name = String(name).trim();
    if (filters !== undefined) updates.filters = filters;

    const view = await SavedView.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id, orgId: req.orgId },
      { $set: updates },
      { new: true, runValidators: true }
    );
    if (!view) throw new AppError('View not found', 404);
    res.json({ view });
  } catch (err) {
    if (err.code === 11000) {
      return next(new AppError('You already have a view with that name on this page', 409));
    }
    next(err);
  }
});

// DELETE /api/saved-views/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const v = await SavedView.findOneAndDelete({
      _id: req.params.id, userId: req.user._id, orgId: req.orgId,
    });
    if (!v) throw new AppError('View not found', 404);
    res.json({ message: 'View deleted' });
  } catch (err) { next(err); }
});

module.exports = router;
