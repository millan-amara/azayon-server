const express = require('express');
const router = express.Router();
const Automation = require('../models/Automation');
const TEMPLATES = require('../automations/templates');
const { AppError } = require('../middleware/error');
const { protect, requireRole } = require('../middleware/auth');

router.use(protect);

// GET /api/automations/templates
router.get('/templates', (req, res) => {
  res.json({ templates: TEMPLATES });
});

// GET /api/automations
router.get('/', async (req, res, next) => {
  try {
    const automations = await Automation.find({ orgId: req.orgId })
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 })
      .lean();
    res.json({ automations });
  } catch (error) { next(error); }
});

// GET /api/automations/:id
router.get('/:id', async (req, res, next) => {
  try {
    const automation = await Automation.findOne({ _id: req.params.id, orgId: req.orgId });
    if (!automation) throw new AppError('Automation not found', 404);
    res.json({ automation });
  } catch (error) { next(error); }
});

// POST /api/automations - create custom or from template
router.post('/', requireRole('admin', 'sales_rep'), async (req, res, next) => {
  try {
    const { templateId, ...body } = req.body;

    let automationData = { ...body, orgId: req.orgId, createdBy: req.user._id };

    if (templateId) {
      const template = TEMPLATES.find((t) => t.id === templateId);
      if (!template) throw new AppError('Template not found', 404);

      // Merge template with any overrides provided
      automationData = {
        ...automationData,
        name: body.name || template.name,
        description: body.description || template.description,
        trigger: body.trigger || template.trigger,
        conditions: body.conditions || template.conditions,
        actions: body.actions || template.actions,
      };
    }

    const automation = await Automation.create(automationData);
    res.status(201).json({ automation });
  } catch (error) { next(error); }
});

// PUT /api/automations/:id
router.put('/:id', requireRole('admin', 'sales_rep'), async (req, res, next) => {
  try {
    const automation = await Automation.findOneAndUpdate(
      { _id: req.params.id, orgId: req.orgId },
      { $set: req.body },
      { new: true, runValidators: true }
    );
    if (!automation) throw new AppError('Automation not found', 404);
    res.json({ automation });
  } catch (error) { next(error); }
});

// PATCH /api/automations/:id/toggle
router.patch('/:id/toggle', async (req, res, next) => {
  try {
    const automation = await Automation.findOne({ _id: req.params.id, orgId: req.orgId });
    if (!automation) throw new AppError('Automation not found', 404);
    automation.isActive = !automation.isActive;
    await automation.save();
    res.json({ automation, isActive: automation.isActive });
  } catch (error) { next(error); }
});

// DELETE /api/automations/:id
router.delete('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const automation = await Automation.findOneAndDelete({ _id: req.params.id, orgId: req.orgId });
    if (!automation) throw new AppError('Automation not found', 404);
    res.json({ message: 'Automation deleted' });
  } catch (error) { next(error); }
});

module.exports = router;