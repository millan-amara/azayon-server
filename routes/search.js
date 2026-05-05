const express = require('express');
const router = express.Router();
const Contact = require('../models/Contact');
const Deal = require('../models/Deal');
const Task = require('../models/Task');
const { protect } = require('../middleware/auth');

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

router.use(protect);

// GET /api/search?q=... — quick cross-entity search for the global Cmd+K modal
router.get('/', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) {
      return res.json({ contacts: [], deals: [], tasks: [] });
    }

    const regex = new RegExp(escapeRegex(q), 'i');
    const orgId = req.orgId;
    const limit = 5;

    const [contacts, deals, tasks] = await Promise.all([
      Contact.find({
        orgId,
        isArchived: false,
        $or: [
          { firstName: regex },
          { lastName: regex },
          { email: regex },
          { phone: regex },
          { company: regex },
        ],
      })
        .select('firstName lastName email company status')
        .limit(limit)
        .lean(),

      Deal.find({
        orgId,
        $or: [{ title: regex }, { stageName: regex }],
      })
        .populate('contact', 'firstName lastName company')
        .select('title value currency stageName status contact')
        .limit(limit)
        .lean(),

      Task.find({
        orgId,
        title: regex,
      })
        .populate('contact', 'firstName lastName')
        .select('title status priority dueDate contact')
        .limit(limit)
        .lean(),
    ]);

    res.json({ contacts, deals, tasks });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
