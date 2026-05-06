/*
 * Platform-level superadmin API. Cross-tenant — bypasses orgId scoping.
 * Mounted at /api/superadmin and gated by `protect + requireSuperadmin`.
 *
 * NEVER mount any of these handlers anywhere else — they intentionally read
 * across orgs and would leak data if reused under tenant routes.
 */
const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

const Org = require('../models/Org');
const User = require('../models/User');
const Deal = require('../models/Deal');
const Contact = require('../models/Contact');
const Task = require('../models/Task');
const Document = require('../models/Document');
const Pipeline = require('../models/Pipeline');
const Automation = require('../models/Automation');
const Notification = require('../models/Notification');

const { protect, requireSuperadmin } = require('../middleware/auth');

router.use(protect, requireSuperadmin);

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return startOfDay(d);
};

// ── GET /api/superadmin/overview ─────────────────────────────────────────────
// Top-level platform metrics for the dashboard landing card.
router.get('/overview', async (req, res, next) => {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const last30 = daysAgo(30);
    const last7 = daysAgo(7);

    const [
      totalOrgs,
      totalUsers,
      totalContacts,
      totalDeals,
      totalDocuments,
      orgsLast30,
      usersLast30,
      activeOrgsLast7,
      planBreakdown,
      statusBreakdown,
      wonThisMonth,
      foundingMembers,
    ] = await Promise.all([
      Org.countDocuments(),
      User.countDocuments(),
      Contact.countDocuments(),
      Deal.countDocuments(),
      Document.countDocuments(),
      Org.countDocuments({ createdAt: { $gte: last30 } }),
      User.countDocuments({ createdAt: { $gte: last30 } }),

      // "Active" = a user whose lastLogin is within 7d. Distinct orgIds for those users.
      User.distinct('orgId', { lastLogin: { $gte: last7 } }).then((arr) => arr.length),

      Org.aggregate([
        { $group: { _id: '$subscription.plan', count: { $sum: 1 } } },
      ]),
      Org.aggregate([
        { $group: { _id: '$subscription.status', count: { $sum: 1 } } },
      ]),

      Deal.aggregate([
        { $match: { status: 'won', closedAt: { $gte: startOfMonth } } },
        { $group: { _id: null, count: { $sum: 1 }, totalValue: { $sum: '$value' } } },
      ]),
      Org.countDocuments({ 'subscription.isFoundingMember': true }),
    ]);

    res.json({
      totals: {
        orgs: totalOrgs,
        users: totalUsers,
        contacts: totalContacts,
        deals: totalDeals,
        documents: totalDocuments,
        foundingMembers,
      },
      growth: {
        orgsLast30,
        usersLast30,
        activeOrgsLast7,
      },
      revenue: {
        wonDealsThisMonth: wonThisMonth[0]?.count || 0,
        wonValueThisMonth: wonThisMonth[0]?.totalValue || 0,
      },
      planBreakdown: planBreakdown.reduce((m, x) => ({ ...m, [x._id || 'unknown']: x.count }), {}),
      statusBreakdown: statusBreakdown.reduce((m, x) => ({ ...m, [x._id || 'unknown']: x.count }), {}),
    });
  } catch (err) { next(err); }
});

