const express = require('express');
const router = express.Router();
const Task = require('../models/Task');
const Deal = require('../models/Deal');
const User = require('../models/User');
const { sendEmail } = require('../utils/email');
const { sendTaskReminder, sendDealInactive } = require('../utils/whatsapp');
const { triggerAutomation } = require('../automations/engine');

const verifyCronSecret = (req, res, next) => {
  const secret = req.headers['x-cron-secret'];
  if (!secret || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorised' });
  }
  next();
};

// POST /api/internal/send-reminders
// Called every 15 minutes by cron-job.org
router.post('/send-reminders', verifyCronSecret, async (req, res, next) => {
  try {
    const now = new Date();
    const windowStart = new Date(now.getTime() - 2 * 60 * 1000); // 2 min back to catch near-misses
    const windowEnd = new Date(now.getTime() + 6 * 60 * 1000);   // 6 min ahead matches 5-min cron

    console.log(`Reminder check: ${windowStart.toISOString()} → ${windowEnd.toISOString()}`);

    const tasks = await Task.find({
      status: { $in: ['pending', 'in_progress'] },
      'reminder.sendAt': { $gte: windowStart, $lte: windowEnd },
      'reminder.sent': { $ne: true },
    })
      .populate('assignedTo', 'name email phone')
      .populate('contact', 'firstName lastName')
      .populate('deal', 'title')
      .lean();

    console.log(`Found ${tasks.length} task(s) due for reminders`);

    let sent = 0;
    const errors = [];

    for (const task of tasks) {
      try {
        const assignee = task.assignedTo;
        if (!assignee) continue;

        const dueDate = new Date(task.dueDate);
        const dueDateStr = dueDate.toLocaleDateString('en-KE', {
          weekday: 'long', day: 'numeric', month: 'long',
        });
        const dueTimeStr = task.dueTime || dueDate.toLocaleTimeString('en-KE', {
          hour: '2-digit', minute: '2-digit',
        });
        const reminderLabel = `${task.reminder.offset} ${task.reminder.unit}`;
        const contactName = task.contact
          ? `${task.contact.firstName} ${task.contact.lastName}`.trim()
          : null;

        // Send WhatsApp if assignee has a phone number
        if (assignee.phone) {
          sendTaskReminder({
            phone: assignee.phone,
            name: assignee.name,
            taskTitle: task.title,
            dueDate: task.dueDate,
          }).catch((err) => console.error('WhatsApp reminder failed:', err.message));
        }

        // Always send email as well
        if (assignee.email) {
          await sendEmail({
            to: assignee.email,
            subject: `Reminder: ${task.title}`,
            html: `
              <!DOCTYPE html>
              <html>
              <head>
                <meta charset="utf-8"/>
                <style>
                  body { margin: 0; padding: 0; background: #f4f5f7; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
                  .wrapper { max-width: 560px; margin: 40px auto; background: #fff; border-radius: 12px; border: 1px solid #e5e7eb; overflow: hidden; }
                  .header { background: #1e2336; padding: 24px 32px; }
                  .header h1 { margin: 0; color: #fff; font-size: 18px; font-weight: 600; }
                  .body { padding: 28px 32px; }
                  .task-card { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin: 16px 0; }
                  .task-card p { margin: 4px 0; font-size: 14px; color: #374151; }
                  .task-title { font-size: 16px; font-weight: 600; color: #111827 !important; margin-bottom: 8px !important; }
                  .label { color: #6b7280 !important; font-size: 13px !important; }
                  .btn { display: inline-block; background: #5046e4; color: #fff !important; text-decoration: none; padding: 10px 24px; border-radius: 8px; font-size: 14px; font-weight: 600; margin-top: 16px; }
                  .footer { padding: 16px 32px; background: #f9fafb; border-top: 1px solid #e5e7eb; }
                  .footer p { margin: 0; color: #9ca3af; font-size: 12px; }
                </style>
              </head>
              <body>
                <div class="wrapper">
                  <div class="header"><h1>⏰ Task reminder</h1></div>
                  <div class="body">
                    <p style="color:#374151;font-size:15px;margin:0 0 16px">
                      Hi ${assignee.name}, you have a task due in <strong>${reminderLabel}</strong>.
                    </p>
                    <div class="task-card">
                      <p class="task-title">${task.title}</p>
                      <p><span class="label">Due:</span> ${dueDateStr} at ${dueTimeStr}</p>
                      <p><span class="label">Priority:</span> ${task.priority}</p>
                      <p><span class="label">Type:</span> ${task.type.replace('_', ' ')}</p>
                      ${contactName ? `<p><span class="label">Contact:</span> ${contactName}</p>` : ''}
                      ${task.deal ? `<p><span class="label">Deal:</span> ${task.deal.title}</p>` : ''}
                    </div>
                    <a href="${process.env.CLIENT_URL}/tasks" class="btn">View task</a>
                  </div>
                  <div class="footer"><p>${process.env.APP_NAME || 'Azayon'} · Task reminder</p></div>
                </div>
              </body>
              </html>
            `,
          });
        }

        await Task.findByIdAndUpdate(task._id, { $set: { 'reminder.sent': true } });
        sent++;
      } catch (err) {
        errors.push({ taskId: task._id, error: err.message });
        console.error(`Reminder failed for task ${task._id}:`, err.message);
      }
    }

    res.json({ sent, errors: errors.length, message: `Sent ${sent} reminder${sent !== 1 ? 's' : ''}` });
  } catch (error) {
    next(error);
  }
});

