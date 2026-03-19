const Contact = require('../models/Contact');
const Deal = require('../models/Deal');
const Task = require('../models/Task');
const { AppError } = require('../middleware/error');
const { triggerAutomation } = require('../automations/engine');

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
    const data = { ...req.body };

    //Strip empty strings from ObjectId fields to avoid CastErrors
    if(!data.assignedTo) delete data.assignedTo;

    const contact = await Contact.create({
      ...data,
      orgId: req.orgId,
      createdBy: req.user?._id,
    });

    await contact.populate('assignedTo', 'name email avatar');

    // Trigger automations
    await triggerAutomation('contact.created', { contact, orgId: req.orgId });

    res.status(201).json({ contact });
  } catch (error) {
    next(error);
  }
};

// PUT /api/contacts/:id
const updateContact = async (req, res, next) => {
  try {
    const contact = await Contact.findOneAndUpdate(
      { _id: req.params.id, orgId: req.orgId },
      { $set: req.body },
      { new: true }
    ).populate('assignedTo', 'name email avatar');

    if (!contact) throw new AppError('Contact not found', 404);

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
const importContacts = async (req, res, next) => {
  try {
    const { contacts } = req.body; // array of contact objects from parsed CSV

    if (!Array.isArray(contacts) || contacts.length === 0) {
      throw new AppError('No contacts provided', 400);
    }

    if (contacts.length > 500) {
      throw new AppError('Maximum 500 contacts per import', 400);
    }

    const docs = contacts.map((c) => ({
      ...c,
      orgId: req.orgId,
      createdBy: req.user._id,
      source: 'import',
    }));

    const result = await Contact.insertMany(docs, { ordered: false });

    res.json({
      imported: result.length,
      message: `Successfully imported ${result.length} contacts`,
    });
  } catch (error) {
    if (error.writeErrors) {
      return res.json({
        imported: error.insertedDocs?.length || 0,
        errors: error.writeErrors.length,
        message: `Imported with ${error.writeErrors.length} errors`,
      });
    }
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
};