// ── GET /api/superadmin/signups?days=30 ──────────────────────────────────────
// Daily-bucketed signup counts (orgs + users). Chart-ready.
router.get('/signups', async (req, res, next) => {
  try {
    const days = Math.min(parseInt(req.query.days, 10) || 30, 180);
    const since = daysAgo(days);

    const [orgs, users] = await Promise.all([
      Org.aggregate([
        { $match: { createdAt: { $gte: since } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      User.aggregate([
        { $match: { createdAt: { $gte: since } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
    ]);

    // Pad missing days so the chart has continuous x-axis.
    const series = [];
    const orgMap = Object.fromEntries(orgs.map((x) => [x._id, x.count]));
    const userMap = Object.fromEntries(users.map((x) => [x._id, x.count]));
    for (let i = days - 1; i >= 0; i--) {
      const d = daysAgo(i).toISOString().slice(0, 10);
      series.push({ date: d, orgs: orgMap[d] || 0, users: userMap[d] || 0 });
    }
    res.json({ days, series });
  } catch (err) { next(err); }
});

// ── GET /api/superadmin/orgs ─────────────────────────────────────────────────
// Paged list with search + per-org rolled-up counts.
router.get('/orgs', async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
    const search = (req.query.search || '').trim();
    const plan = req.query.plan;
    const status = req.query.status;

    const filter = {};
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { slug: { $regex: search, $options: 'i' } },
      ];
    }
    if (plan) filter['subscription.plan'] = plan;
    if (status) filter['subscription.status'] = status;

    const [total, orgs] = await Promise.all([
      Org.countDocuments(filter),
      Org.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
    ]);

    // Roll up counts per org. Single aggregation per collection rather than N+1.
    const ids = orgs.map((o) => o._id);
    const [userCounts, contactCounts, dealCounts, docCounts] = await Promise.all([
      User.aggregate([{ $match: { orgId: { $in: ids } } }, { $group: { _id: '$orgId', n: { $sum: 1 } } }]),
      Contact.aggregate([{ $match: { orgId: { $in: ids } } }, { $group: { _id: '$orgId', n: { $sum: 1 } } }]),
      Deal.aggregate([{ $match: { orgId: { $in: ids } } }, { $group: { _id: '$orgId', n: { $sum: 1 } } }]),
      Document.aggregate([{ $match: { orgId: { $in: ids } } }, { $group: { _id: '$orgId', n: { $sum: 1 } } }]),
    ]);

    const toMap = (rows) => Object.fromEntries(rows.map((r) => [String(r._id), r.n]));
    const u = toMap(userCounts);
    const c = toMap(contactCounts);
    const d = toMap(dealCounts);
    const dc = toMap(docCounts);

    const enriched = orgs.map((o) => ({
      ...o,
      counts: {
        users:    u[String(o._id)]  || 0,
        contacts: c[String(o._id)]  || 0,
        deals:    d[String(o._id)]  || 0,
        documents: dc[String(o._id)] || 0,
      },
    }));

    res.json({ total, page, limit, orgs: enriched });
  } catch (err) { next(err); }
});

// ── GET /api/superadmin/orgs/:id ─────────────────────────────────────────────
router.get('/orgs/:id', async (req, res, next) => {
  try {
    const org = await Org.findById(req.params.id).lean();
    if (!org) return res.status(404).json({ error: 'Org not found' });

    const [users, counts, recentDeals] = await Promise.all([
      User.find({ orgId: org._id }).select('-password -refreshTokens').lean(),
      Promise.all([
        Contact.countDocuments({ orgId: org._id }),
        Deal.countDocuments({ orgId: org._id }),
        Task.countDocuments({ orgId: org._id }),
        Document.countDocuments({ orgId: org._id }),
        Pipeline.countDocuments({ orgId: org._id }),
        Automation.countDocuments({ orgId: org._id }),
      ]),
      Deal.find({ orgId: org._id }).sort({ createdAt: -1 }).limit(10).lean(),
    ]);

    res.json({
      org,
      users,
      counts: {
        contacts: counts[0],
        deals: counts[1],
        tasks: counts[2],
        documents: counts[3],
        pipelines: counts[4],
        automations: counts[5],
      },
      recentDeals,
    });
  } catch (err) { next(err); }
});

// ── PATCH /api/superadmin/orgs/:id ───────────────────────────────────────────
// Whitelist of fields the dashboard can edit — never spread `req.body`.
router.patch('/orgs/:id', async (req, res, next) => {
  try {
    const allowed = {};
    if (typeof req.body.name === 'string') allowed.name = req.body.name.trim();
    if (req.body.subscription) {
      const sub = req.body.subscription;
      if (['free', 'growth'].includes(sub.plan)) allowed['subscription.plan'] = sub.plan;
      if (['trialing', 'active', 'cancelling', 'past_due', 'cancelled', 'free'].includes(sub.status)) {
        allowed['subscription.status'] = sub.status;
      }
      if (sub.trialEndsAt !== undefined) allowed['subscription.trialEndsAt'] = sub.trialEndsAt ? new Date(sub.trialEndsAt) : null;
      if (typeof sub.isFoundingMember === 'boolean') allowed['subscription.isFoundingMember'] = sub.isFoundingMember;
    }

    const org = await Org.findByIdAndUpdate(req.params.id, { $set: allowed }, { new: true });
    if (!org) return res.status(404).json({ error: 'Org not found' });
    res.json({ org });
  } catch (err) { next(err); }
});

// ── DELETE /api/superadmin/orgs/:id ──────────────────────────────────────────
// Cascading delete. Requires ?confirm=DELETE in the query so a stray click
// can't nuke a tenant.
router.delete('/orgs/:id', async (req, res, next) => {
  try {
    if (req.query.confirm !== 'DELETE') {
      return res.status(400).json({ error: 'Add ?confirm=DELETE to confirm cascading delete' });
    }
    const orgId = new mongoose.Types.ObjectId(req.params.id);
    const org = await Org.findById(orgId);
    if (!org) return res.status(404).json({ error: 'Org not found' });

    await Promise.all([
      User.deleteMany({ orgId }),
      Contact.deleteMany({ orgId }),
      Deal.deleteMany({ orgId }),
      Task.deleteMany({ orgId }),
      Document.deleteMany({ orgId }),
      Pipeline.deleteMany({ orgId }),
      Automation.deleteMany({ orgId }),
      Notification.deleteMany({ orgId }),
    ]);
    await Org.deleteOne({ _id: orgId });

    res.json({ deleted: true, orgId });
  } catch (err) { next(err); }
});

// ── GET /api/superadmin/users ────────────────────────────────────────────────
router.get('/users', async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
    const search = (req.query.search || '').trim();
    const orgId = req.query.orgId;
    const role = req.query.role;

    const filter = {};
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
      ];
    }
    if (orgId && mongoose.isValidObjectId(orgId)) filter.orgId = orgId;
    if (role) filter.role = role;

    const [total, users] = await Promise.all([
      User.countDocuments(filter),
      User.find(filter)
        .select('-password -refreshTokens')
        .populate('orgId', 'name slug subscription.plan subscription.status')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
    ]);

    res.json({ total, page, limit, users });
  } catch (err) { next(err); }
});

