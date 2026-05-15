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

      if (settings.branding && typeof settings.branding === 'object') {
        const b = {};
        const { logoUrl, logoPublicId, brandColor, address, footerText } = settings.branding;
        // Strings are accepted as-is; '' clears the field. Cap free-text to
        // reasonable sizes so a bug or bad paste can't bloat the org doc.
        if (typeof logoUrl === 'string')      b.logoUrl      = logoUrl.slice(0, 500);
        if (typeof logoPublicId === 'string') b.logoPublicId = logoPublicId.slice(0, 200);
        // Brand color must look like a hex; silently drop anything else
        // rather than 500-ing — the PDF renderer falls back to the default.
        if (typeof brandColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(brandColor)) {
          b.brandColor = brandColor.toLowerCase();
        } else if (brandColor === '') {
          b.brandColor = '';
        }
        if (typeof address === 'string')    b.address    = address.slice(0, 500);
        if (typeof footerText === 'string') b.footerText = footerText.slice(0, 500);

        // Billing contact (shown on invoices). Email is validated lightly;
        // an obviously broken string is rejected rather than silently saved.
        const { billingEmail, billingPhone } = settings.branding;
        if (typeof billingEmail === 'string') {
          const trimmed = billingEmail.trim();
          if (trimmed === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
            b.billingEmail = trimmed;
          } else {
            throw new AppError('Billing email is not a valid email address', 400);
          }
        }
        if (typeof billingPhone === 'string') {
          // Phone format varies wildly across the supported markets — keep
          // server validation loose, just strip and length-cap. Client renders
          // it back verbatim so the user gets what they typed.
          b.billingPhone = billingPhone.trim().slice(0, 40);
        }

        // Dotted paths so we don't wipe sibling branding fields the caller didn't send
        Object.entries(b).forEach(([k, v]) => { updates[`settings.branding.${k}`] = v; });
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
