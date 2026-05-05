const mongoose = require('mongoose');

const stageSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  order: { type: Number, required: true },
  color: { type: String, default: '#6366f1' },
  probability: { type: Number, min: 0, max: 100, default: 0 }, // win probability %
  isWon: { type: Boolean, default: false },
  isLost: { type: Boolean, default: false },
});

const pipelineSchema = new mongoose.Schema({
  orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Org', required: true, index: true },
  name: { type: String, required: true, trim: true },
  isDefault: { type: Boolean, default: false },
  stages: [stageSchema],
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  // Visibility:
  //   'org'        — everyone in the org can see and use this pipeline (default,
  //                  matches pre-feature behaviour for existing docs).
  //   'restricted' — only users in `allowedUsers` (plus admins, who bypass the
  //                  filter so they can manage everything).
  // Enforcement lives in utils/pipelineAccess.js — both pipeline routes and
  // deal routes consult it so a deal in a hidden pipeline is also hidden.
  visibility: { type: String, enum: ['org', 'restricted'], default: 'org' },
  allowedUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
}, { timestamps: true });

// Default pipeline stages seeded on creation
pipelineSchema.statics.createDefault = async function (orgId, userId) {
  return this.create({
    orgId,
    name: 'Sales Pipeline',
    isDefault: true,
    createdBy: userId,
    stages: [
      { name: 'New Lead', order: 0, color: '#94a3b8', probability: 10 },
      { name: 'Contacted', order: 1, color: '#60a5fa', probability: 25 },
      { name: 'Qualified', order: 2, color: '#a78bfa', probability: 50 },
      { name: 'Proposal Sent', order: 3, color: '#f59e0b', probability: 70 },
      { name: 'Negotiation', order: 4, color: '#f97316', probability: 85 },
      { name: 'Won', order: 5, color: '#22c55e', probability: 100, isWon: true },
      { name: 'Lost', order: 6, color: '#ef4444', probability: 0, isLost: true },
    ],
  });
};

module.exports = mongoose.model('Pipeline', pipelineSchema);