const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const PLANS = {
  free: {
    name: 'Free',
    maxContacts: 200,
    maxDeals: 20,
    maxUsers: 1,
    features: ['pipeline', 'contacts', 'tasks'],
  },
  growth: {
    name: 'Growth',
    maxContacts: 999999,
    maxDeals: 999999,
    maxUsers: 5,
    features: ['pipeline', 'contacts', 'tasks', 'automations', 'ai', 'attachments', 'webhooks'],
  },
};

const orgSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  slug: { type: String, unique: true, lowercase: true },
  apiKey: { type: String, unique: true },
  settings: {
    currency: { type: String, default: 'KES' },
    timezone: { type: String, default: 'Africa/Nairobi' },
    dateFormat: { type: String, default: 'DD/MM/YYYY' },
    businessHours: {
      start: { type: String, default: '09:00' },
      end: { type: String, default: '17:00' },
      workDays: { type: [Number], default: [1, 2, 3, 4, 5] }, // 0=Sun ... 6=Sat
    },
    // Branding applied to invoices, quotes, and the public document page.
    // These values are *snapshotted* onto each Document at creation time
    // (see Document.fromLogoUrl / fromBrandColor / fromFooterText / fromAddress)
    // so historical documents keep their original branding if the org later
    // changes its logo or colors.
    branding: {
      logoUrl:      { type: String },           // Cloudinary secure_url
      logoPublicId: { type: String },           // for deletion on replace
      brandColor:   { type: String },           // hex, e.g. '#5046e4'
      address:      { type: String },           // multi-line business address
      footerText:   { type: String },           // shown at the bottom of every PDF
    },
  },

  // First-time setup tracking. The wizard renders until completed/skipped is true.
  onboarding: {
    completed:   { type: Boolean, default: false },
    completedAt: { type: Date },
    skipped:     { type: Boolean, default: false },
  },

  // Optional Paystack Subaccount for receiving customer payments directly to
  // the org's bank account. When set, online invoice payments are routed to
  // this subaccount; funds never touch the platform's Paystack balance.
  paystackSubaccount: {
    code:          { type: String },          // 'ACCT_xxx' from Paystack
    businessName:  { type: String },          // cached for display
    bankName:      { type: String },          // cached, e.g. 'Equity Bank'
    bankCode:      { type: String },          // Paystack's bank code, e.g. '068'
    accountLast4:  { type: String },          // last 4 digits, never the full number
    connectedAt:   { type: Date },
  },

  // Subscription
  subscription: {
    plan: { type: String, enum: ['free', 'growth'], default: 'free' },
    status: {
      type: String,
      enum: ['trialing', 'active', 'cancelling', 'past_due', 'cancelled', 'free'],
      default: 'trialing',
    },
    trialEndsAt: { type: Date },
    subscribedAt: { type: Date },
    cancelledAt: { type: Date },
    // When set in the future, the org is in past_due but still has Growth
    // access ("dunning grace") — a 5-day window after the first failed
    // payment for the user to update their card before features hard-lock.
    // Cleared on recovery (active) or escalation (cancelled).
    pastDueGraceEndsAt: { type: Date },
    // Paystack
    paystackCustomerCode: { type: String },
    paystackSubscriptionCode: { type: String },
    // Founding member
    isFoundingMember: { type: Boolean, default: false },
    foundingMemberPrice: { type: Number }, // KES
  },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

orgSchema.pre('save', async function () {
  if (!this.apiKey) {
    this.apiKey = `crm_${uuidv4().replace(/-/g, '')}`;
  }
  if (!this.slug) {
    this.slug = this.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  }
});

// Helper — get effective plan limits.
// Paid Growth (active or cancelling): full Growth caps and features.
// Trial: Growth FEATURE SET (automations, AI, attachments, webhooks) so the
//   user can sample premium capabilities — but Free NUMERIC CAPS on
//   contacts / deals / users. The wall they hit during the trial is what
//   actually motivates an upgrade; previously trial was indistinguishable
//   from paid Growth and there was no in-trial pressure to convert.
// Everyone else (free, past_due, cancelled, expired trial): Free.
orgSchema.methods.getPlanLimits = function () {
  const sub = this.subscription;
  const now = new Date();
  const isOnTrial = sub.status === 'trialing' && sub.trialEndsAt && sub.trialEndsAt > now;
  const inPastDueGrace = sub.status === 'past_due' && sub.pastDueGraceEndsAt && sub.pastDueGraceEndsAt > now;
  // Treat past_due as Growth while inside the dunning grace window. Without
  // this, a single failed card retry would instantly break n8n webhooks,
  // automations, and AI for a paying customer mid-month — far too harsh.
  const isPaidGrowth = sub.plan === 'growth' && (sub.status === 'active' || sub.status === 'cancelling' || inPastDueGrace);

  if (isPaidGrowth) {
    return { ...PLANS.growth, effectivePlan: 'growth', isOnTrial: false };
  }
  if (isOnTrial) {
    return {
      ...PLANS.free,
      features: PLANS.growth.features,
      effectivePlan: 'free',
      isOnTrial: true,
    };
  }
  return { ...PLANS.free, effectivePlan: 'free', isOnTrial: false };
};

module.exports = mongoose.model('Org', orgSchema);
module.exports.PLANS = PLANS;