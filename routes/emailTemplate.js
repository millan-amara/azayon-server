const express = require('express');
const router = express.Router();
const EmailTemplate = require('../models/EmailTemplate');
const { protect } = require('../middleware/auth');
const { AppError } = require('../middleware/error');

router.use(protect);

// GET /api/email-templates?category=invoice
router.get('/', async (req, res, next) => {
  try {
    const filter = { orgId: req.orgId };
    if (req.query.category) filter.category = req.query.category;
    const templates = await EmailTemplate.find(filter).sort({ name: 1 }).lean();
    res.json({ templates });
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const { name, category = 'general', subject = '', body } = req.body;
    if (!name || !body) throw new AppError('name and body are required', 400);
    const template = await EmailTemplate.create({
      orgId: req.orgId,
      name: name.trim(),
      category,
      subject,
      body,
      createdBy: req.user._id,
    });
    res.status(201).json({ template });
  } catch (err) { next(err); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const { name, category, subject, body } = req.body;
    const updates = {};
    if (name     !== undefined) updates.name = String(name).trim();
    if (category !== undefined) updates.category = category;
    if (subject  !== undefined) updates.subject = subject;
    if (body     !== undefined) updates.body = body;

    const template = await EmailTemplate.findOneAndUpdate(
      { _id: req.params.id, orgId: req.orgId },
      { $set: updates },
      { new: true, runValidators: true }
    );
    if (!template) throw new AppError('Template not found', 404);
    res.json({ template });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const t = await EmailTemplate.findOneAndDelete({ _id: req.params.id, orgId: req.orgId });
    if (!t) throw new AppError('Template not found', 404);
    res.json({ message: 'Template deleted' });
  } catch (err) { next(err); }
});

module.exports = router;
