const Deal = require('../models/Deal');
const Contact = require('../models/Contact');
const Pipeline = require('../models/Pipeline');
const User = require('../models/User');
const { AppError } = require('../middleware/error');
const { triggerAutomation } = require('../automations/engine');
const { createNotification } = require('./notification');
const { sendDealAssigned } = require('../utils/whatsapp');
const { toCsv, setCsvHeaders } = require('../utils/csv');
const { emitToOrg } = require('../utils/socket');
const { getAllowedPipelineIds, userCanAccessPipeline } = require('../utils/pipelineAccess');

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
    if (stageId) filter.stageId = stageId;
    if (assignedTo) filter.assignedTo = assignedTo;
    if (contactId) filter.contact = contactId;

    // Restrict to pipelines this user can see. If they asked for a specific
    // pipeline they can't access, return an empty list (rather than 403) so
    // the kanban/list UI handles it gracefully — same as filtering to
    // a non-existent pipeline today.
    const allowedIds = await getAllowedPipelineIds(req.user, req.orgId);
    if (pipelineId) {
      const allowed = allowedIds.some((id) => id.toString() === pipelineId.toString());
      if (!allowed) {
        return res.json({ deals: [], pagination: { total: 0, page: parseInt(page), limit: parseInt(limit), pages: 0 } });
      }
      filter.pipeline = pipelineId;
    } else {
      filter.pipeline = { $in: allowedIds };
    }

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
    if (!userCanAccessPipeline(req.user, pipeline)) {
      // 404 not 403 — don't reveal restricted pipeline existence
      throw new AppError('Pipeline not found', 404);
    }

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
      .populate('pipeline', 'name stages visibility allowedUsers')
      .populate('createdBy', 'name email');

    if (!deal) throw new AppError('Deal not found', 404);
    if (!userCanAccessPipeline(req.user, deal.pipeline)) {
      throw new AppError('Deal not found', 404);
    }
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
    if (!userCanAccessPipeline(req.user, pipeline)) {
      throw new AppError('You do not have access to this pipeline', 403);
    }

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

    emitToOrg(req, 'deal.created', { dealId: deal._id, pipelineId: deal.pipeline });

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

      // Sync status + closedAt with the destination stage. Without this, a
      // kanban drag into "Won" leaves status='open' / closedAt=null, so the
      // deal vanishes from won-this-month stats and weekly digests even
      // though it visibly sits in the Won column. Same for "Lost".
      // Reverting a closed deal back to an open stage clears both fields.
      if (newStage.isWon && existing.status !== 'won') {
        rest.status = 'won';
        rest.closedAt = new Date();
      } else if (newStage.isLost && existing.status !== 'lost') {
        rest.status = 'lost';
        rest.closedAt = new Date();
      } else if (!newStage.isWon && !newStage.isLost && existing.status !== 'open') {
        rest.status = 'open';
        rest.closedAt = null;
      }
    }

    const deal = await Deal.findByIdAndUpdate(
      req.params.id,
      {
        $set: { ...rest, inactiveNotifiedAt: null }, // reset so inactive alert can fire again after next 3 days
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

      // If the move also changed status (open → won/lost), fire the
      // status-transition trigger too. Otherwise users with a "deal won →
      // tag as customer" automation get nothing when reps drag to Won
      // (they only get it via the explicit Mark-Won button).
      if (newStage.isWon && existing.status !== 'won') {
        await triggerAutomation('deal.won', { deal, orgId: req.orgId });
      } else if (newStage.isLost && existing.status !== 'lost') {
        await triggerAutomation('deal.lost', { deal, orgId: req.orgId });
      }

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

    emitToOrg(req, 'deal.updated', {
      dealId: deal._id,
      pipelineId: deal.pipeline?._id || deal.pipeline,
      stageChanged,
    });

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

    emitToOrg(req, 'deal.won', { dealId: deal._id, pipelineId: deal.pipeline });

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

    emitToOrg(req, 'deal.lost', { dealId: deal._id, pipelineId: deal.pipeline });

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

    emitToOrg(req, 'deal.deleted', { dealId: deal._id, pipelineId: deal.pipeline });

    res.json({ message: 'Deal deleted' });
  } catch (error) {
    next(error);
  }
};

