const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Contact = require('../models/Contact');
const { protect } = require('../middleware/auth');

router.use(protect);

// GET /api/customers — derived view: contacts with status=customer OR with any won deals.
// Returns lifetime value (sum of won deal values), won-deal count, last won date.
router.get('/', async (req, res, next) => {
  try {
    const orgId = new mongoose.Types.ObjectId(req.orgId);
    const { search, assignedTo, sortBy = 'lifetimeValue', sortOrder = 'desc', limit = 100 } = req.query;

    const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const sortDir  = sortOrder === 'asc' ? 1 : -1;
    const sortField = ['lifetimeValue', 'lastWonAt', 'lastContactedAt', 'firstName', 'wonCount'].includes(sortBy)
      ? sortBy
      : 'lifetimeValue';

    const pipeline = [
      { $match: { orgId, isArchived: false } },
      // Pull every won deal for the contact in one lookup
      {
        $lookup: {
          from: 'deals',
          let: { cid: '$_id' },
          pipeline: [
            { $match: {
                $expr: { $and: [
                  { $eq: ['$contact', '$$cid'] },
                  { $eq: ['$orgId', orgId] },
                  { $eq: ['$status', 'won'] },
                ] },
            } },
            { $project: { value: 1, closedAt: 1, title: 1 } },
          ],
          as: 'wonDeals',
        },
      },
      // Keep only contacts that are explicitly customers OR have won at least one deal
      {
        $match: {
          $or: [
            { status: 'customer' },
            { 'wonDeals.0': { $exists: true } },
          ],
        },
      },
      // Optional filters
      ...(assignedTo ? [{ $match: { assignedTo: new mongoose.Types.ObjectId(assignedTo) } }] : []),
      ...(search ? [{
        $match: {
          $or: [
            { firstName: { $regex: escapeRe(search), $options: 'i' } },
            { lastName:  { $regex: escapeRe(search), $options: 'i' } },
            { email:     { $regex: escapeRe(search), $options: 'i' } },
            { company:   { $regex: escapeRe(search), $options: 'i' } },
          ],
        },
      }] : []),
      // Compute the derived fields
      {
        $project: {
          firstName: 1, lastName: 1, email: 1, phone: 1, company: 1,
          status: 1, tags: 1, lastContactedAt: 1, createdAt: 1, assignedTo: 1,
          lifetimeValue: { $sum: '$wonDeals.value' },
          wonCount: { $size: '$wonDeals' },
          lastWonAt: { $max: '$wonDeals.closedAt' },
        },
      },
      // Resolve assignedTo
      {
        $lookup: {
          from: 'users',
          localField: 'assignedTo',
          foreignField: '_id',
          as: 'assignedTo',
        },
      },
      { $unwind: { path: '$assignedTo', preserveNullAndEmptyArrays: true } },
      { $project: { 'assignedTo.password': 0, 'assignedTo.refreshTokens': 0 } },
      { $sort: { [sortField]: sortDir, _id: 1 } },
      { $limit: Math.min(parseInt(limit) || 100, 500) },
    ];

    const customers = await Contact.aggregate(pipeline);

    const totalLifetimeValue = customers.reduce((s, c) => s + (c.lifetimeValue || 0), 0);
    const totalWonDeals      = customers.reduce((s, c) => s + (c.wonCount || 0), 0);

    res.json({
      customers,
      summary: {
        count: customers.length,
        totalLifetimeValue,
        totalWonDeals,
      },
    });
  } catch (err) { next(err); }
});

module.exports = router;