// ── PATCH /api/superadmin/users/:id ──────────────────────────────────────────
// Edit role / active status / superadmin flag. Refuse to demote the last superadmin
// (so you can't lock yourselves out).
router.patch('/users/:id', async (req, res, next) => {
  try {
    const updates = {};
    if (typeof req.body.name === 'string') updates.name = req.body.name.trim();
    if (['admin', 'sales_rep', 'viewer'].includes(req.body.role)) updates.role = req.body.role;
    if (typeof req.body.isActive === 'boolean') updates.isActive = req.body.isActive;
    if (typeof req.body.isSuperadmin === 'boolean') updates.isSuperadmin = req.body.isSuperadmin;
    if (typeof req.body.emailVerified === 'boolean') updates.emailVerified = req.body.emailVerified;

    if (updates.isSuperadmin === false) {
      const remaining = await User.countDocuments({ isSuperadmin: true, _id: { $ne: req.params.id } });
      if (remaining === 0) {
        return res.status(400).json({ error: 'Cannot demote the last superadmin' });
      }
    }

    const user = await User.findByIdAndUpdate(req.params.id, { $set: updates }, { new: true })
      .select('-password -refreshTokens');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
  } catch (err) { next(err); }
});

// ── DELETE /api/superadmin/users/:id ─────────────────────────────────────────
router.delete('/users/:id', async (req, res, next) => {
  try {
    if (String(req.params.id) === String(req.user._id)) {
      return res.status(400).json({ error: 'You cannot delete your own account here' });
    }
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.isSuperadmin) {
      const remaining = await User.countDocuments({ isSuperadmin: true, _id: { $ne: user._id } });
      if (remaining === 0) return res.status(400).json({ error: 'Cannot delete the last superadmin' });
    }
    await user.deleteOne();
    res.json({ deleted: true, userId: user._id });
  } catch (err) { next(err); }
});

