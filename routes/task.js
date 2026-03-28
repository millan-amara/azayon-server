const express = require('express');
const router = express.Router();
const Task = require('../models/Task');
const { AppError } = require('../middleware/error');
const { protect } = require('../middleware/auth');
const { triggerAutomation } = require('../automations/engine');
const { createNotification } = require('./notification');
const { sendTaskAssigned } = require('../utils/whatsapp');

router.use(protect);

// GET /api/tasks
router.get('/', async (req, res, next) => {
  try {
    const { status, assignedTo, contactId, dealId, overdue, page = 1, limit = 20 } = req.query;

    const filter = { orgId: req.orgId };
    if (status) filter.status = status;
    if (assignedTo) filter.assignedTo = assignedTo;
    if (contactId) filter.contact = contactId;
    if (dealId) filter.deal = dealId;
    if (overdue === 'true') {
      filter.dueDate = { $lt: new Date() };
      filter.status = { $in: ['pending', 'in_progress'] };
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [tasks, total] = await Promise.all([
      Task.find(filter)
        .populate('assignedTo', 'name email avatar')
        .populate('contact', 'firstName lastName email phone')
        .populate('deal', 'title value')
        .sort({ dueDate: 1, priority: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Task.countDocuments(filter),
    ]);

    res.json({ tasks, pagination: { total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) } });
  } catch (error) { next(error); }
});

// GET /api/tasks/:id
router.get('/:id', async (req, res, next) => {
  try {
    const task = await Task.findOne({ _id: req.params.id, orgId: req.orgId })
      .populate('assignedTo', 'name email avatar')
      .populate('contact', 'firstName lastName email phone')
      .populate('deal', 'title value');
    if (!task) throw new AppError('Task not found', 404);
    res.json({ task });
  } catch (error) { next(error); }
});

// Helper - compute the sendAt timestamp from dueDate + reminder offset
const computeSendAt = (dueDate, reminder) => {
  if (!dueDate || !reminder?.offset || !reminder?.unit) return null;
  const due = new Date(dueDate);
  const ms = {
    minutes: reminder.offset * 60 * 1000,
    hours: reminder.offset * 60 * 60 * 1000,
    days: reminder.offset * 24 * 60 * 60 * 1000,
  }[reminder.unit] || 0;
  return new Date(due.getTime() - ms);
};

// POST /api/tasks
router.post('/', async (req, res, next) => {
  try {
    const data = { ...req.body };
    if (!data.assignedTo) delete data.assignedTo;
    if (!data.contact) delete data.contact;
    if (!data.deal) delete data.deal;

    // Compute reminder sendAt
    if (data.reminder?.offset && data.dueDate) {
      data.reminder.sendAt = computeSendAt(data.dueDate, data.reminder);
      data.reminder.sent = false;
    }

    const task = await Task.create({
      ...data,
      orgId: req.orgId,
      createdBy: req.user._id,
    });

    await task.populate([
      { path: 'assignedTo', select: 'name email avatar phone' },
      { path: 'contact', select: 'firstName lastName email phone' },
    ]);

    // Notify assigned user if not self
    if (task.assignedTo && task.assignedTo._id.toString() !== req.user._id.toString()) {
      await createNotification({
        orgId: req.orgId,
        userId: task.assignedTo._id,
        type: 'task_assigned',
        title: 'New task assigned to you',
        message: task.title,
        resourceType: 'task',
        resourceId: task._id,
        io: req.app.get('io'),
      });

      // Send WhatsApp if assignee has a phone
      if (task.assignedTo.phone) {
        sendTaskAssigned({
          phone: task.assignedTo.phone,
          name: task.assignedTo.name,
          taskTitle: task.title,
          dueDate: task.dueDate,
        }).catch((err) => console.error('WhatsApp task assigned failed:', err.message));
      }
    }

    res.status(201).json({ task });
  } catch (error) { next(error); }
});

// PUT /api/tasks/:id
router.put('/:id', async (req, res, next) => {
  try {
    const updates = { ...req.body };
    if (!updates.assignedTo) delete updates.assignedTo;
    if (!updates.contact) delete updates.contact;
    if (!updates.deal) delete updates.deal;

    if (updates.status === 'completed' && !updates.completedAt) {
      updates.completedAt = new Date();
    }

    // Recompute reminder sendAt if due date or reminder changed
    if (updates.reminder?.offset && updates.dueDate) {
      updates.reminder.sendAt = computeSendAt(updates.dueDate, updates.reminder);
      updates.reminder.sent = false; // reset so it fires again with new time
    } else if (updates.reminder?.offset === 0 || updates.reminder === null) {
      updates.reminder = null; // clear reminder
    }

    const task = await Task.findOneAndUpdate(
      { _id: req.params.id, orgId: req.orgId },
      { $set: updates },
      { new: true }
    ).populate('assignedTo contact deal');

    if (!task) throw new AppError('Task not found', 404);
    res.json({ task });
  } catch (error) { next(error); }
});

// DELETE /api/tasks/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const task = await Task.findOneAndDelete({ _id: req.params.id, orgId: req.orgId });
    if (!task) throw new AppError('Task not found', 404);
    res.json({ message: 'Task deleted' });
  } catch (error) { next(error); }
});

module.exports = router;



