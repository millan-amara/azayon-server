const express = require('express');
const router = express.Router();
const Pipeline = require('../models/Pipeline');
const { AppError } = require('../middleware/error');
const { protect, requireRole } = require('../middleware/auth');
const { emitToOrg } = require('../utils/socket');
const { pipelineVisibilityFilter, userCanAccessPipeline } = require('../utils/pipelineAccess');

router.use(protect);

// GET all pipelines for org
router.get('/', async (req, res, next) => {
  try {
    const pipelines = await Pipeline.find({
      orgId: req.orgId,
      ...pipelineVisibilityFilter(req.user),
    }).lean();
    res.json({ pipelines });
  } catch (error) { next(error); }
});

// GET single pipeline
router.get('/:id', async (req, res, next) => {
  try {
    const pipeline = await Pipeline.findOne({ _id: req.params.id, orgId: req.orgId });
    if (!pipeline) throw new AppError('Pipeline not found', 404);
    if (!userCanAccessPipeline(req.user, pipeline)) {
      // 404 (not 403) so we don't leak the existence of restricted pipelines
      // to users who shouldn't know about them.
      throw new AppError('Pipeline not found', 404);
    }
    res.json({ pipeline });
  } catch (error) { next(error); }
});

// POST create pipeline (admin only)
router.post('/', requireRole('admin'), async (req, res, next) => {
  try {
    const pipeline = await Pipeline.create({ ...req.body, orgId: req.orgId, createdBy: req.user._id });
    emitToOrg(req, 'pipeline.created', { pipelineId: pipeline._id });
    res.status(201).json({ pipeline });
  } catch (error) { next(error); }
});

// PUT update pipeline (admin only)
router.put('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const pipeline = await Pipeline.findOneAndUpdate(
      { _id: req.params.id, orgId: req.orgId },
      { $set: req.body },
      { new: true, runValidators: true }
    );
    if (!pipeline) throw new AppError('Pipeline not found', 404);
    emitToOrg(req, 'pipeline.updated', { pipelineId: pipeline._id });
    res.json({ pipeline });
  } catch (error) { next(error); }
});

// DELETE pipeline (admin only)
router.delete('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const pipeline = await Pipeline.findOne({ _id: req.params.id, orgId: req.orgId });
    if (!pipeline) throw new AppError('Pipeline not found', 404);
    if (pipeline.isDefault) throw new AppError('Cannot delete default pipeline', 400);
    await pipeline.deleteOne();
    emitToOrg(req, 'pipeline.deleted', { pipelineId: pipeline._id });
    res.json({ message: 'Pipeline deleted' });
  } catch (error) { next(error); }
});

module.exports = router;