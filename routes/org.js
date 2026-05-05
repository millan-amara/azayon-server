const express = require('express');
const router = express.Router();
const Org = require('../models/Org');
const { AppError } = require('../middleware/error');
const { protect, requireRole } = require('../middleware/auth');

router.use(protect);

// GET /api/orgs/me — fetch current org
router.get('/me', async (req, res, next) => {
  try {
    const org = await Org.findById(req.orgId);
    if (!org) throw new AppError('Organisation not found', 404);
    res.json({ org });
  } catch (error) { next(error); }
});

// PUT /api/orgs/me — admin updates org name + settings
router.put('/me', requireRole('admin'), async (req, res, next) => {
  try {
    const { name, settings } = req.body;
    const updates = {};

    if (typeof name === 'string' && name.trim()) {
      updates.name = name.trim();
    }

    if (settings && typeof settings === 'object') {
      const s = {};
      if (typeof settings.currency === 'string') s.currency = settings.currency.toUpperCase().slice(0, 6);
      if (typeof settings.timezone === 'string') s.timezone = settings.timezone;
      if (typeof settings.dateFormat === 'string') s.dateFormat = settings.dateFormat;

      if (settings.businessHours && typeof settings.businessHours === 'object') {
        const bh = {};
        const { start, end, workDays } = settings.businessHours;
        if (typeof start === 'string' && /^\d{2}:\d{2}$/.test(start)) bh.start = start;
        if (typeof end === 'string' && /^\d{2}:\d{2}$/.test(end)) bh.end = end;
        if (Array.isArray(workDays)) {
          bh.workDays = workDays
            .map((d) => Number(d))
            .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
        }
        if (Object.keys(bh).length) s.businessHours = bh;
      }

      // Merge into org.settings without wiping unspecified fields
      Object.entries(s).forEach(([k, v]) => { updates[`settings.${k}`] = v; });
    }

    if (!Object.keys(updates).length) {
      throw new AppError('No valid fields to update', 400);
    }

    const org = await Org.findByIdAndUpdate(
      req.orgId,
      { $set: updates },
      { new: true, runValidators: true }
    );
    if (!org) throw new AppError('Organisation not found', 404);

    res.json({ org });
  } catch (error) { next(error); }
});

// PUT /api/orgs/me/onboarding — flip onboarding state (any logged-in member can complete/skip)
router.put('/me/onboarding', async (req, res, next) => {
  try {
    const { completed, skipped } = req.body;
    const update = {};
    if (completed === true) {
      update['onboarding.completed'] = true;
      update['onboarding.completedAt'] = new Date();
    }
    if (skipped === true) {
      update['onboarding.skipped'] = true;
    }
    if (Object.keys(update).length === 0) {
      throw new AppError('Nothing to update', 400);
    }

    const org = await Org.findByIdAndUpdate(
      req.orgId,
      { $set: update },
      { new: true }
    );
    if (!org) throw new AppError('Organisation not found', 404);
    res.json({ org });
  } catch (error) { next(error); }
});

module.exports = router;
