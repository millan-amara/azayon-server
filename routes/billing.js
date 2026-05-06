const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const Org = require('../models/Org');
const Document = require('../models/Document');
const { protect } = require('../middleware/auth');
const { attachPlan } = require('../middleware/plan');
const { AppError } = require('../middleware/error');

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;

const PLANS = {
  growth_monthly: {
    planCode: 'PLN_gpde83h6795kusw',
    label: 'Growth — KES 3,000/month',
    amount: 299900, // in kobo — matches KES 3,000 plan in Paystack
  },
  growth_annual: {
    planCode: 'PLN_2f18ov066kua7eu',
    label: 'Growth — KES 25,000/year',
    amount: 2499900, // in kobo — matches KES 25,000 plan in Paystack
  },
};

const paystack = async (path, method = 'GET', body = null) => {
  const res = await fetch(`https://api.paystack.co${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${PAYSTACK_SECRET}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res.json();
};

// GET /api/billing/status
router.get('/status', protect, attachPlan, async (req, res, next) => {
  try {
    const org = req.org;
    const limits = req.planLimits;
    const sub = org.subscription;

    res.json({
      plan: sub.plan,
      status: sub.status,
      isOnTrial: limits.isOnTrial,
      trialEndsAt: sub.trialEndsAt,
      trialDaysLeft: sub.trialEndsAt
        ? Math.max(0, Math.ceil((new Date(sub.trialEndsAt) - new Date()) / (1000 * 60 * 60 * 24)))
        : 0,
      subscribedAt: sub.subscribedAt,
      limits,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/billing/initialize
router.post('/initialize', protect, async (req, res, next) => {
  try {
    const { priceKey } = req.body;
    const plan = PLANS[priceKey];
    if (!plan) throw new AppError('Invalid plan', 400);

    const org = await Org.findById(req.orgId);

    const paystackRes = await paystack('/transaction/initialize', 'POST', {
      email: req.user.email,
      amount: plan.amount,
      plan: plan.planCode,
      metadata: {
        orgId: req.orgId.toString(),
        userId: req.user._id.toString(),
        priceKey,
        orgName: org.name,
        cancel_action: `${process.env.CLIENT_URL}/settings?tab=billing`,
      },
      callback_url: `${process.env.CLIENT_URL}/settings?tab=billing&payment=success`,
    });

    console.log('Paystack initialize response:', JSON.stringify(paystackRes));

    if (!paystackRes.status) {
      throw new AppError(paystackRes.message || 'Failed to initialize payment', 500);
    }

    res.json({
      authorizationUrl: paystackRes.data.authorization_url,
      reference: paystackRes.data.reference,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/billing/webhook
router.post('/webhook', async (req, res) => {
  try {
    const signature = req.headers['x-paystack-signature'];
    const rawBody = req.body;

    if (!Buffer.isBuffer(rawBody)) {
      console.error('Webhook body is not a Buffer — body parser conflict');
      return res.sendStatus(500);
    }

    const hash = crypto
      .createHmac('sha512', PAYSTACK_SECRET)
      .update(rawBody)
      .digest('hex');

    // Constant-time compare. `!==` on a string would short-circuit at the
    // first differing character, leaking the prefix length and (over many
    // requests) the true signature byte-by-byte.
    const sigStr = typeof signature === 'string' ? signature : '';
    const a = Buffer.from(hash, 'utf8');
    const b = Buffer.from(sigStr, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      console.error('Paystack webhook signature mismatch');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const event = JSON.parse(rawBody.toString());
    const { event: eventType, data } = event;

    console.log(`Paystack webhook: ${eventType}`);

    if (eventType === 'charge.success') {
      const meta = data.metadata || {};

      // Invoice payment: mark the document as paid
      if (meta.type === 'document' && meta.documentId) {
        const doc = await Document.findById(meta.documentId);
        if (doc && doc.type === 'invoice' && doc.status !== 'paid') {
          doc.status = 'paid';
          doc.paidAt = new Date();
          doc.paidAmount = (data.amount || 0) / 100;
          doc.paymentMethod = (data.channel === 'mobile_money' ? 'mpesa' : data.channel) || 'card';
          doc.paymentReference = data.reference;
          await doc.save();
          console.log(`Invoice ${doc.number} paid via Paystack (ref ${data.reference})`);
        }
        return res.sendStatus(200);
      }

      // Otherwise: subscription / org upgrade flow
      const { orgId, priceKey } = meta;
      if (!orgId) return res.sendStatus(200);

      const org = await Org.findById(orgId);
      if (!org) return res.sendStatus(200);

      org.subscription.plan = 'growth';
      org.subscription.status = 'active';
      org.subscription.subscribedAt = new Date();
      org.subscription.trialEndsAt = null;

      if (data.customer?.customer_code) {
        org.subscription.paystackCustomerCode = data.customer.customer_code;
      }

      await org.save();
      console.log(`Org ${orgId} upgraded to Growth (${priceKey})`);
    }

    if (eventType === 'subscription.create') {
      const customerCode = data.customer?.customer_code;
      const subscriptionCode = data.subscription_code;
      if (!customerCode || !subscriptionCode) return res.sendStatus(200);

      const org = await Org.findOne({ 'subscription.paystackCustomerCode': customerCode });
      if (org) {
        org.subscription.paystackSubscriptionCode = subscriptionCode;
        await org.save();
        console.log(`Stored subscription code ${subscriptionCode} for org ${org._id}`);
      }
    }

    if (eventType === 'invoice.payment_successful') {
      const subscriptionCode = data.subscription?.subscription_code;
      if (!subscriptionCode) return res.sendStatus(200);

      const org = await Org.findOne({ 'subscription.paystackSubscriptionCode': subscriptionCode });
      if (org && org.subscription.status !== 'active') {
        org.subscription.status = 'active';
        await org.save();
        console.log(`Recurring payment succeeded for org ${org._id}`);
      }
    }

    if (eventType === 'invoice.payment_failed') {
      const subscriptionCode = data.subscription?.subscription_code;
      if (!subscriptionCode) return res.sendStatus(200);

      const org = await Org.findOne({ 'subscription.paystackSubscriptionCode': subscriptionCode });
      if (org) {
        org.subscription.status = 'past_due';
        await org.save();
        console.log(`Payment failed for org ${org._id}`);
      }
    }

    if (eventType === 'subscription.disable') {
      const subscriptionCode = data.subscription_code;
      if (!subscriptionCode) return res.sendStatus(200);

      const org = await Org.findOne({ 'subscription.paystackSubscriptionCode': subscriptionCode });
      if (org) {
        org.subscription.status = 'cancelled';
        org.subscription.cancelledAt = new Date();
        await org.save();
        console.log(`Subscription cancelled for org ${org._id}`);
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Paystack webhook error:', err);
    res.sendStatus(500);
  }
});

// POST /api/billing/cancel
router.post('/cancel', protect, async (req, res, next) => {
  try {
    const org = await Org.findById(req.orgId);
    if (!org) throw new AppError('Org not found', 404);

    if (org.subscription.paystackSubscriptionCode) {
      const result = await paystack('/subscription/disable', 'POST', {
        code: org.subscription.paystackSubscriptionCode,
        token: req.body.emailToken,
      });
      console.log('Paystack cancel result:', result.message);
    }

    // Mark as cancelling but keep features active until period ends.
    // Paystack fires subscription.disable when the period actually ends
    // which is when we move to cancelled status.
    org.subscription.cancelledAt = new Date();
    org.subscription.status = 'cancelling';
    await org.save();

    res.json({ message: 'Subscription cancelled. You keep access until the end of your billing period.' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;