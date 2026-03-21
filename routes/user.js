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
    const { token, password } = req.body;
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
    const { name, email, role = 'sales_rep' } = req.body;

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
    const { currentPassword, newPassword } = req.body;
    const user = await User.findById(req.user._id).select('+password');
    if (!(await user.comparePassword(currentPassword))) {
      throw new AppError('Current password is incorrect', 400);
    }
    user.password = newPassword;
    await user.save();
    res.json({ message: 'Password updated' });
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

    const user = await User.findOneAndUpdate(
      { _id: req.params.id, orgId: req.orgId },
      { $set: updates },
      { new: true }
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