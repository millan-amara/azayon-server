const express = require('express');
const router = express.Router();
const Task = require('../models/Task');
const Deal = require('../models/Deal');
const User = require('../models/User');
const Contact = require('../models/Contact');
const Org = require('../models/Org');
const { sendEmail } = require('../utils/email');
const { sendTaskReminder } = require('../utils/whatsapp');
const { triggerAutomation } = require('../automations/engine');

const formatMoney = (amount, currency = 'KES') => {
  const n = Number(amount) || 0;
  return `${currency} ${n.toLocaleString('en-KE', { maximumFractionDigits: 0 })}`;
};

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

        await Task.findByIdAndUpdate(
          task._id,
          { $set: { 'reminder.sent': true } },
          { timestamps: false }
        );
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

    // 1. Check for inactive deals — not updated in 3+ days, AND we haven't
    // already notified about THIS inactivity period.
    //
    // Dedup rule: "fire only if there's been a real update since the last
    // notification". Comparing `inactiveNotifiedAt` to `updatedAt` (via $expr)
    // means a deal stays silent after one ping until something actually changes
    // on it. Pair this with `{ timestamps: false }` on the notification write
    // below — otherwise the write itself bumps updatedAt and we ping forever.
    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

    const inactiveDeals = await Deal.find({
      status: 'open',
      updatedAt: { $lt: threeDaysAgo },
      $expr: {
        $or: [
          { $eq: ['$inactiveNotifiedAt', null] },
          { $lt: ['$inactiveNotifiedAt', '$updatedAt'] },
        ],
      },
    }).populate('assignedTo', 'name email phone').populate('contact');

    for (const deal of inactiveDeals) {
      try {
        // WhatsApp/email/task on inactive deals is now user-controlled via
        // automations (trigger: deal.inactive, action: send_whatsapp/email/etc).
        // No hardcoded channel — users opt in to whatever they want.
        await triggerAutomation('deal.inactive', { deal, orgId: deal.orgId });

        // Mark as notified for THIS inactivity period. `timestamps: false` is
        // critical: without it, Mongoose bumps `updatedAt` on every write,
        // which would make the inactivity check think the deal had fresh
        // activity and re-fire 3 days later in an infinite loop.
        await Deal.findByIdAndUpdate(
          deal._id,
          { inactiveNotifiedAt: new Date() },
          { timestamps: false }
        );

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
        // Same reasoning as deal.inactive: don't let a system-flag write
        // disguise itself as user activity by bumping updatedAt.
        await Task.findByIdAndUpdate(
          task._id,
          { $set: { reminderSent: true } },
          { timestamps: false }
        );
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

// POST /api/internal/check-birthdays
// Called daily (e.g. 06:00 EAT) by cron-job.org. Spawns a follow-up task for
// every contact whose birthday or anniversary lands tomorrow, so reps can wish
// them in advance. Idempotent — won't duplicate if a task already exists.
router.post('/check-birthdays', verifyCronSecret, async (req, res, next) => {
  try {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dom = tomorrow.getDate();
    const month = tomorrow.getMonth() + 1; // Mongo's $month is 1-indexed

    // Find all contacts (across all orgs) whose birthday or anniversary
    // falls on tomorrow's month/day, ignoring the year.
    const matches = await Contact.aggregate([
      { $match: { isArchived: false, $or: [{ birthday: { $ne: null } }, { anniversary: { $ne: null } }] } },
      {
        $project: {
          orgId: 1, firstName: 1, lastName: 1, assignedTo: 1, createdBy: 1,
          isBirthday:    {
            $and: [
              { $ne: ['$birthday', null] },
              { $eq: [{ $dayOfMonth: '$birthday' }, dom] },
              { $eq: [{ $month: '$birthday' }, month] },
            ],
          },
          isAnniversary: {
            $and: [
              { $ne: ['$anniversary', null] },
              { $eq: [{ $dayOfMonth: '$anniversary' }, dom] },
              { $eq: [{ $month: '$anniversary' }, month] },
            ],
          },
        },
      },
      { $match: { $or: [{ isBirthday: true }, { isAnniversary: true }] } },
    ]);

    // The reminder task is dated for tomorrow at 09:00 EAT
    const dueIso = `${tomorrow.toISOString().slice(0, 10)}T09:00:00+03:00`;
    const dueDate = new Date(dueIso);
    const startOfDay = new Date(tomorrow); startOfDay.setHours(0, 0, 0, 0);
    const endOfDay   = new Date(tomorrow); endOfDay.setHours(23, 59, 59, 999);

    const results = { created: 0, skipped: 0, errors: [] };

    for (const c of matches) {
      try {
        const fullName = [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'this contact';
        const occasion = c.isBirthday ? 'birthday' : 'anniversary';
        const title = c.isBirthday
          ? `🎂 Wish ${fullName} a happy birthday`
          : `💐 Anniversary tomorrow for ${fullName}`;

        // De-dup: skip if a task for this contact already exists in tomorrow's window
        const existing = await Task.findOne({
          orgId: c.orgId,
          contact: c._id,
          dueDate: { $gte: startOfDay, $lte: endOfDay },
          title: { $regex: occasion === 'birthday' ? 'birthday' : 'nniversary', $options: 'i' },
        }).lean();
        if (existing) { results.skipped++; continue; }

        const assignedTo = c.assignedTo || c.createdBy;
        if (!assignedTo) { results.skipped++; continue; }

        await Task.create({
          orgId: c.orgId,
          title,
          contact: c._id,
          assignedTo,
          createdBy: assignedTo,
          dueDate,
          dueTime: '09:00',
          status: 'pending',
          priority: 'medium',
          type: 'follow_up',
        });
        results.created++;
      } catch (err) {
        results.errors.push({ contactId: c._id, error: err.message });
      }
    }

    res.json({ ...results, message: `Created ${results.created}, skipped ${results.skipped}` });
  } catch (error) {
    next(error);
  }
});

// ── Weekly digest email ──────────────────────────────────────────────────────
// Build the HTML body for one org's weekly digest.
function renderDigestHtml({ org, admin, wonStats, lostCount, newContacts, topRep, biggest }) {
  const currency = org.settings?.currency || 'KES';
  const winRate = (wonStats.count + lostCount) > 0
    ? Math.round((wonStats.count / (wonStats.count + lostCount)) * 100)
    : null;
  const reportsUrl = `${process.env.CLIENT_URL || 'https://app.azayon.com'}/reports`;

  return `
    <!DOCTYPE html>
    <html><head><meta charset="utf-8"/></head>
    <body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
      <div style="max-width:600px;margin:40px auto;background:#fff;border-radius:12px;border:1px solid #e5e7eb;overflow:hidden">
        <div style="background:#1e2336;padding:24px 32px">
          <h1 style="margin:0;color:#fff;font-size:18px;font-weight:600">📊 Your week at ${org.name}</h1>
          <p style="margin:6px 0 0;color:#9ca3af;font-size:13px">Last 7 days · for ${admin.name || 'team admin'}</p>
        </div>

        <div style="padding:28px 32px;color:#374151;font-size:15px">
          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 20px 0;">
            <tr>
              <td style="padding:0 8px 0 0;width:50%;vertical-align:top;">
                <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:14px;">
                  <p style="margin:0;font-size:11px;color:#16a34a;text-transform:uppercase;letter-spacing:.04em;font-weight:600;">Won</p>
                  <p style="margin:4px 0 0;font-size:22px;font-weight:700;color:#111827;">${formatMoney(wonStats.value, currency)}</p>
                  <p style="margin:2px 0 0;font-size:13px;color:#6b7280;">${wonStats.count} deal${wonStats.count === 1 ? '' : 's'}</p>
                </div>
              </td>
              <td style="padding:0 0 0 8px;width:50%;vertical-align:top;">
                <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:14px;">
                  <p style="margin:0;font-size:11px;color:#dc2626;text-transform:uppercase;letter-spacing:.04em;font-weight:600;">Lost</p>
                  <p style="margin:4px 0 0;font-size:22px;font-weight:700;color:#111827;">${lostCount}</p>
                  <p style="margin:2px 0 0;font-size:13px;color:#6b7280;">${winRate != null ? `${winRate}% win rate` : 'no closed deals'}</p>
                </div>
              </td>
            </tr>
          </table>

          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 20px 0;">
            <tr>
              <td style="padding:0 8px 0 0;width:50%;vertical-align:top;">
                <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:14px;">
                  <p style="margin:0;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;font-weight:600;">Top performer</p>
                  <p style="margin:4px 0 0;font-size:16px;font-weight:600;color:#111827;">${topRep ? topRep.name : '—'}</p>
                  <p style="margin:2px 0 0;font-size:13px;color:#6b7280;">${topRep ? `${formatMoney(topRep.value, currency)} · ${topRep.count} deal${topRep.count === 1 ? '' : 's'}` : 'No wins yet'}</p>
                </div>
              </td>
              <td style="padding:0 0 0 8px;width:50%;vertical-align:top;">
                <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:14px;">
                  <p style="margin:0;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;font-weight:600;">Biggest deal</p>
                  <p style="margin:4px 0 0;font-size:16px;font-weight:600;color:#111827;">${biggest ? biggest.title : '—'}</p>
                  <p style="margin:2px 0 0;font-size:13px;color:#6b7280;">${biggest ? formatMoney(biggest.value, biggest.currency || currency) : ''}</p>
                </div>
              </td>
            </tr>
          </table>

          <p style="margin:0 0 20px;font-size:14px;color:#6b7280;">
            <strong style="color:#111827;">${newContacts}</strong> new contact${newContacts === 1 ? '' : 's'} added this week.
          </p>

          <a href="${reportsUrl}" style="display:inline-block;background:#5046e4;color:#fff;text-decoration:none;padding:10px 24px;border-radius:8px;font-size:14px;font-weight:600;">View full reports</a>
        </div>

        <div style="padding:16px 32px;background:#f9fafb;border-top:1px solid #e5e7eb">
          <p style="margin:0;color:#9ca3af;font-size:12px">${process.env.APP_NAME || 'Azayon'} · Weekly digest · You can manage notifications in Settings</p>
        </div>
      </div>
    </body></html>
  `;
}

// POST /api/internal/send-weekly-digest
// Called weekly (Monday ~08:00 EAT) by cron-job.org. Sends a summary email to
// every admin of every org. Skips orgs with zero activity in the last 7 days.
router.post('/send-weekly-digest', verifyCronSecret, async (req, res, next) => {
  try {
    const orgs = await Org.find({}).select('_id name settings').lean();
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const results = { sent: 0, skipped: 0, errors: [] };

    for (const org of orgs) {
      try {
        const [wonAgg, lostCount, newContacts, repAgg, biggest] = await Promise.all([
          Deal.aggregate([
            { $match: { orgId: org._id, status: 'won', closedAt: { $gte: weekAgo } } },
            { $group: { _id: null, count: { $sum: 1 }, value: { $sum: '$value' } } },
          ]),
          Deal.countDocuments({ orgId: org._id, status: 'lost', closedAt: { $gte: weekAgo } }),
          Contact.countDocuments({ orgId: org._id, isArchived: false, createdAt: { $gte: weekAgo } }),
          Deal.aggregate([
            { $match: { orgId: org._id, status: 'won', closedAt: { $gte: weekAgo } } },
            { $group: { _id: '$assignedTo', count: { $sum: 1 }, value: { $sum: '$value' } } },
            { $sort: { value: -1 } },
            { $limit: 1 },
            { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
            { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
            { $project: { _id: 1, count: 1, value: 1, name: { $ifNull: ['$user.name', 'Unassigned'] } } },
          ]),
          Deal.findOne({ orgId: org._id, status: 'won', closedAt: { $gte: weekAgo } })
            .sort({ value: -1 })
            .select('title value currency')
            .lean(),
        ]);

        const wonStats = wonAgg[0] || { count: 0, value: 0 };

        // Quiet weeks: skip the email entirely so we're not noisy
        if (wonStats.count === 0 && lostCount === 0 && newContacts === 0) {
          results.skipped++;
          continue;
        }

        const admins = await User.find({ orgId: org._id, role: 'admin', isActive: true })
          .select('email name')
          .lean();
        if (admins.length === 0) { results.skipped++; continue; }

        for (const admin of admins) {
          if (!admin.email) continue;
          await sendEmail({
            to: admin.email,
            subject: `📊 Your week at ${org.name}`,
            html: renderDigestHtml({
              org, admin, wonStats, lostCount, newContacts,
              topRep: repAgg[0],
              biggest,
            }),
          });
          results.sent++;
        }
      } catch (err) {
        results.errors.push({ orgId: org._id, error: err.message });
      }
    }

    res.json({ ...results, message: `Sent ${results.sent} digest email${results.sent === 1 ? '' : 's'}, skipped ${results.skipped}` });
  } catch (error) {
    next(error);
  }
});

module.exports = router;