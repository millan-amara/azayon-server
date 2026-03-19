const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Org', required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  type: {
    type: String,
    enum: [
      'task_due',
      'task_assigned',
      'deal_assigned',
      'deal_won',
      'deal_lost',
      'deal_stage_changed',
      'new_contact',
      'automation_triggered',
      'team_invite',
      'mention',
    ],
    required: true,
  },

  title: { type: String, required: true },
  message: { type: String },

  // Link to relevant resource
  resourceType: { type: String, enum: ['deal', 'contact', 'task', 'automation', 'user'] },
  resourceId: { type: mongoose.Schema.Types.ObjectId },

  isRead: { type: Boolean, default: false, index: true },
  readAt: { type: Date },
}, { timestamps: true });

notificationSchema.index({ userId: 1, isRead: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);