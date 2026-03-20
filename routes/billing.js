const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const Org = require('../models/Org');
const { protect } = require('../middleware/auth');
const { attachPlan } = require('../middleware/plan');
const { AppError } = require('../middleware/error');

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
const FOUNDING_MEMBER_SLOTS = 20;
const PRICES = {
  growth_monthly: { amount: 300000, label: 'Growth — KES 3,000/month', interval: 'monthly' },
  growth_annual: { amount: 2500000, label: 'Growth — KES 25,000/year', interval: 'annually' },
  founding_monthly: { amount: 150000, label: 'Founding Member — KES 1,500/month', interval: 'monthly' },
};

// Helper — call Paystack API
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

// Simple in-memory cache for founding member count (changes rarely)
let foundingCountCache = { count: null, cachedAt: 0 };
const FOUNDING_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// GET /api/billing/status
router.get('/status', protect, attachPlan, async (req, res, next) => {
  try {
    const org = req.org;
    const limits = req.planLimits;
    const sub = org.subscription;

    // Use cached founding count to avoid hitting DB on every request
    const now = Date.now();
    if (foundingCountCache.count === null || now - foundingCountCache.cachedAt > FOUNDING_CACHE_TTL) {
      foundingCountCache.count = await Org.countDocuments({ 'subscription.isFoundingMember': true });
      foundingCountCache.cachedAt = now;
    }
    const foundingCount = foundingCountCache.count;

    res.json({
      plan: sub.plan,
      status: sub.status,
      isOnTrial: limits.isOnTrial,
      trialEndsAt: sub.trialEndsAt,
      trialDaysLeft: sub.trialEndsAt
        ? Math.max(0, Math.ceil((new Date(sub.trialEndsAt) - new Date()) / (1000 * 60 * 60 * 24)))
        : 0,
      subscribedAt: sub.subscribedAt,
      isFoundingMember: sub.isFoundingMember,
      foundingMemberSlotsLeft: Math.max(0, FOUNDING_MEMBER_SLOTS - foundingCount),
      foundingMemberAvailable: foundingCount < FOUNDING_MEMBER_SLOTS,
      limits,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/billing/initialize
// Creates a Paystack payment session and returns the payment URL
router.post('/initialize', protect, async (req, res, next) => {
  try {
    const { priceKey, email } = req.body;
    if (!PRICES[priceKey]) throw new AppError('Invalid price', 400);

    const org = await Org.findById(req.orgId);
    const price = PRICES[priceKey];

    // Check founding member availability
    if (priceKey === 'founding_monthly') {
      const foundingCount = await Org.countDocuments({ 'subscription.isFoundingMember': true });
      if (foundingCount >= FOUNDING_MEMBER_SLOTS) {
        throw new AppError('Founding member slots are full', 400);
      }
    }

    const paystackRes = await paystack('/transaction/initialize', 'POST', {
      email: email || req.user.email,
      amount: price.amount, // in kobo/pesewas (Paystack uses smallest currency unit)
      currency: 'KES',
      metadata: {
        orgId: req.orgId.toString(),
        userId: req.user._id.toString(),
        priceKey,
        orgName: org.name,
      },
      callback_url: `${process.env.CLIENT_URL}/settings?tab=billing&payment=success`,
      channels: ['card', 'mobile_money', 'bank_transfer'],
    });

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
// Paystack webhook — verifies signature and updates subscription
router.post('/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    const signature = req.headers['x-paystack-signature'];
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));

    const hash = crypto
      .createHmac('sha512', PAYSTACK_SECRET)
      .update(rawBody)
      .digest('hex');

    if (hash !== signature) {
      console.error('Paystack webhook signature mismatch');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const event = JSON.parse(rawBody.toString());
    const { event: eventType, data } = event;

    if (eventType === 'charge.success') {
      const { orgId, priceKey } = data.metadata || {};
      if (!orgId) return res.sendStatus(200);

      const org = await Org.findById(orgId);
      if (!org) return res.sendStatus(200);

      const isFoundingMember = priceKey === 'founding_monthly';
      const isAnnual = priceKey === 'growth_annual';

      org.subscription.plan = 'growth';
      org.subscription.status = 'active';
      org.subscription.subscribedAt = new Date();
      org.subscription.trialEndsAt = null;

      if (isFoundingMember) {
        org.subscription.isFoundingMember = true;
        org.subscription.foundingMemberPrice = 1500;
      }

      if (data.customer?.customer_code) {
        org.subscription.paystackCustomerCode = data.customer.customer_code;
      }

      await org.save();
    }

    if (eventType === 'subscription.disable' || eventType === 'invoice.payment_failed') {
      const orgId = data.metadata?.orgId;
      if (!orgId) return res.sendStatus(200);

      const org = await Org.findById(orgId);
      if (org) {
        org.subscription.status = eventType === 'invoice.payment_failed' ? 'past_due' : 'cancelled';
        if (eventType === 'subscription.disable') org.subscription.cancelledAt = new Date();
        await org.save();
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

    // If they have a Paystack subscription code, cancel it
    if (org.subscription.paystackSubscriptionCode) {
      await paystack(`/subscription/disable`, 'POST', {
        code: org.subscription.paystackSubscriptionCode,
        token: req.body.emailToken,
      });
    }

    org.subscription.status = 'cancelled';
    org.subscription.cancelledAt = new Date();
    await org.save();

    res.json({ message: 'Subscription cancelled. You keep access until the end of your billing period.' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;