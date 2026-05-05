const express = require('express');
const router = express.Router();
const Contact = require('../models/Contact');
const Deal = require('../models/Deal');
const Pipeline = require('../models/Pipeline');
const { apiKeyAuth } = require('../middleware/auth');
const { triggerAutomation } = require('../automations/engine');
const { emitToOrg } = require('../utils/socket');

/**
 * ALL inbound webhook routes use API key auth (x-api-key header)
 * This is what n8n's HTTP Request node will send.
 *
 * Base URL: POST /api/webhooks/
 *
 * n8n workflow example:
 *   HTTP Request node → POST https://yourapp.com/api/webhooks/contacts
 *   Headers: x-api-key: crm_xxxxx
 *   Body: { firstName, lastName, email, phone, ... }
 */

router.use(apiKeyAuth);

// POST /api/webhooks/contacts - create or upsert a contact from n8n
router.post('/contacts', async (req, res, next) => {
  try {
    const { email, ...rest } = req.body;

    let contact;
    if (email) {
      // Upsert by email
      contact = await Contact.findOneAndUpdate(
        { email, orgId: req.orgId },
        { $set: { ...rest, email, orgId: req.orgId, source: 'n8n' } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    } else {
      contact = await Contact.create({ ...rest, orgId: req.orgId, source: 'n8n' });
    }

    await triggerAutomation('contact.created', { contact, orgId: req.orgId });

    emitToOrg(req, 'contact.created', { contactId: contact._id });

    res.status(201).json({
      success: true,
      contact: { _id: contact._id, email: contact.email, firstName: contact.firstName },
    });
  } catch (error) { next(error); }
});

// POST /api/webhooks/contacts/:id - update a specific contact from n8n
router.put('/contacts/:id', async (req, res, next) => {
  try {
    const contact = await Contact.findOneAndUpdate(
      { _id: req.params.id, orgId: req.orgId },
      { $set: req.body },
      { new: true }
    );
    if (!contact) return res.status(404).json({ success: false, error: 'Contact not found' });

    emitToOrg(req, 'contact.updated', { contactId: contact._id });

    res.json({ success: true, contact });
  } catch (error) { next(error); }
});

// POST /api/webhooks/deals - create a deal from n8n
router.post('/deals', async (req, res, next) => {
  try {
    const { contactId, pipelineId, stageId, ...rest } = req.body;

    // Get default pipeline if not specified
    let pipeline;
    if (pipelineId) {
      pipeline = await Pipeline.findOne({ _id: pipelineId, orgId: req.orgId });
    } else {
      pipeline = await Pipeline.findOne({ orgId: req.orgId, isDefault: true });
    }
    if (!pipeline) return res.status(400).json({ success: false, error: 'No pipeline found' });

    const stage = stageId
      ? pipeline.stages.id(stageId)
      : pipeline.stages.find((s) => !s.isWon && !s.isLost && s.order === 0);

    if (!stage) return res.status(400).json({ success: false, error: 'No stage found' });

    const deal = await Deal.create({
      ...rest,
      orgId: req.orgId,
      contact: contactId,
      pipeline: pipeline._id,
      stageId: stage._id,
      stageName: stage.name,
      probability: stage.probability,
      stageHistory: [{ stageId: stage._id, stageName: stage.name, enteredAt: new Date() }],
    });

    await triggerAutomation('deal.created', { deal, orgId: req.orgId });

    emitToOrg(req, 'deal.created', { dealId: deal._id, pipelineId: pipeline._id });

    res.status(201).json({ success: true, deal: { _id: deal._id, title: deal.title } });
  } catch (error) { next(error); }
});

// GET /api/webhooks/contacts - search/fetch contacts from n8n
router.get('/contacts', async (req, res, next) => {
  try {
    const { email, phone, limit = 10 } = req.query;
    const filter = { orgId: req.orgId, isArchived: false };
    if (email) filter.email = email;
    if (phone) filter.phone = phone;

    const contacts = await Contact.find(filter).limit(parseInt(limit)).lean();
    res.json({ success: true, contacts, count: contacts.length });
  } catch (error) { next(error); }
});

// GET /api/webhooks/deals - fetch deals from n8n
router.get('/deals', async (req, res, next) => {
  try {
    const { status = 'open', limit = 10 } = req.query;
    const deals = await Deal.find({ orgId: req.orgId, status })
      .populate('contact', 'firstName lastName email phone')
      .limit(parseInt(limit))
      .lean();
    res.json({ success: true, deals, count: deals.length });
  } catch (error) { next(error); }
});

// POST /api/webhooks/events - n8n can fire arbitrary events to trigger automations
router.post('/events', async (req, res, next) => {
  try {
    const { triggerType, data } = req.body;

    const validTriggers = [
      'contact.created', 'deal.created', 'deal.won', 'deal.lost',
      'deal.stage_changed', 'deal.inactive', 'task.overdue',
    ];

    if (!validTriggers.includes(triggerType)) {
      return res.status(400).json({ success: false, error: 'Invalid trigger type' });
    }

    await triggerAutomation(triggerType, { ...data, orgId: req.orgId });
    res.json({ success: true, message: `Triggered: ${triggerType}` });
  } catch (error) { next(error); }
});

module.exports = router;