// POST /api/internal/run-scheduled-jobs
// Called every hour by cron-job.org
router.post('/run-scheduled-jobs', verifyCronSecret, async (req, res, next) => {
  try {
    const results = { inactiveDeals: 0, overdueTasks: 0, errors: [] };

    // 1. Check for inactive deals — not updated in 3+ days AND not notified in last 24h
    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

    const oneDayAgo = new Date();
    oneDayAgo.setDate(oneDayAgo.getDate() - 1);

    const inactiveDeals = await Deal.find({
      status: 'open',
      updatedAt: { $lt: threeDaysAgo },
      $or: [
        { inactiveNotifiedAt: null },
        { inactiveNotifiedAt: { $lt: oneDayAgo } },
      ],
    }).populate('assignedTo', 'name email phone').populate('contact');

    for (const deal of inactiveDeals) {
      try {
        await triggerAutomation('deal.inactive', { deal, orgId: deal.orgId });

        if (deal.assignedTo?.phone) {
          const daysSince = Math.floor((Date.now() - new Date(deal.updatedAt)) / (1000 * 60 * 60 * 24));
          sendDealInactive({
            phone: deal.assignedTo.phone,
            name: deal.assignedTo.name,
            dealTitle: deal.title,
            days: daysSince,
          }).catch((err) => console.error('WhatsApp deal inactive failed:', err.message));
        }

        // Mark as notified so it won't fire again for 24 hours
        await Deal.findByIdAndUpdate(deal._id, { inactiveNotifiedAt: new Date() });

        results.inactiveDeals++;
      } catch (err) {
        results.errors.push({ type: 'deal.inactive', id: deal._id, error: err.message });
      }
    }

    // 2. Check for overdue tasks
    const overdueTasks = await Task.find({
      status: { $in: ['pending', 'in_progress'] },
      dueDate: { $lt: new Date() },
      reminderSent: false,
    }).populate('assignedTo contact deal');

    for (const task of overdueTasks) {
      try {
        await triggerAutomation('task.overdue', { task, orgId: task.orgId });
        await Task.findByIdAndUpdate(task._id, { $set: { reminderSent: true } });
        results.overdueTasks++;
      } catch (err) {
        results.errors.push({ type: 'task.overdue', id: task._id, error: err.message });
      }
    }

    res.json({
      ...results,
      message: `Processed ${results.inactiveDeals} inactive deals, ${results.overdueTasks} overdue tasks`,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;