const mongoose = require('mongoose');
const crypto = require('crypto');

// One model serves both quotes and invoices — they share 90% of fields.
// Status semantics differ slightly per type:
//   quote:   draft → sent → viewed → accepted | declined | expired
//   invoice: draft → sent → viewed → paid     | overdue   | cancelled
const ALL_STATUSES = [
  'draft', 'sent', 'viewed',
  'accepted', 'declined', 'expired',
  'paid', 'overdue', 'cancelled',
];

const lineItemSchema = new mongoose.Schema({
  description: { type: String, required: true, trim: true },
  quantity:    { type: Number, required: true, min: 0, default: 1 },
  unitPrice:   { type: Number, required: true, min: 0, default: 0 },
  amount:      { type: Number, required: true, min: 0, default: 0 },
}, { _id: true });

const documentSchema = new mongoose.Schema({
  orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Org', required: true, index: true },
  type:  { type: String, enum: ['quote', 'invoice'], required: true, index: true },

  // Auto-generated, e.g. "INV-2026-0001" or "Q-2026-0001"
  number: { type: String, required: true, index: true },

  // Source links
  contact: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact' },
  deal:    { type: mongoose.Schema.Types.ObjectId, ref: 'Deal' },

  // Customer snapshot at the time of creation (so doc doesn't drift if contact is edited)
  customerName:    { type: String, required: true },
  customerEmail:   { type: String },
  customerPhone:   { type: String },
  customerCompany: { type: String },
  customerAddress: { type: String },

  // Issuer snapshot at the time of creation (so historical docs keep the old business name etc.)
  fromBusinessName: { type: String, required: true },
  fromEmail:        { type: String },
  fromPhone:        { type: String },
  fromAddress:      { type: String },

  // Line items + totals
  items:     { type: [lineItemSchema], default: [] },
  subtotal:  { type: Number, required: true, default: 0 },
  taxRate:   { type: Number, default: 0, min: 0, max: 100 }, // %
  taxAmount: { type: Number, default: 0 },
  total:     { type: Number, required: true, default: 0 },
  currency:  { type: String, default: 'KES' },

  // Dates
  issueDate:   { type: Date, default: () => new Date() },
  dueDate:     { type: Date }, // invoices: due-by; quotes: validity expiry
  // Status & lifecycle
  status: { type: String, enum: ALL_STATUSES, default: 'draft', index: true },
  sentAt:   { type: Date },
  viewedAt: { type: Date },

  // Payment (invoice)
  paidAt:           { type: Date },
  paidAmount:       { type: Number },
  paymentMethod:    { type: String, enum: ['mpesa', 'card', 'bank_transfer', 'cash', 'other'] },
  paymentReference: { type: String },

  // Acceptance (quote)
  acceptedAt:  { type: Date },
  declinedAt:  { type: Date },
  declineReason: { type: String },

  // Public access — customer-facing URL uses this token
  publicToken: { type: String, unique: true, sparse: true, index: true },

  // Notes
  notes:         { type: String }, // shown on document
  internalNotes: { type: String }, // private to team

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

// Compound indexes for common queries
documentSchema.index({ orgId: 1, type: 1, status: 1 });
documentSchema.index({ orgId: 1, contact: 1 });
documentSchema.index({ orgId: 1, deal: 1 });

documentSchema.pre('save', async function () {
  if (!this.publicToken) {
    this.publicToken = crypto.randomBytes(24).toString('hex');
  }
});

// Compute totals from line items — call from controller before saving
documentSchema.methods.recomputeTotals = function () {
  const items = this.items || [];
  items.forEach((it) => {
    it.amount = Math.round((Number(it.quantity) || 0) * (Number(it.unitPrice) || 0) * 100) / 100;
  });
  this.subtotal = items.reduce((s, it) => s + (it.amount || 0), 0);
  this.taxAmount = Math.round(this.subtotal * (Number(this.taxRate) || 0)) / 100;
  this.total = Math.round((this.subtotal + this.taxAmount) * 100) / 100;
};

module.exports = mongoose.model('Document', documentSchema);
module.exports.ALL_STATUSES = ALL_STATUSES;
