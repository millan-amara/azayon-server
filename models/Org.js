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

// Helper — get effective plan limits
orgSchema.methods.getPlanLimits = function () {
  const sub = this.subscription;
  const isOnTrial = sub.status === 'trialing' && sub.trialEndsAt && sub.trialEndsAt > new Date();
  const effectivePlan = (sub.plan === 'growth' && (sub.status === 'active' || sub.status === 'cancelling')) || isOnTrial
    ? 'growth'
    : 'free';
  return { ...PLANS[effectivePlan], effectivePlan, isOnTrial };
};

module.exports = mongoose.model('Org', orgSchema);
module.exports.PLANS = PLANS;