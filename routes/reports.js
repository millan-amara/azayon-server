const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Deal = require('../models/Deal');
const { protect } = require('../middleware/auth');

router.use(protect);

// GET /api/reports?from=...&to=...
router.get('/', async (req, res, next) => {
  try {
    const orgId = new mongoose.Types.ObjectId(req.orgId);
    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const to   = req.query.to   ? new Date(req.query.to)   : new Date();

    const [
      wonAgg,
      lostAgg,
      openAgg,
      salesByRep,
      stageDistribution,
      cycleAgg,
      revenueByMonth,
    ] = await Promise.all([
      // Won deals closed in range
      Deal.aggregate([
        { $match: { orgId, status: 'won', closedAt: { $gte: from, $lte: to } } },
        { $group: { _id: null, count: { $sum: 1 }, value: { $sum: '$value' } } },
      ]),

      // Lost deals closed in range
      Deal.aggregate([
        { $match: { orgId, status: 'lost', closedAt: { $gte: from, $lte: to } } },
        { $group: { _id: null, count: { $sum: 1 }, value: { $sum: '$value' } } },
      ]),

      // Open deals (snapshot, not range-bound)
      Deal.aggregate([
        { $match: { orgId, status: 'open' } },
        { $group: { _id: null, count: { $sum: 1 }, value: { $sum: '$value' } } },
      ]),

      // Sales by rep — won deals in range
      Deal.aggregate([
        { $match: { orgId, status: 'won', closedAt: { $gte: from, $lte: to } } },
        { $group: { _id: '$assignedTo', count: { $sum: 1 }, value: { $sum: '$value' } } },
        { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
        { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
        { $project: { _id: 1, count: 1, value: 1, name: { $ifNull: ['$user.name', 'Unassigned'] } } },
        { $sort: { value: -1 } },
        { $limit: 10 },
      ]),

      // Open deals by stage (current snapshot)
      Deal.aggregate([
        { $match: { orgId, status: 'open' } },
        { $group: { _id: '$stageName', count: { $sum: 1 }, value: { $sum: '$value' } } },
        { $sort: { value: -1 } },
      ]),

      // Average deal cycle (days from creation to won) for deals closed in range
      Deal.aggregate([
        { $match: { orgId, status: 'won', closedAt: { $gte: from, $lte: to } } },
        { $project: { days: { $divide: [{ $subtract: ['$closedAt', '$createdAt'] }, 1000 * 60 * 60 * 24] } } },
        { $group: { _id: null, avgDays: { $avg: '$days' } } },
      ]),

      // Revenue by month — won deals across the range, bucketed by closedAt
      Deal.aggregate([
        { $match: { orgId, status: 'won', closedAt: { $gte: from, $lte: to } } },
        {
          $group: {
            _id: { y: { $year: '$closedAt' }, m: { $month: '$closedAt' } },
            count: { $sum: 1 },
            value: { $sum: '$value' },
          },
        },
        { $sort: { '_id.y': 1, '_id.m': 1 } },
      ]),
    ]);

    const won  = wonAgg[0]  || { count: 0, value: 0 };
    const lost = lostAgg[0] || { count: 0, value: 0 };
    const open = openAgg[0] || { count: 0, value: 0 };
    const winRate = (won.count + lost.count) > 0
      ? Math.round((won.count / (won.count + lost.count)) * 100)
      : null;

    res.json({
      range: { from, to },
      totals: {
        wonCount:  won.count,
        wonValue:  won.value,
        lostCount: lost.count,
        lostValue: lost.value,
        openCount: open.count,
        openValue: open.value,
        winRate,
      },
      salesByRep,
      stageDistribution,
      avgDealCycleDays: cycleAgg[0]?.avgDays ?? null,
      revenueByMonth: revenueByMonth.map((m) => ({
        label: `${String(m._id.m).padStart(2, '0')}/${m._id.y}`,
        value: m.value,
        count: m.count,
      })),
    });
  } catch (err) { next(err); }
});

module.exports = router;
