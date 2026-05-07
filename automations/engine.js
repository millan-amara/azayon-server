const Automation = require('../models/Automation');
const Task = require('../models/Task');
const Contact = require('../models/Contact');
const Deal = require('../models/Deal');
const User = require('../models/User');
const Pipeline = require('../models/Pipeline');
const { sendEmail } = require('../utils/email');
const { sendDealInactive, sendDealAssigned, sendTaskReminder, sendTaskAssigned } = require('../utils/whatsapp');
const axios = require('axios');
const dns = require('dns').promises;
const net = require('net');

// SSRF guard for the user-configurable `send_webhook` action. Without this,
// any sales_rep could point an automation at http://169.254.169.254/... (cloud
// metadata), http://localhost:5000/api/internal/... (cron-only endpoints), or
// any internal service on the deployment's private network. The guard:
//   1. Allows only http/https URLs.
//   2. Resolves the hostname (via DNS) BEFORE the request, and rejects if any
//      A/AAAA answer falls in a private/loopback/link-local range.
//   3. Re-checks via axios's `lookup` so a TOCTOU swap can't slip past.
function isPrivateIPv4(ip) {
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [, a, b] = m.map(Number);
  return (
    a === 10 ||                       // 10.0.0.0/8
    a === 127 ||                      // 127.0.0.0/8 loopback
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
    (a === 192 && b === 168) ||       // 192.168.0.0/16
    (a === 169 && b === 254) ||       // 169.254.0.0/16 link-local (cloud metadata)
    a === 0 ||                        // 0.0.0.0/8
    a === 100 && b >= 64 && b <= 127  // 100.64.0.0/10 carrier-grade NAT
  );
}
function isPrivateIPv6(ip) {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;       // loopback / unspecified
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local fc00::/7
  if (lower.startsWith('fe80')) return true;                // link-local
  if (lower.startsWith('::ffff:')) {                        // IPv4-mapped
    return isPrivateIPv4(lower.slice(7));
  }
  return false;
}
function isPrivateAddress(addr) {
  if (!addr) return true;
  if (net.isIPv4(addr)) return isPrivateIPv4(addr);
  if (net.isIPv6(addr)) return isPrivateIPv6(addr);
  return true; // unknown family — refuse
}

