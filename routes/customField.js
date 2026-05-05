const express = require('express');
const router = express.Router();
const CustomField = require('../models/CustomField');
const { protect, requireRole } = require('../middleware/auth');
const { AppError } = require('../middleware/error');

const MAX_PER_ENTITY = 5;

router.use(protect);

// `key` is auto-derived from label when not provided. Snake-case, alphanumeric.
function deriveKey(label) {
  return String(label || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

// GET /api/custom-fields?entity=contact
router.get('/', async (req, res, next) => {
  try {
    const filter = { orgId: req.orgId };
    if (req.query.entity) filter.entity = req.query.entity;
    const fields = await CustomField.find(filter).sort({ entity: 1, order: 1, createdAt: 1 }).lean();
    res.json({ fields });
  } catch (err) { next(err); }
});

// POST /api/custom-fields  (admin only)
router.post('/', requireRole('admin'), async (req, res, next) => {
  try {
    const { entity, label, type = 'text', options = [], required = false } = req.body;
    if (!['contact', 'deal'].includes(entity)) throw new AppError('entity must be "contact" or "deal"', 400);
    if (!label || !label.trim()) throw new AppError('label is required', 400);
    if (!['text', 'number', 'date', 'select'].includes(type)) throw new AppError('Invalid field type', 400);

    const count = await CustomField.countDocuments({ orgId: req.orgId, entity });
    if (count >= MAX_PER_ENTITY) {
      throw new AppError(`Limit is ${MAX_PER_ENTITY} custom fields per entity`, 400);
    }

    const key = deriveKey(label);
    if (!key) throw new AppError('Invalid label — produces empty key', 400);

    const field = await CustomField.create({
      orgId: req.orgId,
      entity,
      key,
      label: label.trim(),
      type,
      options: type === 'select' ? options.map((o) => String(o).trim()).filter(Boolean).slice(0, 50) : [],
      required: Boolean(required),
      order: count,
      createdBy: req.user._id,
    });
    res.status(201).json({ field });
  } catch (err) {
    if (err.code === 11000) return next(new AppError('A field with that name already exists', 409));
    next(err);
  }
});

// PUT /api/custom-fields/:id  (admin only) — label/type/options/required only; key is immutable
router.put('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const { label, type, options, required } = req.body;
    const updates = {};
    if (label    !== undefined) updates.label = String(label).trim();
    if (type     !== undefined) updates.type = type;
    if (options  !== undefined) updates.options = (options || []).map((o) => String(o).trim()).filter(Boolean).slice(0, 50);
    if (required !== undefined) updates.required = Boolean(required);

    const field = await CustomField.findOneAndUpdate(
      { _id: req.params.id, orgId: req.orgId },
      { $set: updates },
      { new: true, runValidators: true }
    );
    if (!field) throw new AppError('Field not found', 404);
    res.json({ field });
  } catch (err) { next(err); }
});

// DELETE /api/custom-fields/:id  (admin only) — does NOT scrub stored values
router.delete('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const f = await CustomField.findOneAndDelete({ _id: req.params.id, orgId: req.orgId });
    if (!f) throw new AppError('Field not found', 404);
    res.json({ message: 'Field removed. Existing values stay on records but stop showing in the form.' });
  } catch (err) { next(err); }
});

module.exports = router;
