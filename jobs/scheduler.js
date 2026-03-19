const Bull = require('bull');
const { getRedisClient, redisConfig } = require('../config/redis');
const Deal = require('../models/Deal');
const Task = require('../models/Task');
const { triggerAutomation } = require('../automations/engine');

// Reuse a single Bull queue instance
const schedulerQueue = new Bull('scheduler', {
  createClient(type) {
    switch (type) {
      case 'client':
        return getRedisClient();
      case 'subscriber':
        // Subscriber needs its own connection but with same config
        return new (require('ioredis'))(redisConfig);
      case 'bclient':
        return new (require('ioredis'))(redisConfig);
      default:
        return getRedisClient();
    }
  },
});

// Process jobs
schedulerQueue.process('check-inactive-deals', async (job) => {
  const { orgId } = job.data;
  const threeDaysAgo = new Date();
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

  const inactiveDeals = await Deal.find({
    orgId,
    status: 'open',
    updatedAt: { $lt: threeDaysAgo },
  }).populate('assignedTo contact');

  for (const deal of inactiveDeals) {
    await triggerAutomation('deal.inactive', { deal, orgId });
  }

  return { processed: inactiveDeals.length };
});

schedulerQueue.process('check-overdue-tasks', async (job) => {
  const { orgId } = job.data;

  const overdueTasks = await Task.find({
    orgId,
    status: { $in: ['pending', 'in_progress'] },
    dueDate: { $lt: new Date() },
    reminderSent: false,
  }).populate('assignedTo contact deal');

  for (const task of overdueTasks) {
    await triggerAutomation('task.overdue', { task, orgId });
    // Mark reminder sent to avoid re-triggering
    await Task.findByIdAndUpdate(task._id, { $set: { reminderSent: true } });
  }

  return { processed: overdueTasks.length };
});

// Schedule recurring jobs per org
const scheduleOrgJobs = async (orgId) => {
  const orgStr = orgId.toString();

  // Run every 6 hours
  await schedulerQueue.add(
    'check-inactive-deals',
    { orgId: orgStr },
    {
      repeat: { cron: '0 */6 * * *' },
      jobId: `inactive-deals-${orgStr}`,
    }
  );

  // Run every hour
  await schedulerQueue.add(
    'check-overdue-tasks',
    { orgId: orgStr },
    {
      repeat: { cron: '0 * * * *' },
      jobId: `overdue-tasks-${orgStr}`,
    }
  );
};

schedulerQueue.on('completed', (job, result) => {
  if (process.env.NODE_ENV === 'development') {
    console.log(`Job ${job.name} completed:`, result);
  }
});

schedulerQueue.on('failed', (job, err) => {
  console.error(`Job ${job.name} failed:`, err.message);
});

module.exports = { schedulerQueue, scheduleOrgJobs };