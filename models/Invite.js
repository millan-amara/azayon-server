const mongoose = require('mongoose');

const inviteSchema = new mongoose.Schema({
  orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Org', required: true, index: true },
  email: { type: String, required: true, lowercase: true, trim: true },
  name: { type: String, required: true, trim: true },
  role: { type: String, enum: ['admin', 'sales_rep', 'viewer'], default: 'sales_rep' },
  token: { type: String, required: true, unique: true },
  invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  expiresAt: { type: Date, required: true },
  status: { type: String, enum: ['pending', 'accepted', 'expired'], default: 'pending' },
}, { timestamps: true });

inviteSchema.index({ orgId: 1, status: 1 });

module.exports = mongoose.model('Invite', inviteSchema);