// ── GET /api/superadmin/deals ────────────────────────────────────────────────
router.get('/deals', async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
    const status = req.query.status;
    const orgId = req.query.orgId;

    const filter = {};
    if (status) filter.status = status;
    if (orgId && mongoose.isValidObjectId(orgId)) filter.orgId = orgId;

    const [total, deals] = await Promise.all([
      Deal.countDocuments(filter),
      Deal.find(filter)
        .populate('orgId', 'name slug')
        .populate('contact', 'firstName lastName email company')
        .populate('assignedTo', 'name email')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
    ]);
    res.json({ total, page, limit, deals });
  } catch (err) { next(err); }
});

// ── GET /api/superadmin/contacts ─────────────────────────────────────────────
router.get('/contacts', async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
    const search = (req.query.search || '').trim();
    const orgId = req.query.orgId;

    const filter = {};
    if (search) {
      filter.$or = [
        { firstName: { $regex: search, $options: 'i' } },
        { lastName:  { $regex: search, $options: 'i' } },
        { email:     { $regex: search, $options: 'i' } },
        { company:   { $regex: search, $options: 'i' } },
      ];
    }
    if (orgId && mongoose.isValidObjectId(orgId)) filter.orgId = orgId;

    const [total, contacts] = await Promise.all([
      Contact.countDocuments(filter),
      Contact.find(filter)
        .populate('orgId', 'name slug')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select('firstName lastName email phone company status orgId createdAt')
        .lean(),
    ]);
    res.json({ total, page, limit, contacts });
  } catch (err) { next(err); }
});

// ── GET /api/superadmin/billing ──────────────────────────────────────────────
// Subscription/billing snapshot (Paystack subscription codes, MRR estimate, churn).
router.get('/billing', async (req, res, next) => {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const last30 = daysAgo(30);

    const [byPlan, byStatus, paying, foundingPriceAvg, cancelledLast30, recentlySubscribed] = await Promise.all([
      Org.aggregate([
        { $group: { _id: '$subscription.plan', count: { $sum: 1 } } },
      ]),
      Org.aggregate([
        { $group: { _id: '$subscription.status', count: { $sum: 1 } } },
      ]),
      Org.countDocuments({ 'subscription.status': { $in: ['active', 'cancelling'] }, 'subscription.plan': 'growth' }),
      Org.aggregate([
        { $match: { 'subscription.isFoundingMember': true, 'subscription.foundingMemberPrice': { $gt: 0 } } },
        { $group: { _id: null, avg: { $avg: '$subscription.foundingMemberPrice' }, sum: { $sum: '$subscription.foundingMemberPrice' }, count: { $sum: 1 } } },
      ]),
      Org.countDocuments({ 'subscription.cancelledAt': { $gte: last30 } }),
      Org.find({ 'subscription.subscribedAt': { $gte: last30 } })
        .sort({ 'subscription.subscribedAt': -1 })
        .limit(20)
        .select('name slug subscription createdAt')
        .lean(),
    ]);

    res.json({
      byPlan: byPlan.reduce((m, x) => ({ ...m, [x._id || 'unknown']: x.count }), {}),
      byStatus: byStatus.reduce((m, x) => ({ ...m, [x._id || 'unknown']: x.count }), {}),
      payingOrgs: paying,
      foundingMembers: foundingPriceAvg[0] || { avg: 0, sum: 0, count: 0 },
      cancelledLast30,
      recentlySubscribed,
      asOf: now,
    });
  } catch (err) { next(err); }
});

// ── GET /api/superadmin/system ───────────────────────────────────────────────
router.get('/system', (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    node: process.version,
    uptimeSec: Math.round(process.uptime()),
    pid: process.pid,
    env: process.env.NODE_ENV || 'development',
    memoryMB: {
      rss: Math.round(mem.rss / 1024 / 1024),
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
    },
    mongo: {
      // 1 = connected, 2 = connecting, etc.
      readyState: mongoose.connection.readyState,
      host: mongoose.connection.host,
      name: mongoose.connection.name,
    },
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