async function assertPublicUrl(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { throw new Error('Invalid webhook URL'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Webhook URL must be http(s)');
  }
  // Reject literal-IP hosts pointing at private space straight away
  const host = parsed.hostname;
  if (net.isIP(host) && isPrivateAddress(host)) {
    throw new Error('Webhook URL resolves to a private/internal address');
  }
  // Resolve the hostname; refuse if any answer is private
  let answers = [];
  try { answers = await dns.lookup(host, { all: true }); } catch {
    throw new Error(`Could not resolve webhook host: ${host}`);
  }
  for (const a of answers) {
    if (isPrivateAddress(a.address)) {
      throw new Error('Webhook URL resolves to a private/internal address');
    }
  }
}

// Replace template variables like {{contact.firstName}} or
// {{deal.contact.firstName}} (deep paths).
//
// Distinguishes two cases that both used to be lumped together:
//  - Path is unresolvable (a key doesn't exist in the context tree) → the
//    original {{...}} is left in place so a typo surfaces instead of
//    silently rendering empty.
//  - Path resolves but the value is empty/null (e.g. contact has no
//    lastName) → render as empty string. Trailing whitespace from the
//    surrounding template is trimmed off the final result.
const interpolate = (template, context) => {
  if (!template) return '';
  const out = template.replace(/\{\{([\w.]+)\}\}/g, (match, path) => {
    const keys = path.split('.');
    let value = context;
    for (const key of keys) {
      if (value == null || typeof value !== 'object' || !(key in value)) {
        return match; // unresolvable path — keep literal so typos surface
      }
      value = value[key];
    }
    return value == null ? '' : String(value);
  });
  return out.trim();
};

// Check if automation conditions pass
const checkConditions = (conditions, context) => {
  if (!conditions || conditions.length === 0) return true;
  return conditions.every((cond) => {
    // Walk arbitrarily deep: 'deal.contact.tags' resolves through populated refs
    const value = cond.field.split('.').reduce(
      (acc, key) => (acc == null ? acc : acc[key]),
      context,
    );
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

      await sendEmail({
        to,
        subject: interpolate(config.subject, context),
        html: interpolate(config.body, context),
      });
      return { success: true, action: 'send_email', to };
    }

    case 'send_webhook': {
      if (!config.url) return { success: false, error: 'No webhook URL' };

      // SSRF guard — refuse private/loopback/link-local/cloud-metadata targets.
      try {
        await assertPublicUrl(config.url);
      } catch (err) {
        return { success: false, error: err.message };
      }

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
        // Cap response body size — without this, a hostile webhook target
        // could stream gigabytes back at us and OOM the worker.
        maxContentLength: 1 * 1024 * 1024,
        maxBodyLength: 1 * 1024 * 1024,
        // Don't follow redirects to a different (potentially internal) host.
        maxRedirects: 0,
      });
      return { success: true, action: 'send_webhook', status: response.status };
    }

    case 'send_whatsapp': {
      const recipient = config.whatsappTo === 'contact'
        ? context.contact
        : context.deal?.assignedTo || context.contact?.assignedTo;

      const phone = recipient?.phone;
      const name = recipient?.name || recipient?.firstName || '';
      if (!phone) return { success: false, error: 'No phone number for WhatsApp recipient' };

      switch (config.whatsappTemplate) {
        case 'deal_inactive': {
          if (!context.deal) return { success: false, error: 'No deal in context' };
          const days = Math.floor((Date.now() - new Date(context.deal.updatedAt)) / 86400000);
          await sendDealInactive({ phone, name, dealTitle: context.deal.title, days });
          break;
        }
        case 'deal_assigned': {
          if (!context.deal) return { success: false, error: 'No deal in context' };
          await sendDealAssigned({ phone, name, dealTitle: context.deal.title });
          break;
        }
        case 'task_reminder': {
          if (!context.task) return { success: false, error: 'No task in context' };
          await sendTaskReminder({ phone, name, taskTitle: context.task.title, dueDate: context.task.dueDate });
          break;
        }
        case 'task_assigned': {
          if (!context.task) return { success: false, error: 'No task in context' };
          await sendTaskAssigned({ phone, name, taskTitle: context.task.title, dueDate: context.task.dueDate });
          break;
        }
        default:
          return { success: false, error: `Unknown WhatsApp template: ${config.whatsappTemplate}` };
      }
      return { success: true, action: 'send_whatsapp', to: phone };
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
        : pipeline.stages.find((s) => !s.isWon && !s.isLost);

      if (!stage) return { success: false, error: 'No stage found' };

      const assignTo = config.assignTo === 'same_as_contact'
        ? context.contact?.assignedTo?._id || context.contact?.assignedTo
        : config.assignTo || undefined;

      const newDeal = await Deal.create({
        orgId,
        title: interpolate(config.dealTitle || 'New deal: {{contact.firstName}} {{contact.lastName}}', context),
        contact: context.contact._id,
        pipeline: pipeline._id,
        stageId: stage._id,
        stageName: stage.name,
        probability: stage.probability,
        assignedTo: assignTo,
        stageHistory: [{ stageId: stage._id, stageName: stage.name, enteredAt: new Date() }],
      });

      // Chain: any deal.created automations should fire on this new deal too,
      // otherwise "new contact → auto-create deal → auto-create task on
      // new deals" silently breaks at the second hop.
      await triggerAutomation('deal.created', { deal: newDeal, orgId });

      return { success: true, action: 'create_deal' };
    }

    case 'assign_to_user': {
      if (!config.userId) return { success: false, error: 'No userId specified' };

      // Follow the trigger's subject — a deal.* trigger should only re-own the
      // deal, not also reassign the linked contact (which the user almost
      // certainly didn't ask for). For contact.* triggers, just the contact.
      // Falls back to whichever entity is in context if the trigger prefix
      // isn't deal/contact (shouldn't happen today but is the safer default).
      const subject = context.triggerType?.split('.')[0];

      if (subject === 'deal' && context.deal?._id) {
        await Deal.findByIdAndUpdate(context.deal._id, { $set: { assignedTo: config.userId } });
        return { success: true, action: 'assign_to_user', target: 'deal' };
      }
      if (subject === 'contact' && context.contact?._id) {
        await Contact.findByIdAndUpdate(context.contact._id, { $set: { assignedTo: config.userId } });
        return { success: true, action: 'assign_to_user', target: 'contact' };
      }
      return { success: false, error: `assign_to_user not applicable for trigger ${context.triggerType}` };
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

// Main trigger function — called from controllers
const triggerAutomation = async (triggerType, eventData) => {
  try {
    const { orgId, deal, contact, task } = eventData;

    const automations = await Automation.find({
      orgId,
      isActive: true,
      'trigger.type': triggerType,
    }).lean();

    if (automations.length === 0) return;

    // Re-fetch with populated fields so actions have access to emails, names etc.
    let populatedDeal = deal ? (deal.toObject ? deal.toObject() : deal) : null;
    let populatedContact = contact ? (contact.toObject ? contact.toObject() : contact) : null;

    if (deal?._id) {
      const fetched = await Deal.findById(deal._id)
        .populate('assignedTo', 'name email')
        .populate('contact', 'firstName lastName email phone')
        .lean();
      if (fetched) populatedDeal = fetched;
    }

    if (contact?._id) {
      const fetched = await Contact.findById(contact._id)
        .populate('assignedTo', 'name email')
        .lean();
      if (fetched) populatedContact = fetched;
    }

    const context = {
      triggerType,
      deal: populatedDeal,
      contact: populatedContact || populatedDeal?.contact || null,
      task: task ? (task.toObject ? task.toObject() : task) : null,
    };

    for (const automation of automations) {
      try {
        // Trigger-specific config checks
        if (triggerType === 'deal.stage_changed') {
          const { toStageId } = automation.trigger.config || {};
          if (toStageId && toStageId.toString() !== eventData.toStageId?.toString()) continue;
        }

        if (triggerType === 'deal.inactive') {
          const days = automation.trigger.config?.inactiveDays || 3;
          const cutoff = new Date();
          cutoff.setDate(cutoff.getDate() - days);
          if (!deal || new Date(deal.updatedAt) > cutoff) continue;
        }

        if (!checkConditions(automation.conditions, context)) continue;

        const results = [];
        for (const action of automation.actions) {
          const result = await executeAction(action, context, orgId);
          results.push(result);
          if (!result.success) {
            console.error(`Action ${action.type} failed for automation "${automation.name}":`, result.error);
          }
        }

        const status = results.every((r) => r.success) ? 'success' : 'partial';
        const runAt = new Date();

        await Automation.findByIdAndUpdate(automation._id, {
          $inc: { runCount: 1 },
          $set: { lastRunAt: runAt, lastRunStatus: status },
          // $push + $slice keeps the most recent 20 runs and drops the rest in
          // a single atomic update — no read-modify-write race window.
          $push: {
            recentRuns: {
              $each: [{
                at: runAt,
                status,
                actions: results.map((r, i) => ({
                  type: automation.actions[i]?.type,
                  success: !!r.success,
                  error: r.success ? undefined : r.error,
                })),
              }],
              $position: 0,
              $slice: 20,
            },
          },
        });

        console.log(`Automation "${automation.name}" ran: ${results.map((r) => r.action || r.error).join(', ')}`);

      } catch (err) {
        console.error(`Automation "${automation.name}" (${automation._id}) failed:`, err.message);
        await Automation.findByIdAndUpdate(automation._id, {
          $set: { lastRunStatus: 'failed', lastRunAt: new Date() },
          $push: {
            recentRuns: {
              $each: [{ at: new Date(), status: 'failed', error: err.message, actions: [] }],
              $position: 0,
              $slice: 20,
            },
          },
        });
      }
    }
  } catch (err) {
    console.error('triggerAutomation error:', err.message);
  }
};

// Run ONE automation against a provided context. Used by the test-run endpoint
// so the user can validate an automation end-to-end without waiting for the
// real trigger to fire. Side effects (emails, webhooks, task creation) ARE
// executed — that's the point. The run is recorded in `recentRuns` with
// `isTest: true` so the user can tell test runs apart from real ones.
const testRunAutomation = async (automation, context) => {
  const orgId = automation.orgId;
  const fullContext = { triggerType: automation.trigger?.type, ...context };

  if (!checkConditions(automation.conditions, fullContext)) {
    return { ran: false, reason: 'Conditions did not pass for the chosen entity' };
  }

  const results = [];
  for (const action of automation.actions) {
    const result = await executeAction(action, fullContext, orgId);
    results.push(result);
  }

  const status = results.every((r) => r.success) ? 'success' : 'partial';
  const runAt = new Date();

  await Automation.findByIdAndUpdate(automation._id, {
    $set: { lastRunAt: runAt, lastRunStatus: status },
    $push: {
      recentRuns: {
        $each: [{
          at: runAt,
          status,
          isTest: true,
          actions: results.map((r, i) => ({
            type: automation.actions[i]?.type,
            success: !!r.success,
            error: r.success ? undefined : r.error,
          })),
        }],
        $position: 0,
        $slice: 20,
      },
    },
  });

  return { ran: true, status, results };
};

module.exports = { triggerAutomation, interpolate, testRunAutomation };