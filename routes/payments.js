const express = require('express');
const router = express.Router();
const Org = require('../models/Org');
const { protect, requireRole } = require('../middleware/auth');
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

router.use(protect);

// GET /api/payments/banks?country=kenya — proxies Paystack's bank list for the
// dropdown in the connect-account form. Cached on Paystack's side; no need to
// cache locally for now.
router.get('/banks', async (req, res, next) => {
  try {
    const country = req.query.country || 'kenya';
    const result = await paystack(`/bank?country=${encodeURIComponent(country)}`);
    if (!result.status) throw new AppError(result.message || 'Failed to load banks', 502);
    // Trim to fields the UI needs
    const banks = (result.data || []).map((b) => ({ name: b.name, code: b.code, slug: b.slug }));
    res.json({ banks });
  } catch (err) { next(err); }
});

// GET /api/payments/subaccount — current org's subaccount status (any user can read)
router.get('/subaccount', async (req, res, next) => {
  try {
    const org = await Org.findById(req.orgId).select('paystackSubaccount').lean();
    res.json({ subaccount: org?.paystackSubaccount || null });
  } catch (err) { next(err); }
});

// POST /api/payments/subaccount — admin connects (or replaces) the bank account
//
// Body: { businessName, bankCode, accountNumber }
// Calls Paystack to create the subaccount, then stores the code + cached display
// fields on the org. We only retain the last 4 digits of the account number.
router.post('/subaccount', requireRole('admin'), async (req, res, next) => {
  try {
    const { businessName, bankCode, accountNumber } = req.body;
    if (!businessName?.trim()) throw new AppError('Business name is required', 400);
    if (!bankCode)             throw new AppError('Bank is required', 400);
    if (!accountNumber || !/^\d{6,20}$/.test(String(accountNumber).trim())) {
      throw new AppError('Account number must be digits only (6-20 chars)', 400);
    }

    // Optional but a great UX: verify the account name with Paystack first so we
    // can fail fast and avoid creating a misconfigured subaccount.
    const verify = await paystack(
      `/bank/resolve?account_number=${encodeURIComponent(accountNumber.trim())}&bank_code=${encodeURIComponent(bankCode)}`
    );
    if (!verify.status) {
      throw new AppError(verify.message || 'Account verification failed — check the bank and account number', 400);
    }
    const verifiedAccountName = verify.data?.account_name;

    // Create the subaccount. percentage_charge=0 means we take no platform fee —
    // the merchant gets 100% (minus Paystack's normal transaction fee).
    const result = await paystack('/subaccount', 'POST', {
      business_name: businessName.trim(),
      settlement_bank: bankCode,
      account_number: accountNumber.trim(),
      percentage_charge: 0,
      primary_contact_email: req.user.email,
      primary_contact_name:  req.user.name,
    });
    if (!result.status) {
      throw new AppError(result.message || 'Could not create subaccount with Paystack', 502);
    }

    // Look up the bank's display name from Paystack's banks list (avoid a second round-trip
    // by accepting an optional bankName from the client; fall back to verify response if any).
    const bankName = req.body.bankName || result.data?.settlement_bank || '';

    const org = await Org.findByIdAndUpdate(
      req.orgId,
      {
        $set: {
          paystackSubaccount: {
            code:         result.data.subaccount_code,
            businessName: businessName.trim(),
            bankName,
            bankCode,
            accountLast4: accountNumber.trim().slice(-4),
            connectedAt:  new Date(),
          },
        },
      },
      { new: true }
    ).select('paystackSubaccount');

    res.json({
      subaccount: org.paystackSubaccount,
      verifiedAccountName,
      message: `Connected ${bankName || 'bank'} account ending ${accountNumber.trim().slice(-4)}`,
    });
  } catch (err) { next(err); }
});

// DELETE /api/payments/subaccount — admin disconnects. We don't delete the
// Paystack subaccount itself (it's the org's, not ours); we just drop our local
// reference so the Pay button stops appearing. They can reconnect anytime.
router.delete('/subaccount', requireRole('admin'), async (req, res, next) => {
  try {
    await Org.findByIdAndUpdate(req.orgId, { $unset: { paystackSubaccount: 1 } });
    res.json({ message: 'Disconnected. Online payments are paused for new invoices.' });
  } catch (err) { next(err); }
});

module.exports = router;
