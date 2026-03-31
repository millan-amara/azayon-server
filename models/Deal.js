const mongoose = require('mongoose');

const dealSchema = new mongoose.Schema({
  orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Org', required: true, index: true },

  title: { type: String, required: true, trim: true },
  value: { type: Number, default: 0, min: 0 },
  currency: { type: String, default: 'KES' },

  // Relationships
  contact: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact', required: true },
  pipeline: { type: mongoose.Schema.Types.ObjectId, ref: 'Pipeline', required: true },
  stageId: { type: mongoose.Schema.Types.ObjectId, required: true }, // ref to pipeline.stages._id
  stageName: { type: String }, // denormalised for performance

  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  // Dates
  expectedCloseDate: { type: Date },
  closedAt: { type: Date },

  // Outcome
  status: {
    type: String,
    enum: ['open', 'won', 'lost'],
    default: 'open',
    index: true,
  },
  lostReason: { type: String, trim: true },

  // Extra
  notes: { type: String },
  probability: { type: Number, min: 0, max: 100, default: 0 },
  tags: [{ type: String, trim: true, lowercase: true }],
  customFields: { type: Map, of: String },

  // Tracks when the last inactive deal notification was sent — prevents spam
  inactiveNotifiedAt: { type: Date, default: null },

  // Attachments
  attachments: [{
    publicId: { type: String, required: true },
    url: { type: String, required: true },
    name: { type: String, required: true },
    size: { type: Number },
    type: { type: String },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    uploadedAt: { type: Date, default: Date.now },
  }],

  // Stage history for tracking how long a deal sits in each stage
  stageHistory: [{
    stageId: mongoose.Schema.Types.ObjectId,
    stageName: String,
    enteredAt: { type: Date, default: Date.now },
    exitedAt: Date,
  }],
}, { timestamps: true });

dealSchema.index({ orgId: 1, status: 1 });
dealSchema.index({ orgId: 1, pipeline: 1, stageId: 1 });
dealSchema.index({ orgId: 1, assignedTo: 1 });
dealSchema.index({ orgId: 1, contact: 1 });
dealSchema.index({ orgId: 1, createdAt: -1 });

module.exports = mongoose.model('Deal', dealSchema);