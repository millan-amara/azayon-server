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

module.exports = router;