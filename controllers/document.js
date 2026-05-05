const Document = require('../models/Document');
const Contact = require('../models/Contact');
const Org = require('../models/Org');
const EmailTemplate = require('../models/EmailTemplate');
const { AppError } = require('../middleware/error');
const { renderDocumentPdf } = require('../utils/pdf');
const { sendEmail } = require('../utils/email');
const { emitToOrg } = require('../utils/socket');

// Build the placeholder context for a given document (used by templates).
function buildDocVars(doc, publicUrl) {
  return {
    customerName:    doc.customerName,
    customerCompany: doc.customerCompany,
    customerEmail:   doc.customerEmail,
    businessName:    doc.fromBusinessName,
    number:          doc.number,
    type:            doc.type,
    total:           `${doc.currency} ${Number(doc.total).toLocaleString('en-KE', { minimumFractionDigits: 2 })}`,
    currency:        doc.currency,
    dueDate:         doc.dueDate ? new Date(doc.dueDate).toLocaleDateString('en-GB') : '',
    issueDate:       doc.issueDate ? new Date(doc.issueDate).toLocaleDateString('en-GB') : '',
    publicUrl,
  };
}

// ── Numbering ──────────────────────────────────────────────────────────────
// Per-org, per-type, per-year sequence. Format: TYPE-YYYY-NNNN
async function nextNumber(orgId, type) {
  const year = new Date().getFullYear();
  const prefix = type === 'quote' ? 'Q' : 'INV';
  const re = new RegExp(`^${prefix}-${year}-(\\d+)$`);

  const latest = await Document
    .findOne({ orgId, type, number: { $regex: re } })
    .sort({ createdAt: -1 })
    .select('number')
    .lean();

  let next = 1;
  if (latest) {
    const m = latest.number.match(re);
    if (m) next = parseInt(m[1], 10) + 1;
  }
  return `${prefix}-${year}-${String(next).padStart(4, '0')}`;
}

// ── List ───────────────────────────────────────────────────────────────────
const listDocuments = async (req, res, next) => {
  try {
    const { type, status, contact, deal, search, page = 1, limit = 25 } = req.query;
    const filter = { orgId: req.orgId };
    if (type) filter.type = type;
    if (status) filter.status = status;
    if (contact) filter.contact = contact;
    if (deal) filter.deal = deal;
    if (search) {
      const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ number: re }, { customerName: re }, { customerCompany: re }];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [documents, total] = await Promise.all([
      Document.find(filter)
        .populate('contact', 'firstName lastName company')
        .populate('deal', 'title')
        .populate('createdBy', 'name')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Document.countDocuments(filter),
    ]);

    res.json({
      documents,
      pagination: { total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) },
    });
  } catch (err) { next(err); }
};

// ── Get single (auth) ──────────────────────────────────────────────────────
const getDocument = async (req, res, next) => {
  try {
    const doc = await Document.findOne({ _id: req.params.id, orgId: req.orgId })
      .populate('contact', 'firstName lastName email phone company')
      .populate('deal', 'title value currency')
      .populate('createdBy', 'name email');
    if (!doc) throw new AppError('Document not found', 404);
    res.json({ document: doc });
  } catch (err) { next(err); }
};

