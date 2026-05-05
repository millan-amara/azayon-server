const mongoose = require('mongoose');

// Trigger types supported in MVP
const TRIGGER_TYPES = [
  'deal.stage_changed',
  'deal.created',
  'deal.won',
  'deal.lost',
  'contact.created',
  'task.overdue',
  'deal.inactive', // deal has not moved in X days
];

// Action types supported in MVP
const ACTION_TYPES = [
  'send_email',
  'send_webhook',
  'send_whatsapp',
  'create_task',
  'create_deal',
  'assign_to_user',
  'add_tag',
  'update_deal_stage',
];

const conditionSchema = new mongoose.Schema({
  field: String, // e.g. 'deal.value', 'contact.tags', 'deal.stageName'
  operator: { type: String, enum: ['equals', 'not_equals', 'contains', 'greater_than', 'less_than', 'exists'] },
  value: mongoose.Schema.Types.Mixed,
}, { _id: false });

const actionSchema = new mongoose.Schema({
  type: { type: String, enum: ACTION_TYPES, required: true },
  config: {
    // send_email
    to: String,        // 'contact' | 'assigned_user' | specific email
    subject: String,
    body: String,      // supports {{contact.firstName}}, {{deal.title}} etc.

    // send_webhook
    url: String,
    method: { type: String, enum: ['POST', 'GET'], default: 'POST' },
    headers: { type: Map, of: String },
    payload: mongoose.Schema.Types.Mixed, // custom payload or 'full_context'

    // send_whatsapp — uses pre-approved Meta templates from utils/whatsapp.js
    whatsappTemplate: { type: String, enum: ['deal_inactive', 'deal_assigned', 'task_reminder', 'task_assigned'] },
    whatsappTo: String, // 'assigned_user' | 'contact'

    // create_task
    taskTitle: String,
    taskType: String,
    taskDueDays: Number, // due in X days from trigger
    assignTo: String,    // 'same_as_deal' | userId

    // assign_to_user
    userId: mongoose.Schema.Types.ObjectId,

    // add_tag
    tag: String,

    // update_deal_stage
    stageId: mongoose.Schema.Types.ObjectId,
    stageName: String,
  },
}, { _id: false });

const automationSchema = new mongoose.Schema({
  orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Org', required: true, index: true },

  name: { type: String, required: true, trim: true },
  description: { type: String },
  isActive: { type: Boolean, default: true },
  isTemplate: { type: Boolean, default: false }, // pre-built templates

  trigger: {
    type: { type: String, enum: TRIGGER_TYPES, required: true },
    config: {
      // For deal.inactive: how many days of inactivity
      inactiveDays: Number,
      // For deal.stage_changed: which stage triggered it
      fromStageId: mongoose.Schema.Types.ObjectId,
      toStageId: mongoose.Schema.Types.ObjectId,
      pipelineId: mongoose.Schema.Types.ObjectId,
    },
  },

  conditions: [conditionSchema], // optional filters
  actions: [actionSchema],       // what to do

  // Stats
  runCount: { type: Number, default: 0 },
  lastRunAt: { type: Date },
  lastRunStatus: { type: String, enum: ['success', 'failed', 'partial'] },

  // Last 20 runs, newest first. Capped via $push + $slice in the engine so the
  // doc never grows unboundedly. Stored inline (not a separate collection)
  // because the UI always needs them alongside the automation, and 20 small
  // entries × N automations per org is well under any document-size concern.
  recentRuns: {
    type: [{
      at: { type: Date, default: Date.now },
      status: { type: String, enum: ['success', 'failed', 'partial'] },
      isTest: { type: Boolean, default: false }, // true when triggered via "Test run" button
      // Per-action results — a partial run might have 1 success + 1 failure
      actions: [{
        type: { type: String },     // action type that ran
        success: Boolean,
        error: String,              // populated when success=false
      }],
      error: String, // top-level error (when the whole run threw, not a specific action)
    }],
    default: [],
  },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  templateId: { type: String }, // which template this was created from
}, { timestamps: true });

automationSchema.index({ orgId: 1, isActive: 1 });
automationSchema.index({ orgId: 1, 'trigger.type': 1 });

module.exports = mongoose.model('Automation', automationSchema);
module.exports.TRIGGER_TYPES = TRIGGER_TYPES;
module.exports.ACTION_TYPES = ACTION_TYPES;