// POST /api/deals/import — bulk-create deals from a CSV, auto-linking or
// auto-creating contacts, with stage mapping by name (falling back to default).
const importDeals = async (req, res, next) => {
  try {
    const { deals: rows, pipelineId, defaultStageId, autoCreateContacts = true } = req.body;

    if (!Array.isArray(rows) || rows.length === 0) {
      throw new AppError('No deals provided', 400);
    }
    if (rows.length > 500) {
      throw new AppError('Maximum 500 deals per import', 400);
    }

    const pipeline = await Pipeline.findOne({ _id: pipelineId, orgId: req.orgId });
    if (!pipeline) throw new AppError('Pipeline not found', 404);
    if (!userCanAccessPipeline(req.user, pipeline)) {
      throw new AppError('You do not have access to this pipeline', 403);
    }

    const defaultStage = defaultStageId ? pipeline.stages.id(defaultStageId) : null;
    if (!defaultStage) throw new AppError('Default stage is required', 400);

    // Build a lowercase stage-name index so per-row "Stage" columns map cleanly
    const stageByName = new Map(pipeline.stages.map((s) => [s.name.toLowerCase().trim(), s]));

    const results = { imported: 0, contactsCreated: 0, skipped: 0, errors: [] };

    for (const row of rows) {
      try {
        const title = String(row.title || '').trim();
        if (!title) { results.skipped++; continue; }

        // Resolve contact: by email, then by name, else auto-create if we have *something*
        const email = row.contactEmail ? String(row.contactEmail).toLowerCase().trim() : null;
        const phone = row.contactPhone ? String(row.contactPhone).trim() : null;

        let contact = null;
        if (email)  contact = await Contact.findOne({ orgId: req.orgId, email });
        if (!contact && phone) contact = await Contact.findOne({ orgId: req.orgId, phone });

        if (!contact) {
          const nameField = String(row.contactName || '').trim();
          const [first, ...rest] = nameField ? nameField.split(/\s+/) : [];
          const firstName = first || (email ? email.split('@')[0] : '');
          const lastName  = rest.join(' ');

          if (autoCreateContacts && (firstName || email)) {
            contact = await Contact.create({
              orgId:     req.orgId,
              firstName: firstName || 'Unknown',
              lastName,
              email:     email || undefined,
              phone:     phone || undefined,
              source:    'import',
              createdBy: req.user._id,
            });
            results.contactsCreated++;
          } else {
            results.skipped++;
            continue;
          }
        }

        // Resolve stage — per-row "Stage" column wins, otherwise default
        const stageName = String(row.stageName || '').toLowerCase().trim();
        const stage = (stageName && stageByName.get(stageName)) || defaultStage;

        const value = Number(row.value) || 0;
        const expectedCloseDate = row.expectedCloseDate ? new Date(row.expectedCloseDate) : undefined;

        await Deal.create({
          orgId:    req.orgId,
          title,
          value,
          currency: String(row.currency || pipeline.currency || 'KES').toUpperCase(),
          contact:  contact._id,
          pipeline: pipeline._id,
          stageId:  stage._id,
          stageName: stage.name,
          probability: stage.probability,
          expectedCloseDate: Number.isFinite(expectedCloseDate?.getTime()) ? expectedCloseDate : undefined,
          notes: row.notes ? String(row.notes) : undefined,
          createdBy: req.user._id,
          stageHistory: [{ stageId: stage._id, stageName: stage.name, enteredAt: new Date() }],
        });
        results.imported++;
      } catch (err) {
        results.errors.push({ row: row.title || '(unnamed)', error: err.message });
      }
    }

    emitToOrg(req, 'deals.imported', { count: results.imported });

    res.json({
      ...results,
      errors: results.errors.length, // collapse to a count to keep the response small
      message: `Imported ${results.imported} deal${results.imported === 1 ? '' : 's'}` +
        (results.contactsCreated ? `, created ${results.contactsCreated} new contact${results.contactsCreated === 1 ? '' : 's'}` : '') +
        (results.skipped ? `, skipped ${results.skipped}` : ''),
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/deals/export — CSV download, respects same filters as list
const exportDeals = async (req, res, next) => {
  try {
    const { pipelineId, stageId, status, assignedTo, contactId } = req.query;
    const filter = { orgId: req.orgId };
    if (status) filter.status = status;
    if (stageId) filter.stageId = stageId;
    if (assignedTo) filter.assignedTo = assignedTo;
    if (contactId) filter.contact = contactId;

    // Same pipeline-visibility gate as getDeals — keeps the export from
    // leaking deals from a restricted pipeline.
    const allowedIds = await getAllowedPipelineIds(req.user, req.orgId);
    if (pipelineId) {
      const allowed = allowedIds.some((id) => id.toString() === pipelineId.toString());
      if (!allowed) {
        setCsvHeaders(res, `deals-${new Date().toISOString().slice(0, 10)}.csv`);
        return res.send(toCsv([{ key: 'title', label: 'Title' }], []));
      }
      filter.pipeline = pipelineId;
    } else {
      filter.pipeline = { $in: allowedIds };
    }

    const deals = await Deal.find(filter)
      .populate('contact', 'firstName lastName email phone company')
      .populate('assignedTo', 'name email')
      .populate('pipeline', 'name')
      .sort({ updatedAt: -1 })
      .limit(10000)
      .lean();

    const columns = [
      { key: 'title',    label: 'Title' },
      { key: 'value',    label: 'Value' },
      { key: 'currency', label: 'Currency' },
      { label: 'Pipeline',          get: (r) => r.pipeline?.name || '' },
      { key: 'stageName',           label: 'Stage' },
      { key: 'status',              label: 'Status' },
      { label: 'Probability %',     get: (r) => r.probability ?? '' },
      { label: 'Contact name',      get: (r) => [r.contact?.firstName, r.contact?.lastName].filter(Boolean).join(' ') },
      { label: 'Contact company',   get: (r) => r.contact?.company || '' },
      { label: 'Contact email',     get: (r) => r.contact?.email || '' },
      { label: 'Contact phone',     get: (r) => r.contact?.phone || '' },
      { label: 'Assigned to',       get: (r) => r.assignedTo?.name || '' },
      { label: 'Expected close',    get: (r) => r.expectedCloseDate ? new Date(r.expectedCloseDate).toISOString().slice(0, 10) : '' },
      { label: 'Closed at',         get: (r) => r.closedAt ? new Date(r.closedAt).toISOString().slice(0, 10) : '' },
      { key: 'lostReason',          label: 'Lost reason' },
      { label: 'Tags',              get: (r) => (r.tags || []).join('; ') },
      { label: 'Created',           get: (r) => r.createdAt ? new Date(r.createdAt).toISOString().slice(0, 10) : '' },
    ];

    const csv = toCsv(columns, deals);
    const stamp = new Date().toISOString().slice(0, 10);
    setCsvHeaders(res, `deals-${stamp}.csv`);
    res.send(csv);
  } catch (error) {
    next(error);
  }
};

module.exports = { getDeals, getKanban, getDeal, createDeal, updateDeal, markWon, markLost, deleteDeal, exportDeals, importDeals };