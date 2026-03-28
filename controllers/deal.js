const Deal = require('../models/Deal');
const Contact = require('../models/Contact');
const Pipeline = require('../models/Pipeline');
const User = require('../models/User');
const { AppError } = require('../middleware/error');
const { triggerAutomation } = require('../automations/engine');
const { createNotification } = require('./notification');
const { sendDealAssigned } = require('../utils/whatsapp');

// GET /api/deals
const getDeals = async (req, res, next) => {
  try {
    const {
      pipelineId,
      stageId,
      status = 'open',
      assignedTo,
      contactId,
      page = 1,
      limit = 50,
    } = req.query;

    const filter = { orgId: req.orgId };
    if (status) filter.status = status;
    if (pipelineId) filter.pipeline = pipelineId;
    if (stageId) filter.stageId = stageId;
    if (assignedTo) filter.assignedTo = assignedTo;
    if (contactId) filter.contact = contactId;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [deals, total] = await Promise.all([
      Deal.find(filter)
        .populate('contact', 'firstName lastName email phone company')
        .populate('assignedTo', 'name email avatar')
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Deal.countDocuments(filter),
    ]);

    res.json({
      deals,
      pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) },
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/deals/kanban/:pipelineId
const getKanban = async (req, res, next) => {
  try {
    const pipeline = await Pipeline.findOne({ _id: req.params.pipelineId, orgId: req.orgId });
    if (!pipeline) throw new AppError('Pipeline not found', 404);

    const filter = { pipeline: pipeline._id, orgId: req.orgId, status: 'open' };
    if (req.query.assignedTo) filter.assignedTo = req.query.assignedTo;

    const deals = await Deal.find(filter)
      .populate('contact', 'firstName lastName email phone company')
      .populate('assignedTo', 'name email avatar')
      .sort({ updatedAt: -1 })
      .lean();

    const kanban = pipeline.stages.map((stage) => ({
      stage,
      deals: deals.filter((d) => d.stageId.toString() === stage._id.toString()),
      totalValue: deals
        .filter((d) => d.stageId.toString() === stage._id.toString())
        .reduce((sum, d) => sum + (d.value || 0), 0),
    }));

    res.json({ pipeline, kanban });
  } catch (error) {
    next(error);
  }
};

// GET /api/deals/:id
const getDeal = async (req, res, next) => {
  try {
    const deal = await Deal.findOne({ _id: req.params.id, orgId: req.orgId })
      .populate('contact', 'firstName lastName email phone company whatsappUrl')
      .populate('assignedTo', 'name email avatar')
      .populate('pipeline', 'name stages')
      .populate('createdBy', 'name email');

    if (!deal) throw new AppError('Deal not found', 404);
    res.json({ deal });
  } catch (error) {
    next(error);
  }
};

// POST /api/deals
const createDeal = async (req, res, next) => {
  try {
    const { pipelineId, stageId, contactId, ...rest } = req.body;

    const pipeline = await Pipeline.findOne({ _id: pipelineId, orgId: req.orgId });
    if (!pipeline) throw new AppError('Pipeline not found', 404);

    const stage = pipeline.stages.id(stageId);
    if (!stage) throw new AppError('Stage not found', 404);

    const deal = await Deal.create({
      ...rest,
      orgId: req.orgId,
      pipeline: pipelineId,
      stageId,
      stageName: stage.name,
      probability: stage.probability,
      contact: contactId,
      createdBy: req.user._id,
      stageHistory: [{ stageId, stageName: stage.name, enteredAt: new Date() }],
    });

    await deal.populate([
      { path: 'contact', select: 'firstName lastName email phone company' },
      { path: 'assignedTo', select: 'name email avatar' },
    ]);

    // Add to contact timeline
    await Contact.findByIdAndUpdate(contactId, {
      $push: {
        timeline: {
          $each: [{ type: 'deal_created', content: `Deal created: ${deal.title}`, metadata: { dealId: deal._id }, createdBy: req.user._id }],
          $position: 0,
        },
      },
    });

    // Notify assigned user
    if (deal.assignedTo && deal.assignedTo.toString() !== req.user._id.toString()) {
      await createNotification({
        orgId: req.orgId,
        userId: deal.assignedTo,
        type: 'deal_assigned',
        title: 'Deal assigned to you',
        message: `${deal.title} has been assigned to you`,
        resourceType: 'deal',
        resourceId: deal._id,
        io: req.app.get('io'),
      });

      // Send WhatsApp — need to fetch user with phone
      const assignedUser = await User.findById(deal.assignedTo).select('name phone').lean();
      if (assignedUser?.phone) {
        sendDealAssigned({
          phone: assignedUser.phone,
          name: assignedUser.name,
          dealTitle: deal.title,
        }).catch((err) => console.error('WhatsApp deal assigned failed:', err.message));
      }
    }

    await triggerAutomation('deal.created', { deal, orgId: req.orgId });

    res.status(201).json({ deal });
  } catch (error) {
    next(error);
  }
};

// PUT /api/deals/:id
const updateDeal = async (req, res, next) => {
  try {
    const existing = await Deal.findOne({ _id: req.params.id, orgId: req.orgId });
    if (!existing) throw new AppError('Deal not found', 404);

    const { stageId, ...rest } = req.body;
    let stageChanged = false;
    let newStage = null;

    if (stageId && stageId.toString() !== existing.stageId.toString()) {
      const pipeline = await Pipeline.findById(existing.pipeline);
      newStage = pipeline.stages.id(stageId);
      if (!newStage) throw new AppError('Stage not found', 404);
      stageChanged = true;

      // Close out previous stage history entry
      await Deal.findByIdAndUpdate(existing._id, {
        $set: { 'stageHistory.$[last].exitedAt': new Date() },
      }, { arrayFilters: [{ 'last.exitedAt': { $exists: false } }] });

      rest.stageId = stageId;
      rest.stageName = newStage.name;
      rest.probability = newStage.probability;
    }

    const deal = await Deal.findByIdAndUpdate(
      req.params.id,
      {
        $set: rest,
        ...(stageChanged && {
          $push: { stageHistory: { stageId, stageName: newStage.name, enteredAt: new Date() } },
        }),
      },
      { new: true, runValidators: true }
    )
      .populate('contact', 'firstName lastName email phone company')
      .populate('assignedTo', 'name email avatar')
      .populate('pipeline', 'name stages');

    if (stageChanged) {
      await triggerAutomation('deal.stage_changed', {
        deal,
        fromStageId: existing.stageId,
        toStageId: stageId,
        orgId: req.orgId,
      });

      // Update contact timeline
      await Contact.findByIdAndUpdate(deal.contact._id, {
        $push: {
          timeline: {
            $each: [{ type: 'deal_updated', content: `Deal moved to: ${newStage.name}`, metadata: { dealId: deal._id }, createdBy: req.user._id }],
            $position: 0,
          },
        },
      });
    }

    res.json({ deal });
  } catch (error) {
    next(error);
  }
};

// POST /api/deals/:id/won
const markWon = async (req, res, next) => {
  try {
    const deal = await Deal.findOneAndUpdate(
      { _id: req.params.id, orgId: req.orgId },
      { $set: { status: 'won', closedAt: new Date(), probability: 100 } },
      { new: true }
    ).populate('contact assignedTo');

    if (!deal) throw new AppError('Deal not found', 404);

    await triggerAutomation('deal.won', { deal, orgId: req.orgId });

    res.json({ deal });
  } catch (error) {
    next(error);
  }
};

// POST /api/deals/:id/lost
const markLost = async (req, res, next) => {
  try {
    const { reason } = req.body;
    const deal = await Deal.findOneAndUpdate(
      { _id: req.params.id, orgId: req.orgId },
      { $set: { status: 'lost', closedAt: new Date(), lostReason: reason, probability: 0 } },
      { new: true }
    ).populate('contact assignedTo');

    if (!deal) throw new AppError('Deal not found', 404);

    await triggerAutomation('deal.lost', { deal, orgId: req.orgId });

    res.json({ deal });
  } catch (error) {
    next(error);
  }
};

// DELETE /api/deals/:id
const deleteDeal = async (req, res, next) => {
  try {
    const deal = await Deal.findOneAndDelete({ _id: req.params.id, orgId: req.orgId });
    if (!deal) throw new AppError('Deal not found', 404);
    res.json({ message: 'Deal deleted' });
  } catch (error) {
    next(error);
  }
};

module.exports = { getDeals, getKanban, getDeal, createDeal, updateDeal, markWon, markLost, deleteDeal };