// ── Create ─────────────────────────────────────────────────────────────────
const createDocument = async (req, res, next) => {
  try {
    const { type, contactId, dealId, items = [], taxRate = 0, currency, dueDate, notes, internalNotes } = req.body;

    if (!['quote', 'invoice'].includes(type)) {
      throw new AppError('type must be "quote" or "invoice"', 400);
    }
    if (!contactId) throw new AppError('contactId is required', 400);

    // Snapshot customer + org info now so future edits don't drift the doc
    const [contact, org] = await Promise.all([
      Contact.findOne({ _id: contactId, orgId: req.orgId }).lean(),
      Org.findById(req.orgId).lean(),
    ]);
    if (!contact) throw new AppError('Contact not found', 404);
    if (!org)     throw new AppError('Organisation not found', 404);

    const number = await nextNumber(req.orgId, type);

    const document = new Document({
      orgId: req.orgId,
      type,
      number,
      contact: contactId,
      deal: dealId || undefined,

      customerName:    [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.email || 'Customer',
      customerEmail:   contact.email,
      customerPhone:   contact.phone,
      customerCompany: contact.company,
      customerAddress: [contact.city, contact.country].filter(Boolean).join(', '),

      fromBusinessName: org.name,
      fromEmail:        req.user?.email,
      fromPhone:        req.user?.phone,
      // fromAddress: organisation address — not in schema yet, leaving blank

      items: items.map((it) => ({
        description: String(it.description || '').trim(),
        quantity:    Number(it.quantity)  || 1,
        unitPrice:   Number(it.unitPrice) || 0,
        amount:      0, // recomputed below
      })),
      taxRate:  Number(taxRate) || 0,
      currency: currency || org.settings?.currency || 'KES',
      dueDate:  dueDate ? new Date(dueDate) : undefined,
      notes,
      internalNotes,

      createdBy: req.user._id,
    });

    document.recomputeTotals();
    await document.save();

    emitToOrg(req, 'document.created', { documentId: document._id, type });
    res.status(201).json({ document });
  } catch (err) { next(err); }
};

// ── Update (drafts and sent — non-paid only) ───────────────────────────────
const updateDocument = async (req, res, next) => {
  try {
    const doc = await Document.findOne({ _id: req.params.id, orgId: req.orgId });
    if (!doc) throw new AppError('Document not found', 404);
    if (doc.status === 'paid' || doc.status === 'accepted') {
      throw new AppError(`Cannot edit a ${doc.status} document`, 400);
    }

    const editable = ['items', 'taxRate', 'currency', 'dueDate', 'notes', 'internalNotes',
                      'customerName', 'customerEmail', 'customerPhone', 'customerCompany', 'customerAddress'];
    editable.forEach((k) => {
      if (req.body[k] !== undefined) doc[k] = req.body[k];
    });

    if (Array.isArray(req.body.items)) {
      doc.items = req.body.items.map((it) => ({
        description: String(it.description || '').trim(),
        quantity:    Number(it.quantity)  || 1,
        unitPrice:   Number(it.unitPrice) || 0,
        amount:      0,
      }));
    }

    doc.recomputeTotals();
    await doc.save();

    emitToOrg(req, 'document.updated', { documentId: doc._id, type: doc.type });
    res.json({ document: doc });
  } catch (err) { next(err); }
};

// ── Delete ─────────────────────────────────────────────────────────────────
const deleteDocument = async (req, res, next) => {
  try {
    const doc = await Document.findOneAndDelete({ _id: req.params.id, orgId: req.orgId });
    if (!doc) throw new AppError('Document not found', 404);
    emitToOrg(req, 'document.deleted', { documentId: doc._id, type: doc.type });
    res.json({ message: 'Document deleted' });
  } catch (err) { next(err); }
};

// ── PDF download (auth) ────────────────────────────────────────────────────
const downloadDocumentPdf = async (req, res, next) => {
  try {
    const doc = await Document.findOne({ _id: req.params.id, orgId: req.orgId }).lean();
    if (!doc) throw new AppError('Document not found', 404);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${doc.number}.pdf"`);
    renderDocumentPdf(doc, res);
  } catch (err) { next(err); }
};

// ── Mark sent (records send + returns shareable links) ─────────────────────
const sendDocument = async (req, res, next) => {
  try {
    const { channel = 'email', to, subject, message, templateId } = req.body;
    const doc = await Document.findOne({ _id: req.params.id, orgId: req.orgId });
    if (!doc) throw new AppError('Document not found', 404);

    const baseUrl = process.env.CLIENT_URL || 'https://app.azayon.com';
    const publicUrl = `${baseUrl}/i/${doc.publicToken}`;

    // Resolve template if one was chosen — template fields are *defaults*; explicit subject/message override
    let resolvedSubject = subject;
    let resolvedMessage = message;
    if (templateId) {
      const template = await EmailTemplate.findOne({ _id: templateId, orgId: req.orgId });
      if (!template) throw new AppError('Template not found', 404);
      const vars = buildDocVars(doc, publicUrl);
      resolvedSubject = subject || EmailTemplate.fillPlaceholders(template.subject, vars);
      resolvedMessage = message || EmailTemplate.fillPlaceholders(template.body, vars);
    }

    if (channel === 'email') {
      const recipient = to || doc.customerEmail;
      if (!recipient) throw new AppError('No email address for this customer', 400);

      const isInvoice = doc.type === 'invoice';
      const heading = isInvoice ? 'New invoice' : 'New quote';
      const cta = isInvoice ? 'View & pay invoice' : 'View quote';
      const bodyHtml = resolvedMessage
        ? resolvedMessage.replace(/\n/g, '<br/>')
        : `Please find ${isInvoice ? 'invoice' : 'quote'} <strong>${doc.number}</strong> from <strong>${doc.fromBusinessName}</strong>.`;

      await sendEmail({
        to: recipient,
        subject: resolvedSubject || `${heading} ${doc.number} from ${doc.fromBusinessName}`,
        html: `
          <!DOCTYPE html>
          <html><head><meta charset="utf-8"/></head>
          <body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
            <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:12px;border:1px solid #e5e7eb;overflow:hidden">
              <div style="background:#1e2336;padding:24px 32px"><h1 style="margin:0;color:#fff;font-size:18px;font-weight:600">${heading} ${doc.number}</h1></div>
              <div style="padding:28px 32px;color:#374151;font-size:15px">
                <p style="margin:0 0 16px">Hi ${doc.customerName},</p>
                <p style="margin:0 0 16px">${bodyHtml}</p>
                <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin:16px 0">
                  <p style="margin:0;font-size:13px;color:#6b7280">Total</p>
                  <p style="margin:4px 0 0;font-size:22px;font-weight:700;color:#111827">${doc.currency} ${Number(doc.total).toLocaleString('en-KE', { minimumFractionDigits: 2 })}</p>
                </div>
                <a href="${publicUrl}" style="display:inline-block;background:#5046e4;color:#fff;text-decoration:none;padding:10px 24px;border-radius:8px;font-size:14px;font-weight:600;margin-top:8px">${cta}</a>
              </div>
              <div style="padding:16px 32px;background:#f9fafb;border-top:1px solid #e5e7eb"><p style="margin:0;color:#9ca3af;font-size:12px">${doc.fromBusinessName}${doc.fromEmail ? ' · ' + doc.fromEmail : ''}</p></div>
            </div>
          </body></html>
        `,
      });
    }

    // For WhatsApp we just return the wa.me URL — the user actually clicks it themselves
    let whatsappUrl = null;
    if (channel === 'whatsapp') {
      const phone = (to || doc.customerPhone || '').replace(/\D/g, '');
      if (!phone) throw new AppError('No phone number for this customer', 400);
      const fallback = `Hi ${doc.customerName}, here's ${doc.type} ${doc.number} from ${doc.fromBusinessName}: ${publicUrl}`;
      const text = encodeURIComponent(resolvedMessage || fallback);
      whatsappUrl = `https://wa.me/${phone}?text=${text}`;
    }

    if (doc.status === 'draft') doc.status = 'sent';
    doc.sentAt = new Date();
    await doc.save();

    emitToOrg(req, 'document.sent', { documentId: doc._id, type: doc.type, channel });
    res.json({ document: doc, publicUrl, whatsappUrl });
  } catch (err) { next(err); }
};

// ── Mark invoice paid (manual) ─────────────────────────────────────────────
const markPaid = async (req, res, next) => {
  try {
    const { paymentMethod = 'cash', paymentReference, paidAmount } = req.body;
    const doc = await Document.findOne({ _id: req.params.id, orgId: req.orgId });
    if (!doc) throw new AppError('Document not found', 404);
    if (doc.type !== 'invoice') throw new AppError('Only invoices can be marked paid', 400);

    doc.status = 'paid';
    doc.paidAt = new Date();
    doc.paidAmount = paidAmount != null ? Number(paidAmount) : doc.total;
    doc.paymentMethod = paymentMethod;
    doc.paymentReference = paymentReference;
    await doc.save();

    emitToOrg(req, 'document.paid', { documentId: doc._id });
    res.json({ document: doc });
  } catch (err) { next(err); }
};

// ── Quote actions ──────────────────────────────────────────────────────────
const acceptQuote = async (req, res, next) => {
  try {
    const doc = await Document.findOne({ _id: req.params.id, orgId: req.orgId });
    if (!doc) throw new AppError('Document not found', 404);
    if (doc.type !== 'quote') throw new AppError('Only quotes can be accepted', 400);
    doc.status = 'accepted';
    doc.acceptedAt = new Date();
    await doc.save();
    emitToOrg(req, 'document.updated', { documentId: doc._id, type: doc.type });
    res.json({ document: doc });
  } catch (err) { next(err); }
};

const declineQuote = async (req, res, next) => {
  try {
    const doc = await Document.findOne({ _id: req.params.id, orgId: req.orgId });
    if (!doc) throw new AppError('Document not found', 404);
    if (doc.type !== 'quote') throw new AppError('Only quotes can be declined', 400);
    doc.status = 'declined';
    doc.declinedAt = new Date();
    doc.declineReason = req.body.reason;
    await doc.save();
    emitToOrg(req, 'document.updated', { documentId: doc._id, type: doc.type });
    res.json({ document: doc });
  } catch (err) { next(err); }
};

module.exports = {
  listDocuments, getDocument, createDocument, updateDocument, deleteDocument,
  downloadDocumentPdf, sendDocument, markPaid, acceptQuote, declineQuote,
};
