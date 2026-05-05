const mongoose = require('mongoose');

const taskSchema = new mongoose.Schema({
  orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Org', required: true, index: true },

  title: { type: String, required: true, trim: true },
  description: { type: String },

  // Links
  contact: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact' },
  deal: { type: mongoose.Schema.Types.ObjectId, ref: 'Deal' },

  // Assignment
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  // Scheduling
  dueDate: { type: Date },
  dueTime: { type: String }, // e.g. "14:30"

  // Status
  status: {
    type: String,
    enum: ['pending', 'in_progress', 'completed', 'cancelled'],
    default: 'pending',
    index: true,
  },
  priority: {
    type: String,
    enum: ['low', 'medium', 'high'],
    default: 'medium',
  },

  type: {
    type: String,
    enum: ['call', 'email', 'meeting', 'follow_up', 'demo', 'other'],
    default: 'follow_up',
  },

  completedAt: { type: Date },
  reminderSent: { type: Boolean, default: false },
  reminder: {
    offset: { type: Number }, // e.g. 1
    unit: { type: String, enum: ['minutes', 'hours', 'days'] }, // e.g. 'day'
    sendAt: { type: Date }, // pre-computed: dueDate minus offset
    sent: { type: Boolean, default: false },
  },

  // Repeats every N units after the previous one is completed
  recurrence: {
    interval: { type: Number, min: 1 },          // e.g. 30
    unit:     { type: String, enum: ['day', 'week', 'month'] },
    endDate:  { type: Date },                    // optional cutoff
  },
}, { timestamps: true });

taskSchema.index({ orgId: 1, assignedTo: 1, status: 1 });
taskSchema.index({ orgId: 1, dueDate: 1 });
taskSchema.index({ orgId: 1, contact: 1 });
taskSchema.index({ orgId: 1, deal: 1 });
taskSchema.index({ 'reminder.sendAt': 1, 'reminder.sent': 1 }); // for reminder queries

module.exports = mongoose.model('Task', taskSchema);