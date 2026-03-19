const mongoose = require('mongoose');

const timelineEntrySchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['note', 'call', 'email', 'whatsapp', 'deal_created', 'deal_updated', 'task_created', 'system'],
    required: true,
  },
  content: { type: String, required: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  metadata: { type: mongoose.Schema.Types.Mixed }, // extra data e.g. deal id, call duration
}, { timestamps: true });

const contactSchema = new mongoose.Schema({
  orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Org', required: true, index: true },

  // Core fields
  firstName: { type: String, required: true, trim: true },
  lastName: { type: String, trim: true, default: '' },
  email: { type: String, lowercase: true, trim: true },
  phone: { type: String, trim: true }, // used for WhatsApp wa.me link
  company: { type: String, trim: true },
  jobTitle: { type: String, trim: true },
  website: { type: String, trim: true },

  // Address
  city: { type: String, trim: true },
  country: { type: String, trim: true, default: 'Kenya' },

  // CRM fields
  status: {
    type: String,
    enum: ['lead', 'prospect', 'customer', 'churned', 'other'],
    default: 'lead',
  },
  source: {
    type: String,
    enum: ['website', 'referral', 'social_media', 'whatsapp', 'manual', 'n8n', 'import', 'other'],
    default: 'manual',
  },
  tags: [{ type: String, trim: true, lowercase: true }],
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  // Custom fields (flexible key-value)
  customFields: { type: Map, of: String },

  // Notes (quick note field separate from timeline)
  notes: { type: String },

  // Timeline
  timeline: [timelineEntrySchema],

  // Attachments
  attachments: [{
    publicId: { type: String, required: true },   // Cloudinary public_id for deletion
    url: { type: String, required: true },          // Cloudinary secure_url
    name: { type: String, required: true },         // original filename
    size: { type: Number },                         // bytes
    type: { type: String },                         // mime type
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    uploadedAt: { type: Date, default: Date.now },
  }],

  // Metadata
  isArchived: { type: Boolean, default: false },
  lastContactedAt: { type: Date },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

// Full name virtual
contactSchema.virtual('fullName').get(function () {
  return `${this.firstName} ${this.lastName}`.trim();
});

// WhatsApp link virtual
contactSchema.virtual('whatsappUrl').get(function () {
  if (!this.phone) return null;
  const cleaned = this.phone.replace(/\D/g, '');
  return `https://wa.me/${cleaned}`;
});

contactSchema.set('toJSON', { virtuals: true });
contactSchema.set('toObject', { virtuals: true });

// Indexes for search and filtering
contactSchema.index({ orgId: 1, createdAt: -1 });
contactSchema.index({ orgId: 1, email: 1 });
contactSchema.index({ orgId: 1, tags: 1 });
contactSchema.index({ orgId: 1, assignedTo: 1 });
contactSchema.index({ orgId: 1, status: 1 });

// Text search index
contactSchema.index({
  firstName: 'text',
  lastName: 'text',
  email: 'text',
  company: 'text',
  phone: 'text',
});

module.exports = mongoose.model('Contact', contactSchema);