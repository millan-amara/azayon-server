const express = require('express');
const router = express.Router();
const Document = require('../models/Document');
const { renderDocumentPdf } = require('../utils/pdf');
const { AppError } = require('../middleware/error');

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;

const paystack = async (path, method = 'GET', body = null) => {
  const r = await fetch(`https://api.paystack.co${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${PAYSTACK_SECRET}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return r.json();
};

// Helper: lookup by public token, expire stale quotes/invoices on the fly
async function getByToken(token) {
  const doc = await Document.findOne({ publicToken: token });
  if (!doc) throw new AppError('Document not found', 404);

  // Auto-expire/overdue calculations
  const now = new Date();
  if (doc.dueDate && doc.dueDate < now) {
    if (doc.type === 'quote' && doc.status === 'sent') {
      doc.status = 'expired';
      await doc.save();
    } else if (doc.type === 'invoice' && doc.status === 'sent') {
      doc.status = 'overdue';
      await doc.save();
    }
  }
  return doc;
}

// GET /api/public/documents/:token — customer-facing fetch (no auth)
router.get('/documents/:token', async (req, res, next) => {
  try {
    const doc = await getByToken(req.params.token);
    // Record first view
    if (!doc.viewedAt) {
      doc.viewedAt = new Date();
      if (doc.status === 'sent') doc.status = 'viewed';
      await doc.save();
    }

    // Strip internal-only fields
    const { internalNotes, orgId, createdBy, ...safe } = doc.toObject();
    void internalNotes; void orgId; void createdBy;
    res.json({ document: safe });
  } catch (err) { next(err); }
});

// GET /api/public/documents/:token/pdf — download PDF (no auth)
router.get('/documents/:token/pdf', async (req, res, next) => {
  try {
    const doc = await getByToken(req.params.token);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${doc.number}.pdf"`);
    renderDocumentPdf(doc.toObject(), res);
  } catch (err) { next(err); }
});

// POST /api/public/documents/:token/pay — initialise Paystack checkout (no auth)
router.post('/documents/:token/pay', async (req, res, next) => {
  try {
    const doc = await getByToken(req.params.token);
    if (doc.type !== 'invoice') throw new AppError('Only invoices can be paid online', 400);
    if (doc.status === 'paid') throw new AppError('This invoice is already paid', 400);
    if (!doc.customerEmail) throw new AppError('Customer email is required to pay online', 400);

    const baseUrl = process.env.CLIENT_URL || 'https://app.azayon.com';

    const result = await paystack('/transaction/initialize', 'POST', {
      email: doc.customerEmail,
      // Paystack amounts are in the smallest currency unit. KES uses kobo-equivalents (×100).
      amount: Math.round(Number(doc.total) * 100),
      currency: doc.currency || 'KES',
      metadata: {
        type: 'document',
        documentId: doc._id.toString(),
        documentNumber: doc.number,
        orgId: doc.orgId.toString(),
      },
      callback_url: `${baseUrl}/i/${doc.publicToken}?paid=success`,
    });

    if (!result.status) {
      throw new AppError(result.message || 'Failed to initialise payment', 500);
    }

    res.json({
      authorizationUrl: result.data.authorization_url,
      reference: result.data.reference,
    });
  } catch (err) { next(err); }
});

module.exports = router;
