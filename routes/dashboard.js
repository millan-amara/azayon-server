const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Deal = require('../models/Deal');
const Contact = require('../models/Contact');
const Task = require('../models/Task');
const { protect } = require('../middleware/auth');

router.use(protect);

// GET /api/dashboard
router.get('/', async (req, res, next) => {
  try {
    const orgId = req.orgId;
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);

    const [
      totalContacts,
      newContactsThisMonth,
      openDeals,
      wonThisMonth,
      lostThisMonth,
      wonLastMonth,
      tasksDueToday,
      overdueTasksCount,
      recentActivity,
      dealValueByStage,
    ] = await Promise.all([
      Contact.countDocuments({ orgId, isArchived: false }),
      Contact.countDocuments({ orgId, createdAt: { $gte: startOfMonth } }),

      Deal.find({ orgId, status: 'open' }).lean(),

      Deal.aggregate([
        { $match: { orgId, status: 'won', closedAt: { $gte: startOfMonth } } },
        { $group: { _id: null, count: { $sum: 1 }, totalValue: { $sum: '$value' } } },
      ]),

      Deal.countDocuments({ orgId, status: 'lost', closedAt: { $gte: startOfMonth } }),
      Deal.aggregate([
        { $match: { orgId, status: 'won', closedAt: { $gte: startOfLastMonth, $lte: endOfLastMonth } } },
        { $group: { _id: null, totalValue: { $sum: '$value' } } },
      ]),

      Task.countDocuments({
        orgId,
        status: { $in: ['pending', 'in_progress'] },
        dueDate: { $gte: new Date(now.setHours(0,0,0,0)), $lte: new Date(now.setHours(23,59,59,999)) },
      }),
      Task.countDocuments({
        orgId,
        status: { $in: ['pending', 'in_progress'] },
        dueDate: { $lt: new Date() },
      }),

      // Recent contacts + deals mixed
      Contact.find({ orgId, isArchived: false })
        .sort({ createdAt: -1 })
        .limit(5)
        .select('firstName lastName email company createdAt status')
        .lean(),

      Deal.aggregate([
        { $match: { orgId, status: 'open' } },
        { $group: { _id: '$stageName', count: { $sum: 1 }, totalValue: { $sum: '$value' } } },
        { $sort: { totalValue: -1 } },
      ]),
    ]);

    const openDealsValue = openDeals.reduce((sum, d) => sum + (d.value || 0), 0);
    const wonStats = wonThisMonth[0] || { count: 0, totalValue: 0 };
    const wonLastMonthValue = wonLastMonth[0]?.totalValue || 0;

    res.json({
      contacts: {
        total: totalContacts,
        newThisMonth: newContactsThisMonth,
      },
      deals: {
        openCount: openDeals.length,
        openValue: openDealsValue,
        wonThisMonth: wonStats.count,
        wonValueThisMonth: wonStats.totalValue,
        lostThisMonth,
        wonValueLastMonth: wonLastMonthValue,
        valueGrowth: wonLastMonthValue > 0
          ? (((wonStats.totalValue - wonLastMonthValue) / wonLastMonthValue) * 100).toFixed(1)
          : null,
      },
      tasks: {
        dueToday: tasksDueToday,
        overdue: overdueTasksCount,
      },
      recentContacts: recentActivity,
      dealValueByStage,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/dashboard/activity?limit=20 — unified recent-activity feed for the
// dashboard "What's happening" panel. Pulls from existing data (no events table).
router.get('/activity', async (req, res, next) => {
  try {
    const orgId = req.orgId;
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);

    const [wonDeals, lostDeals, newDeals, newContacts] = await Promise.all([
      Deal.find({ orgId, status: 'won', closedAt: { $ne: null } })
        .sort({ closedAt: -1 }).limit(limit)
        .populate('assignedTo', 'name')
        .populate('contact', 'firstName lastName company')
        .select('title value currency closedAt assignedTo contact')
        .lean(),

      Deal.find({ orgId, status: 'lost', closedAt: { $ne: null } })
        .sort({ closedAt: -1 }).limit(limit)
        .populate('assignedTo', 'name')
        .populate('contact', 'firstName lastName company')
        .select('title value currency closedAt assignedTo contact')
        .lean(),

      Deal.find({ orgId })
        .sort({ createdAt: -1 }).limit(limit)
        .populate('createdBy', 'name')
        .populate('contact', 'firstName lastName company')
        .select('title value currency createdAt createdBy contact')
        .lean(),

      Contact.find({ orgId, isArchived: false })
        .sort({ createdAt: -1 }).limit(limit)
        .populate('createdBy', 'name')
        .select('firstName lastName company createdAt createdBy')
        .lean(),
    ]);

    const contactName = (c) => c
      ? [c.firstName, c.lastName].filter(Boolean).join(' ') || c.company || 'a contact'
      : null;

    const events = [
      ...wonDeals.map((d) => ({
        type: 'deal_won',
        actor: d.assignedTo?.name,
        target: d.title,
        contactName: contactName(d.contact),
        amount: d.value,
        currency: d.currency,
        when: d.closedAt,
        resourceType: 'deal',
        resourceId: d._id,
      })),
      ...lostDeals.map((d) => ({
        type: 'deal_lost',
        actor: d.assignedTo?.name,
        target: d.title,
        contactName: contactName(d.contact),
        amount: d.value,
        currency: d.currency,
        when: d.closedAt,
        resourceType: 'deal',
        resourceId: d._id,
      })),
      ...newDeals.map((d) => ({
        type: 'deal_created',
        actor: d.createdBy?.name,
        target: d.title,
        contactName: contactName(d.contact),
        amount: d.value,
        currency: d.currency,
        when: d.createdAt,
        resourceType: 'deal',
        resourceId: d._id,
      })),
      ...newContacts.map((c) => ({
        type: 'contact_created',
        actor: c.createdBy?.name,
        target: contactName(c),
        when: c.createdAt,
        resourceType: 'contact',
        resourceId: c._id,
      })),
    ];

    events.sort((a, b) => new Date(b.when) - new Date(a.when));
    res.json({ activity: events.slice(0, limit) });
  } catch (error) {
    next(error);
  }
});

module.exports = router;