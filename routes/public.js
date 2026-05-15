const express = require('express');
const router = express.Router();
const Document = require('../models/Document');
const Org = require('../models/Org');
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

    // Whether the issuing business has a Paystack Subaccount connected — drives
    // whether the public page can show the "Pay online" button.
    const org = await Org.findById(doc.orgId).select('paystackSubaccount.code').lean();
    const orgHasOnlinePayment = !!org?.paystackSubaccount?.code;

    // Strip internal-only fields
    const { internalNotes, orgId, createdBy, ...safe } = doc.toObject();
    void internalNotes; void orgId; void createdBy;
    res.json({ document: safe, orgHasOnlinePayment });
  } catch (err) { next(err); }
});

// GET /api/public/documents/:token/pdf — download PDF (no auth)
router.get('/documents/:token/pdf', async (req, res, next) => {
  try {
    const doc = await getByToken(req.params.token);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${doc.number}.pdf"`);
    await renderDocumentPdf(doc.toObject(), res);
  } catch (err) { next(err); }
});

// POST /api/public/documents/:token/pay — initialise Paystack checkout (no auth)
//
// If the invoice was created without a customer email (common when contacts
// are phone-only), the customer can supply one in the request body. We then
// snapshot it onto the invoice so the next pay-attempt skips the prompt.
router.post('/documents/:token/pay', async (req, res, next) => {
  try {
    const doc = await getByToken(req.params.token);
    if (doc.type !== 'invoice') throw new AppError('Only invoices can be paid online', 400);
    if (doc.status === 'paid') throw new AppError('This invoice is already paid', 400);

    const providedEmail = String(req.body?.email || '').trim().toLowerCase();
    // Quick sanity: looks like an email at all
    const validProvided = providedEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(providedEmail);

    const email = doc.customerEmail || (validProvided ? providedEmail : '');
    if (!email) {
      throw new AppError('Please enter a valid email to receive your receipt', 400);
    }

    // Persist the customer-supplied email so future pay attempts work without re-asking
    if (!doc.customerEmail && validProvided) {
      doc.customerEmail = providedEmail;
      await doc.save();
    }

    // The merchant must have connected a Paystack Subaccount, otherwise we
    // can't route the funds to them. Refuse rather than letting money land
    // in the platform's account.
    const org = await Org.findById(doc.orgId).select('paystackSubaccount').lean();
    const subaccountCode = org?.paystackSubaccount?.code;
    if (!subaccountCode) {
      throw new AppError(
        'Online payment is not set up for this business yet. Please pay using the contact details on the invoice.',
        400
      );
    }

    const baseUrl = process.env.CLIENT_URL || 'https://app.azayon.com';

    const result = await paystack('/transaction/initialize', 'POST', {
      email,
      // Paystack amounts are in the smallest currency unit. KES uses kobo-equivalents (×100).
      amount: Math.round(Number(doc.total) * 100),
      currency: doc.currency || 'KES',
      // Route the funds straight to the merchant's bank account. `bearer: subaccount`
      // means Paystack's transaction fee comes off their side, not the platform's.
      subaccount: subaccountCode,
      bearer: 'subaccount',
      metadata: {
        type: 'document',
        documentId: doc._id.toString(),
        documentNumber: doc.number,
        orgId: doc.orgId.toString(),
        subaccount: subaccountCode,
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

// POST /api/public/documents/:token/verify-payment
//
// Called by the public page after Paystack redirects the user back. We don't
// trust the redirect alone — we hit Paystack's verify API to confirm the
// transaction succeeded, then mark the invoice as paid. This belt-and-braces
// approach means a missing/slow webhook never leaves an invoice stuck in
// "pending" while the customer's money has already been taken.
//
// Idempotent: if the doc is already paid, we just return it.
router.post('/documents/:token/verify-payment', async (req, res, next) => {
  try {
    const reference = String(req.body?.reference || '').trim();
    if (!reference) throw new AppError('Reference is required', 400);

    const doc = await getByToken(req.params.token);
    if (doc.type !== 'invoice') throw new AppError('Not an invoice', 400);

    if (doc.status === 'paid') {
      return res.json({ document: doc.toObject() });
    }

    const result = await paystack(`/transaction/verify/${encodeURIComponent(reference)}`);
    if (!result.status || result.data?.status !== 'success') {
      throw new AppError('Payment not yet confirmed by Paystack', 402);
    }

    // Sanity check: the transaction's metadata should match this invoice
    if (result.data.metadata?.documentId &&
        result.data.metadata.documentId !== doc._id.toString()) {
      throw new AppError('Reference does not match this invoice', 400);
    }

    doc.status = 'paid';
    doc.paidAt = new Date();
    doc.paidAmount = (result.data.amount || 0) / 100;
    doc.paymentMethod = (result.data.channel === 'mobile_money' ? 'mpesa' : result.data.channel) || 'card';
    doc.paymentReference = reference;
    await doc.save();

    res.json({ document: doc.toObject() });
  } catch (err) { next(err); }
});

module.exports = router;
