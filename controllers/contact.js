const Contact = require('../models/Contact');
const Deal = require('../models/Deal');
const Task = require('../models/Task');
const { AppError } = require('../middleware/error');
const { triggerAutomation } = require('../automations/engine');
const { toCsv, setCsvHeaders } = require('../utils/csv');
const { emitToOrg } = require('../utils/socket');

// GET /api/contacts
const getContacts = async (req, res, next) => {
  try {
    const {
      page = 1,
      limit = 20,
      search,
      status,
      tags,
      assignedTo,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = req.query;

    const filter = { orgId: req.orgId, isArchived: false };

    if (search) {
      filter.$text = { $search: search };
    }
    if (status) filter.status = status;
    if (tags) filter.tags = { $in: tags.split(',') };
    if (assignedTo) filter.assignedTo = assignedTo;

    const sort = { [sortBy]: sortOrder === 'asc' ? 1 : -1 };
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [contacts, total] = await Promise.all([
      Contact.find(filter)
        .populate('assignedTo', 'name email avatar')
        .sort(sort)
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Contact.countDocuments(filter),
    ]);

    res.json({
      contacts,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/contacts/:id
const getContact = async (req, res, next) => {
  try {
    const contact = await Contact.findOne({ _id: req.params.id, orgId: req.orgId })
      .populate('assignedTo', 'name email avatar')
      .populate('createdBy', 'name email');

    if (!contact) throw new AppError('Contact not found', 404);

    // Get related deals and tasks
    const [deals, tasks] = await Promise.all([
      Deal.find({ contact: contact._id, orgId: req.orgId })
        .populate('assignedTo', 'name email')
        .sort({ createdAt: -1 })
        .lean(),
      Task.find({ contact: contact._id, orgId: req.orgId, status: { $ne: 'cancelled' } })
        .populate('assignedTo', 'name email')
        .sort({ dueDate: 1 })
        .lean(),
    ]);

    res.json({ contact, deals, tasks });
  } catch (error) {
    next(error);
  }
};

// POST /api/contacts
const createContact = async (req, res, next) => {
  try {
    const data = pickFields(req.body, CONTACT_EDITABLE_FIELDS);

    //Strip empty strings from ObjectId fields to avoid CastErrors
    if (!data.assignedTo) delete data.assignedTo;

    const contact = await Contact.create({
      ...data,
      orgId: req.orgId,
      createdBy: req.user?._id,
    });

    await contact.populate('assignedTo', 'name email avatar');

    // Trigger automations
    await triggerAutomation('contact.created', { contact, orgId: req.orgId });

    emitToOrg(req, 'contact.created', { contactId: contact._id });

    res.status(201).json({ contact });
  } catch (error) {
    next(error);
  }
};

// Whitelist of fields the contact PUT/POST may set. Anything else (orgId,
// createdBy, isArchived, _id, timeline, attachments) is server-controlled —
// without this filter, a `$set: req.body` would let any user move a contact
// to another org, rewrite the activity timeline, or replace attachments.
const CONTACT_EDITABLE_FIELDS = [
  'firstName', 'lastName', 'email', 'phone', 'company', 'jobTitle',
  'status', 'tags', 'notes', 'source', 'city', 'country',
  'assignedTo', 'birthday', 'anniversary', 'whatsappUrl', 'customFields',
  'address', 'website', 'leadScore',
];

const pickFields = (body, allowed) => {
  const out = {};
  if (!body || typeof body !== 'object') return out;
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(body, key)) out[key] = body[key];
  }
  return out;
};

// PUT /api/contacts/:id
const updateContact = async (req, res, next) => {
  try {
    const updates = pickFields(req.body, CONTACT_EDITABLE_FIELDS);

    const contact = await Contact.findOneAndUpdate(
      { _id: req.params.id, orgId: req.orgId },
      { $set: updates },
      { new: true, runValidators: true }
    ).populate('assignedTo', 'name email avatar');

    if (!contact) throw new AppError('Contact not found', 404);

    emitToOrg(req, 'contact.updated', { contactId: contact._id });

    res.json({ contact });
  } catch (error) {
    next(error);
  }
};

// DELETE /api/contacts/:id
const deleteContact = async (req, res, next) => {
  try {
    const contact = await Contact.findOneAndUpdate(
      { _id: req.params.id, orgId: req.orgId },
      { isArchived: true },
      { new: true }
    );
    if (!contact) throw new AppError('Contact not found', 404);

    emitToOrg(req, 'contact.archived', { contactId: contact._id });

    res.json({ message: 'Contact archived' });
  } catch (error) {
    next(error);
  }
};

// POST /api/contacts/:id/timeline
const addTimelineEntry = async (req, res, next) => {
  try {
    const { type, content, metadata } = req.body;

    const contact = await Contact.findOneAndUpdate(
      { _id: req.params.id, orgId: req.orgId },
      {
        $push: {
          timeline: {
            $each: [{ type, content, metadata, createdBy: req.user._id }],
            $position: 0,
          },
        },
        $set: { lastContactedAt: new Date() },
      },
      { new: true }
    );

    if (!contact) throw new AppError('Contact not found', 404);

    emitToOrg(req, 'contact.updated', { contactId: contact._id });

    res.json({ timeline: contact.timeline });
  } catch (error) {
    next(error);
  }
};

// GET /api/contacts/tags/all
const getAllTags = async (req, res, next) => {
  try {
    const tags = await Contact.distinct('tags', { orgId: req.orgId, isArchived: false });
    res.json({ tags: tags.filter(Boolean).sort() });
  } catch (error) {
    next(error);
  }
};

// POST /api/contacts/import
//
// Automation policy: by default, CSV imports do NOT fire `contact.created`
// automations. The reasoning: a 500-row import would otherwise spawn 500
// follow-up tasks, 500 emails, 500 webhooks — the kind of thing that gets
// users' Mailgun account flagged. Manual create and n8n create both still fire.
// If the importer genuinely wants automations to run, they pass
// `triggerAutomations: true` and accept the consequences.
const importContacts = async (req, res, next) => {
  try {
    const { contacts, triggerAutomations = false } = req.body;

    if (!Array.isArray(contacts) || contacts.length === 0) {
      throw new AppError('No contacts provided', 400);
    }

    if (contacts.length > 500) {
      throw new AppError('Maximum 500 contacts per import', 400);
    }

    // Filter every imported row through the editable-field whitelist before
    // stamping the server-controlled fields. Stops a crafted import row from
    // setting orgId, _id, isArchived, attachments, timeline, etc.
    const docs = contacts.map((c) => ({
      ...pickFields(c, CONTACT_EDITABLE_FIELDS),
      orgId: req.orgId,
      createdBy: req.user._id,
      source: 'import',
    }));

    const result = await Contact.insertMany(docs, { ordered: false });

    if (triggerAutomations) {
      // Run sequentially, not in parallel — a hundred concurrent automation
      // chains would hammer the DB and any external webhooks.
      for (const contact of result) {
        await triggerAutomation('contact.created', { contact, orgId: req.orgId })
          .catch((err) => console.error(`Automation trigger failed for imported contact ${contact._id}:`, err.message));
      }
    }

    emitToOrg(req, 'contacts.imported', { count: result.length });

    res.json({
      imported: result.length,
      automationsTriggered: triggerAutomations,
      message: `Successfully imported ${result.length} contacts`,
    });
  } catch (error) {
    if (error.writeErrors) {
      emitToOrg(req, 'contacts.imported', { count: error.insertedDocs?.length || 0 });
      return res.json({
        imported: error.insertedDocs?.length || 0,
        errors: error.writeErrors.length,
        message: `Imported with ${error.writeErrors.length} errors`,
      });
    }
    next(error);
  }
};

// POST /api/contacts/bulk — apply an action to many contacts at once
const bulkUpdateContacts = async (req, res, next) => {
  try {
    const { ids, action, payload = {} } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      throw new AppError('No contacts selected', 400);
    }
    if (ids.length > 500) {
      throw new AppError('You can update up to 500 contacts at a time', 400);
    }

    const filter = { _id: { $in: ids }, orgId: req.orgId };
    let result;

    switch (action) {
      case 'assign':
        // payload.assignedTo: userId | null
        result = await Contact.updateMany(filter, {
          $set: { assignedTo: payload.assignedTo || null },
        });
        break;

      case 'addTag': {
        const tag = String(payload.tag || '').trim();
        if (!tag) throw new AppError('Tag is required', 400);
        result = await Contact.updateMany(filter, { $addToSet: { tags: tag } });
        break;
      }

      case 'removeTag': {
        const tag = String(payload.tag || '').trim();
        if (!tag) throw new AppError('Tag is required', 400);
        result = await Contact.updateMany(filter, { $pull: { tags: tag } });
        break;
      }

      case 'setStatus': {
        const allowed = ['lead', 'prospect', 'customer', 'churned', 'other'];
        if (!allowed.includes(payload.status)) {
          throw new AppError('Invalid status', 400);
        }
        result = await Contact.updateMany(filter, { $set: { status: payload.status } });
        break;
      }

      case 'archive':
        result = await Contact.updateMany(filter, { $set: { isArchived: true } });
        break;

      default:
        throw new AppError(`Unknown action: ${action}`, 400);
    }

    emitToOrg(req, 'contacts.bulk_updated', { ids, action });

    res.json({
      updated: result.modifiedCount,
      message: `${result.modifiedCount} contact${result.modifiedCount === 1 ? '' : 's'} updated`,
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/contacts/export — CSV download, respects the same filters as list
const exportContacts = async (req, res, next) => {
  try {
    const { search, status, tags, assignedTo } = req.query;
    const filter = { orgId: req.orgId, isArchived: false };

    if (search) filter.$text = { $search: search };
    if (status) filter.status = status;
    if (tags) filter.tags = { $in: tags.split(',') };
    if (assignedTo) filter.assignedTo = assignedTo;

    const contacts = await Contact.find(filter)
      .populate('assignedTo', 'name email')
      .sort({ createdAt: -1 })
      .limit(10000)
      .lean();

    const columns = [
      { key: 'firstName', label: 'First name' },
      { key: 'lastName',  label: 'Last name' },
      { key: 'email',     label: 'Email' },
      { key: 'phone',     label: 'Phone' },
      { key: 'company',   label: 'Company' },
      { key: 'jobTitle',  label: 'Job title' },
      { key: 'status',    label: 'Status' },
      { key: 'source',    label: 'Source' },
      { key: 'city',      label: 'City' },
      { key: 'country',   label: 'Country' },
      { label: 'Tags',        get: (r) => (r.tags || []).join('; ') },
      { label: 'Assigned to', get: (r) => r.assignedTo?.name || '' },
      { label: 'Notes',       get: (r) => r.notes || '' },
      { label: 'Created',     get: (r) => r.createdAt ? new Date(r.createdAt).toISOString().slice(0, 10) : '' },
    ];

    const csv = toCsv(columns, contacts);
    const stamp = new Date().toISOString().slice(0, 10);
    setCsvHeaders(res, `contacts-${stamp}.csv`);
    res.send(csv);
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getContacts,
  getContact,
  createContact,
  updateContact,
  deleteContact,
  addTimelineEntry,
  getAllTags,
  importContacts,
  exportContacts,
  bulkUpdateContacts,
};