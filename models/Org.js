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
    maxContacts: Infinity,
    maxDeals: Infinity,
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
  },

  // Subscription
  subscription: {
    plan: { type: String, enum: ['free', 'growth'], default: 'free' },
    status: {
      type: String,
      enum: ['trialing', 'active', 'past_due', 'cancelled', 'free'],
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
  const effectivePlan = (sub.plan === 'growth' && sub.status === 'active') || isOnTrial
    ? 'growth'
    : 'free';
  return { ...PLANS[effectivePlan], effectivePlan, isOnTrial };
};

module.exports = mongoose.model('Org', orgSchema);
module.exports.PLANS = PLANS;