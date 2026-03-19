const express = require('express');
const router = express.Router();
const Notification = require('../models/Notification');
const { protect } = require('../middleware/auth');

// Helper - called internally from other controllers
const createNotification = async ({ orgId, userId, type, title, message, resourceType, resourceId, io }) => {
  try {
    const notification = await Notification.create({
      orgId, userId, type, title, message, resourceType, resourceId,
    });

    // Emit real-time via socket.io
    if (io) {
      io.to(`org_${orgId}`).emit('notification', {
        notification,
        userId: userId.toString(),
      });
    }

    return notification;
  } catch (err) {
    console.error('Failed to create notification:', err.message);
  }
};

router.use(protect);

// GET /api/notifications
router.get('/', async (req, res, next) => {
  try {
    const { page = 1, limit = 20, unreadOnly } = req.query;
    const filter = { userId: req.user._id };
    if (unreadOnly === 'true') filter.isRead = false;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Two queries instead of three — get page + unread count together
    const [notifications, unreadCount] = await Promise.all([
      Notification.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Notification.countDocuments({ userId: req.user._id, isRead: false }),
    ]);

    res.json({ notifications, unreadCount });
  } catch (error) { next(error); }
});

// PUT /api/notifications/read-all
router.put('/read-all', async (req, res, next) => {
  try {
    await Notification.updateMany(
      { userId: req.user._id, isRead: false },
      { $set: { isRead: true, readAt: new Date() } }
    );
    res.json({ message: 'All notifications marked as read' });
  } catch (error) { next(error); }
});

// PUT /api/notifications/:id/read
router.put('/:id/read', async (req, res, next) => {
  try {
    await Notification.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      { $set: { isRead: true, readAt: new Date() } }
    );
    res.json({ message: 'Notification marked as read' });
  } catch (error) { next(error); }
});

module.exports = router;
module.exports.createNotification = createNotification;