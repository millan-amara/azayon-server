const Automation = require('../models/Automation');
const Task = require('../models/Task');
const Contact = require('../models/Contact');
const Deal = require('../models/Deal');
const User = require('../models/User');
const nodemailer = require('nodemailer');
const axios = require('axios');

// Email transporter
const getTransporter = () => nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT),
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

// Replace template variables like {{contact.firstName}}
const interpolate = (template, context) => {
  if (!template) return '';
  return template.replace(/\{\{(\w+\.\w+)\}\}/g, (match, path) => {
    const [obj, key] = path.split('.');
    return context[obj]?.[key] ?? match;
  });
};

// Check if automation conditions pass
const checkConditions = (conditions, context) => {
  if (!conditions || conditions.length === 0) return true;

  return conditions.every((cond) => {
    const [obj, key] = cond.field.split('.');
    const value = context[obj]?.[key];

    switch (cond.operator) {
      case 'equals': return String(value) === String(cond.value);
      case 'not_equals': return String(value) !== String(cond.value);
      case 'contains':
        if (Array.isArray(value)) return value.includes(cond.value);
        return String(value).toLowerCase().includes(String(cond.value).toLowerCase());
      case 'greater_than': return parseFloat(value) > parseFloat(cond.value);
      case 'less_than': return parseFloat(value) < parseFloat(cond.value);
      case 'exists': return value !== undefined && value !== null && value !== '';
      default: return true;
    }
  });
};

// Execute a single action
const executeAction = async (action, context, orgId) => {
  const { type, config } = action;

  switch (type) {
    case 'send_email': {
      const to = config.to === 'contact'
        ? context.contact?.email
        : config.to === 'assigned_user'
          ? context.deal?.assignedTo?.email || context.contact?.assignedTo?.email
          : config.to;

      if (!to) return { success: false, error: 'No email recipient found' };

      const transporter = getTransporter();
      await transporter.sendMail({
        from: process.env.EMAIL_FROM,
        to,
        subject: interpolate(config.subject, context),
        html: interpolate(config.body, context),
      });
      return { success: true, action: 'send_email', to };
    }

    case 'send_webhook': {
      if (!config.url) return { success: false, error: 'No webhook URL' };

      const payload = config.payload === 'full_context'
        ? {
            trigger: context.triggerType,
            contact: context.contact,
            deal: context.deal,
            task: context.task,
            timestamp: new Date().toISOString(),
            orgId,
          }
        : config.payload || {};

      const response = await axios({
        method: config.method || 'POST',
        url: config.url,
        headers: {
          'Content-Type': 'application/json',
          ...(config.headers ? Object.fromEntries(config.headers) : {}),
        },
        data: payload,
        timeout: 10000,
      });

      return { success: true, action: 'send_webhook', status: response.status };
    }

    case 'create_task': {
      const assignTo = config.assignTo === 'same_as_deal'
        ? context.deal?.assignedTo?._id || context.deal?.assignedTo
        : config.assignTo === 'same_as_contact'
          ? context.contact?.assignedTo?._id || context.contact?.assignedTo
          : config.assignTo;

      if (!assignTo) return { success: false, error: 'No user to assign task to' };

      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + (config.taskDueDays || 1));

      await Task.create({
        orgId,
        title: interpolate(config.taskTitle, context),
        type: config.taskType || 'follow_up',
        priority: config.taskPriority || 'medium',
        assignedTo: assignTo,
        contact: context.contact?._id,
        deal: context.deal?._id,
        dueDate,
      });
      return { success: true, action: 'create_task' };
    }

    case 'create_deal': {
      const Deal = require('../models/Deal.model');
      const Pipeline = require('../models/Pipeline.model');

      if (!context.contact?._id) return { success: false, error: 'No contact in context' };

      let pipeline;
      if (config.pipelineId) {
        pipeline = await Pipeline.findById(config.pipelineId);
      } else {
        pipeline = await Pipeline.findOne({ orgId, isDefault: true });
      }
      if (!pipeline) return { success: false, error: 'No pipeline found' };

      const stage = config.stageId
        ? pipeline.stages.id(config.stageId)
        : pipeline.stages.find((s) => !s.isWon && !s.isLost && s.order === 0);

      if (!stage) return { success: false, error: 'No stage found' };

      const assignTo = config.assignTo === 'same_as_contact'
        ? context.contact?.assignedTo?._id || context.contact?.assignedTo
        : config.assignTo || null;

      await Deal.create({
        orgId,
        title: interpolate(config.dealTitle || 'New deal: {{contact.firstName}} {{contact.lastName}}', context),
        contact: context.contact._id,
        pipeline: pipeline._id,
        stageId: stage._id,
        stageName: stage.name,
        probability: stage.probability,
        assignedTo: assignTo || undefined,
        stageHistory: [{ stageId: stage._id, stageName: stage.name, enteredAt: new Date() }],
      });
      return { success: true, action: 'create_deal' };
    }

    case 'assign_to_user': {
      if (!config.userId) return { success: false, error: 'No userId specified' };

      if (context.deal?._id) {
        await Deal.findByIdAndUpdate(context.deal._id, { $set: { assignedTo: config.userId } });
      }
      if (context.contact?._id) {
        await Contact.findByIdAndUpdate(context.contact._id, { $set: { assignedTo: config.userId } });
      }
      return { success: true, action: 'assign_to_user' };
    }

    case 'add_tag': {
      if (context.contact?._id) {
        await Contact.findByIdAndUpdate(context.contact._id, {
          $addToSet: { tags: config.tag },
        });
      }
      return { success: true, action: 'add_tag' };
    }

    case 'update_deal_stage': {
      if (!context.deal?._id) return { success: false, error: 'No deal in context' };
      await Deal.findByIdAndUpdate(context.deal._id, {
        $set: { stageId: config.stageId, stageName: config.stageName },
      });
      return { success: true, action: 'update_deal_stage' };
    }

    default:
      return { success: false, error: `Unknown action type: ${type}` };
  }
};

