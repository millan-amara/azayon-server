const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Org = require('../models/Org');
const Invite = require('../models/Invite');
const { AppError } = require('../middleware/error');
const { protect, requireRole } = require('../middleware/auth');
const { sendInviteEmail } = require('../utils/email');
const crypto = require('crypto');

// POST /api/users/accept-invite — public, no auth required
router.post('/accept-invite', async (req, res, next) => {
  try {
    const token = typeof req.body.token === 'string' ? req.body.token : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    if (!token) throw new AppError('Invite token required', 400);
    if (!password || password.length < 6) throw new AppError('Password must be at least 6 characters', 400);

    const invite = await Invite.findOne({ token, status: 'pending' });
    if (!invite) throw new AppError('Invalid or expired invite link', 400);
    if (invite.expiresAt < new Date()) throw new AppError('This invite link has expired', 400);

    const existing = await User.findOne({ email: invite.email, orgId: invite.orgId });
    if (existing) throw new AppError('An account with this email already exists', 409);

    await User.create({
      orgId: invite.orgId,
      name: invite.name,
      email: invite.email,
      password,
      role: invite.role,
      isActive: true,
      emailVerified: true,
    });

    invite.status = 'accepted';
    await invite.save();

    res.json({ message: 'Account created successfully. You can now log in.' });
  } catch (error) { next(error); }
});

// All routes below require authentication
router.use(protect);

// GET /api/users
router.get('/', async (req, res, next) => {
  try {
    const users = await User.find({ orgId: req.orgId })
      .select('name email role phone avatar lastLogin createdAt isActive')
      .lean();
    const normalized = users.map((u) => ({ ...u, isActive: u.isActive !== false }));
    res.json({ users: normalized });
  } catch (error) { next(error); }
});

// GET /api/users/invites/pending
router.get('/invites/pending', requireRole('admin'), async (req, res, next) => {
  try {
    const invites = await Invite.find({ orgId: req.orgId, status: 'pending' })
      .populate('invitedBy', 'name email')
      .sort({ createdAt: -1 })
      .lean();
    const now = new Date();
    const normalized = invites.map((i) => ({ ...i, isExpired: i.expiresAt < now }));
    res.json({ invites: normalized });
  } catch (error) { next(error); }
});

// POST /api/users/invite
router.post('/invite', requireRole('admin'), async (req, res, next) => {
  try {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const email = typeof req.body.email === 'string' ? req.body.email.toLowerCase().trim() : '';
    const requestedRole = typeof req.body.role === 'string' ? req.body.role : 'sales_rep';
    // Whitelist roles — never trust an arbitrary string into Mongo, since
    // a role like '__proto__' or an unexpected value could have downstream effects.
    const role = ['admin', 'sales_rep', 'viewer'].includes(requestedRole) ? requestedRole : 'sales_rep';

    if (!name || !email) throw new AppError('Name and email are required', 400);

    const existingUser = await User.findOne({ email, orgId: req.orgId });
    if (existingUser) throw new AppError('This email is already a team member', 409);

    const existingInvite = await Invite.findOne({ email, orgId: req.orgId, status: 'pending' });
    if (existingInvite && existingInvite.expiresAt > new Date()) {
      throw new AppError('A pending invite already exists for this email', 409);
    }

    const token = crypto.randomBytes(32).toString('hex');
    const invite = await Invite.create({
      orgId: req.orgId,
      email,
      name,
      role,
      token,
      invitedBy: req.user._id,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    const org = await Org.findById(req.orgId);
    const inviteLink = `${process.env.CLIENT_URL}/accept-invite?token=${token}`;

    await sendInviteEmail({
      to: email,
      name,
      inviterName: req.user.name,
      orgName: org?.name || 'your team',
      inviteLink,
    });

    res.status(201).json({
      invite: { _id: invite._id, email, name, role },
      message: `Invitation sent to ${email}`,
    });
  } catch (error) { next(error); }
});

// DELETE /api/users/invites/:id - cancel invite
router.delete('/invites/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const invite = await Invite.findOneAndDelete({ _id: req.params.id, orgId: req.orgId });
    if (!invite) throw new AppError('Invite not found', 404);
    res.json({ message: 'Invite cancelled' });
  } catch (error) { next(error); }
});

