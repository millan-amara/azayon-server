const express = require('express');
const router = express.Router();
const Automation = require('../models/Automation');
const Contact = require('../models/Contact');
const Deal = require('../models/Deal');
const Task = require('../models/Task');
const TEMPLATES = require('../automations/templates');
const { AppError } = require('../middleware/error');
const { protect, requireRole } = require('../middleware/auth');
const { attachPlan, requireFeature } = require('../middleware/plan');
const { testRunAutomation } = require('../automations/engine');

router.use(protect);
router.use(attachPlan, requireFeature('automations'));

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

      automationData = {
        ...automationData,
        templateId,
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
    // Strip server-controlled fields so a malicious payload can't relocate
    // an automation to another org or rewrite its createdBy / runCount.
    const { orgId, createdBy, _id, runCount, recentRuns, lastRunAt, lastRunStatus, ...safe } = req.body || {};
    void orgId; void createdBy; void _id; void runCount; void recentRuns; void lastRunAt; void lastRunStatus;

    const automation = await Automation.findOneAndUpdate(
      { _id: req.params.id, orgId: req.orgId },
      { $set: safe },
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

// POST /api/automations/:id/test
// Run the automation once against the most recent matching entity in this org.
// SIDE EFFECTS FIRE FOR REAL — emails are sent, webhooks are hit, tasks are
// created. The frontend confirms with the user before calling this; the
// resulting run is flagged `isTest: true` in run history.
router.post('/:id/test', requireRole('admin', 'sales_rep'), async (req, res, next) => {
  try {
    const automation = await Automation.findOne({ _id: req.params.id, orgId: req.orgId });
    if (!automation) throw new AppError('Automation not found', 404);

    const triggerType = automation.trigger?.type;
    const subject = triggerType?.split('.')[0];

    // Pick the most recent real entity that matches the trigger's subject so
    // interpolation has realistic data. The user gets to see the actual email
    // their lead would receive, not a placeholder.
    let context = {};

    if (subject === 'contact') {
      const contact = await Contact.findOne({ orgId: req.orgId, isArchived: false })
        .populate('assignedTo', 'name email phone')
        .sort({ createdAt: -1 })
        .lean();
      if (!contact) throw new AppError('No contacts found in this org to test against', 400);
      context = { contact };
    } else if (subject === 'deal') {
      const deal = await Deal.findOne({ orgId: req.orgId })
        .populate('assignedTo', 'name email phone')
        .populate('contact', 'firstName lastName email phone assignedTo')
        .sort({ createdAt: -1 })
        .lean();
      if (!deal) throw new AppError('No deals found in this org to test against', 400);
      context = { deal, contact: deal.contact };
    } else if (subject === 'task') {
      const task = await Task.findOne({ orgId: req.orgId })
        .populate('assignedTo', 'name email phone')
        .populate('contact', 'firstName lastName email phone assignedTo')
        .populate({ path: 'deal', populate: { path: 'assignedTo', select: 'name email phone' } })
        .sort({ createdAt: -1 })
        .lean();
      if (!task) throw new AppError('No tasks found in this org to test against', 400);
      context = { task, contact: task.contact, deal: task.deal };
    } else {
      throw new AppError(`Cannot test trigger type: ${triggerType}`, 400);
    }

    const result = await testRunAutomation(automation, context);
    res.json(result);
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