// Main trigger function - called from controllers
const triggerAutomation = async (triggerType, eventData) => {
  try {
    const { orgId, deal, contact, task } = eventData;

    // Find active automations matching this trigger
    const automations = await Automation.find({
      orgId,
      isActive: true,
      'trigger.type': triggerType,
    }).lean();

    if (automations.length === 0) return;

    const context = {
      triggerType,
      deal: deal ? (deal.toObject ? deal.toObject() : deal) : null,
      contact: contact ? (contact.toObject ? contact.toObject() : contact) : null,
      task: task ? (task.toObject ? task.toObject() : task) : null,
    };

    for (const automation of automations) {
      try {
        // Check trigger-specific config
        if (triggerType === 'deal.stage_changed') {
          const { fromStageId, toStageId } = automation.trigger.config || {};
          if (toStageId && toStageId.toString() !== eventData.toStageId?.toString()) continue;
        }

        if (triggerType === 'deal.inactive') {
          const days = automation.trigger.config?.inactiveDays || 3;
          const cutoff = new Date();
          cutoff.setDate(cutoff.getDate() - days);
          if (!deal || new Date(deal.updatedAt) > cutoff) continue;
        }

        // Check conditions
        if (!checkConditions(automation.conditions, context)) continue;

        // Execute all actions
        const results = [];
        for (const action of automation.actions) {
          const result = await executeAction(action, context, orgId);
          results.push(result);
        }

        // Update stats
        await Automation.findByIdAndUpdate(automation._id, {
          $inc: { runCount: 1 },
          $set: {
            lastRunAt: new Date(),
            lastRunStatus: results.every((r) => r.success) ? 'success' : 'partial',
          },
        });

      } catch (err) {
        console.error(`Automation ${automation._id} failed:`, err.message);
        await Automation.findByIdAndUpdate(automation._id, {
          $set: { lastRunStatus: 'failed', lastRunAt: new Date() },
        });
      }
    }
  } catch (err) {
    console.error('triggerAutomation error:', err.message);
  }
};

module.exports = { triggerAutomation, interpolate };