// PUT /api/users/me/password
router.put('/me/password', async (req, res, next) => {
  try {
    const currentPassword = typeof req.body.currentPassword === 'string' ? req.body.currentPassword : '';
    const newPassword = typeof req.body.newPassword === 'string' ? req.body.newPassword : '';

    if (!newPassword || newPassword.length < 6) {
      throw new AppError('New password must be at least 6 characters', 400);
    }
    if (currentPassword === newPassword) {
      throw new AppError('New password must be different from your current password', 400);
    }

    const user = await User.findById(req.user._id).select('+password +refreshTokens');
    if (!user || !(await user.comparePassword(currentPassword))) {
      throw new AppError('Current password is incorrect', 400);
    }
    user.password = newPassword;
    // Force every other session to re-authenticate after a password change.
    user.refreshTokens = [];
    await user.save();
    res.json({ message: 'Password updated. You have been signed out of other sessions.' });
  } catch (error) { next(error); }
});

// PUT /api/users/:id - update user (admin or self)
router.put('/:id', async (req, res, next) => {
  try {
    const isSelf = req.params.id === req.user._id.toString();
    const isAdmin = req.user.role === 'admin';
    if (!isSelf && !isAdmin) throw new AppError('Forbidden', 403);

    const allowed = isSelf
      ? ['name', 'phone', 'avatar']
      : ['name', 'phone', 'avatar', 'role', 'isActive'];

    const updates = {};
    allowed.forEach((f) => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });

    // Validate role explicitly — schema enum isn't enforced on findOneAndUpdate
    // unless we ask, and we'd rather fail fast with a clear error than rely
    // on a runValidators stack trace.
    if (updates.role !== undefined && !['admin', 'sales_rep', 'viewer'].includes(updates.role)) {
      throw new AppError('Invalid role', 400);
    }
    if (updates.isActive !== undefined) updates.isActive = Boolean(updates.isActive);

    const user = await User.findOneAndUpdate(
      { _id: req.params.id, orgId: req.orgId },
      { $set: updates },
      { new: true, runValidators: true }
    );
    if (!user) throw new AppError('User not found', 404);
    res.json({ user });
  } catch (error) { next(error); }
});

// PATCH /api/users/:id/deactivate - admin only
router.patch('/:id/deactivate', requireRole('admin'), async (req, res, next) => {
  try {
    if (req.params.id === req.user._id.toString()) {
      throw new AppError('You cannot deactivate yourself', 400);
    }
    const user = await User.findOneAndUpdate(
      { _id: req.params.id, orgId: req.orgId },
      { $set: { isActive: false } },
      { new: true }
    );
    if (!user) throw new AppError('User not found', 404);
    res.json({ message: 'Team member deactivated' });
  } catch (error) { next(error); }
});

// PATCH /api/users/:id/reactivate - admin only
router.patch('/:id/reactivate', requireRole('admin'), async (req, res, next) => {
  try {
    const user = await User.findOneAndUpdate(
      { _id: req.params.id, orgId: req.orgId },
      { $set: { isActive: true } },
      { new: true }
    );
    if (!user) throw new AppError('User not found', 404);
    res.json({ message: 'Team member reactivated', user });
  } catch (error) { next(error); }
});

// DELETE /api/users/:id - legacy deactivate
router.delete('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    if (req.params.id === req.user._id.toString()) {
      throw new AppError('You cannot remove yourself', 400);
    }
    const user = await User.findOneAndUpdate(
      { _id: req.params.id, orgId: req.orgId },
      { $set: { isActive: false } },
      { new: true }
    );
    if (!user) throw new AppError('User not found', 404);
    res.json({ message: 'Team member deactivated' });
  } catch (error) { next(error); }
});

module.exports = router;