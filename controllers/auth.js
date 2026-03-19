const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const User = require('../models/User');
const Org = require('../models/Org');
const Pipeline = require('../models/Pipeline');
const { AppError } = require('../middleware/error');
const {
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendWelcomeEmail,
} = require('../utils/email');

const generateTokens = (userId) => {
  const accessToken = jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '15m',
  });
  const refreshToken = jwt.sign({ userId }, process.env.JWT_REFRESH_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  });
  return { accessToken, refreshToken };
};

const setTokenCookies = (res, accessToken, refreshToken) => {
  res.cookie('accessToken', accessToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 15 * 60 * 1000,
  });
  res.cookie('refreshToken', refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
};

// POST /api/auth/register
const register = async (req, res, next) => {
  try {
    const { name, email, password, orgName } = req.body;

    const trialEndsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const org = await Org.create({
      name: orgName,
      createdBy: null,
      subscription: {
        plan: 'free',
        status: 'trialing',
        trialEndsAt,
      },
    });

    // Generate email verification token
    const emailVerifyToken = crypto.randomBytes(32).toString('hex');

    const user = await User.create({
      orgId: org._id,
      name,
      email,
      password,
      role: 'admin',
      emailVerified: false,
      emailVerifyToken,
      emailVerifyExpires: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h
    });

    org.createdBy = user._id;
    await org.save();

    await Pipeline.createDefault(org._id, user._id);

    // Seed safe default automations (no SMTP or webhook required)
    const Automation = require('../models/Automation');
    const TEMPLATES = require('../automations/templates');
    const defaultTemplateIds = ['follow_up_cold_deal', 'overdue_task_email'];
    await Automation.insertMany(
      TEMPLATES
        .filter((t) => defaultTemplateIds.includes(t.id))
        .map((t) => ({
          orgId: org._id,
          name: t.name,
          description: t.description,
          isActive: true,
          trigger: t.trigger,
          conditions: t.conditions,
          actions: t.actions,
          createdBy: user._id,
        }))
    );

    // Send verification email (non-blocking — don't fail registration if email fails)
    sendVerificationEmail({ to: email, name, token: emailVerifyToken }).catch((err) => {
      console.error('Failed to send verification email:', err.message);
    });

    const { accessToken, refreshToken } = generateTokens(user._id);
    const hashedRefresh = await bcrypt.hash(refreshToken, 8);
    user.refreshTokens = [hashedRefresh];
    user.lastLogin = new Date();
    await user.save();

    setTokenCookies(res, accessToken, refreshToken);

    res.status(201).json({ user, org, accessToken });
  } catch (error) {
    next(error);
  }
};

// POST /api/auth/login
const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email }).select('+password +refreshTokens');
    if (!user || !(await user.comparePassword(password))) {
      throw new AppError('Invalid email or password', 401);
    }
    if (!user.isActive) throw new AppError('Account is deactivated', 403);

    const org = await Org.findById(user.orgId);
    const { accessToken, refreshToken } = generateTokens(user._id);
    const hashedRefresh = await bcrypt.hash(refreshToken, 8);
    user.refreshTokens = [...(user.refreshTokens || []).slice(-4), hashedRefresh];
    user.lastLogin = new Date();
    await user.save();

    setTokenCookies(res, accessToken, refreshToken);
    res.json({ user, org, accessToken });
  } catch (error) {
    next(error);
  }
};

// POST /api/auth/refresh
const refresh = async (req, res, next) => {
  try {
    const token = req.cookies?.refreshToken || req.body.refreshToken;
    if (!token) throw new AppError('No refresh token', 401);

    const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
    const user = await User.findById(decoded.userId).select('+refreshTokens');
    if (!user) throw new AppError('User not found', 401);

    let validToken = false;
    for (const stored of user.refreshTokens || []) {
      if (await bcrypt.compare(token, stored)) { validToken = true; break; }
    }
    if (!validToken) throw new AppError('Invalid refresh token', 401);

    const { accessToken, refreshToken: newRefreshToken } = generateTokens(user._id);
    const hashedNew = await bcrypt.hash(newRefreshToken, 8);
    user.refreshTokens = [...(user.refreshTokens || []).slice(-4), hashedNew];
    await user.save();

    setTokenCookies(res, accessToken, newRefreshToken);
    res.json({ accessToken });
  } catch (error) {
    next(error);
  }
};

// POST /api/auth/logout
const logout = async (req, res, next) => {
  try {
    const token = req.cookies?.refreshToken;
    if (token && req.user) {
      const user = await User.findById(req.user._id).select('+refreshTokens');
      if (user) {
        const remaining = [];
        for (const stored of user.refreshTokens || []) {
          if (!(await bcrypt.compare(token, stored))) remaining.push(stored);
        }
        user.refreshTokens = remaining;
        await user.save();
      }
    }
    res.clearCookie('accessToken');
    res.clearCookie('refreshToken');
    res.json({ message: 'Logged out' });
  } catch (error) {
    next(error);
  }
};

// GET /api/auth/me
const getMe = async (req, res, next) => {
  try {
    const org = await Org.findById(req.user.orgId);
    res.json({ user: req.user, org });
  } catch (error) {
    next(error);
  }
};

// GET /api/auth/verify-email?token=xxx
const verifyEmail = async (req, res, next) => {
  try {
    const { token } = req.query;
    if (!token) throw new AppError('Verification token required', 400);

    const user = await User.findOne({
      emailVerifyToken: token,
      emailVerifyExpires: { $gt: new Date() },
    });

    if (!user) throw new AppError('Invalid or expired verification link', 400);

    user.emailVerified = true;
    user.emailVerifyToken = undefined;
    user.emailVerifyExpires = undefined;
    await user.save();

    // Send welcome email after verification
    const org = await Org.findById(user.orgId);
    sendWelcomeEmail({ to: user.email, name: user.name, orgName: org?.name }).catch(() => {});

    res.json({ message: 'Email verified successfully. You can now log in.' });
  } catch (error) {
    next(error);
  }
};

// POST /api/auth/resend-verification
const resendVerification = async (req, res, next) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email });

    // Always return success to prevent email enumeration
    if (!user || user.emailVerified) {
      return res.json({ message: 'If that email exists, a verification link has been sent.' });
    }

    const emailVerifyToken = crypto.randomBytes(32).toString('hex');
    user.emailVerifyToken = emailVerifyToken;
    user.emailVerifyExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await user.save();

    sendVerificationEmail({ to: email, name: user.name, token: emailVerifyToken }).catch(() => {});

    res.json({ message: 'If that email exists, a verification link has been sent.' });
  } catch (error) {
    next(error);
  }
};

// POST /api/auth/forgot-password
const forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email });

    // Always return success to prevent email enumeration
    if (!user) {
      return res.json({ message: 'If that email is registered, a reset link has been sent.' });
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    user.passwordResetToken = resetToken;
    user.passwordResetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await user.save();

    sendPasswordResetEmail({ to: email, name: user.name, token: resetToken }).catch((err) => {
      console.error('Failed to send reset email:', err.message);
    });

    res.json({ message: 'If that email is registered, a reset link has been sent.' });
  } catch (error) {
    next(error);
  }
};

// POST /api/auth/reset-password
const resetPassword = async (req, res, next) => {
  try {
    const { token, password } = req.body;

    if (!token) throw new AppError('Reset token required', 400);
    if (!password || password.length < 6) throw new AppError('Password must be at least 6 characters', 400);

    const user = await User.findOne({
      passwordResetToken: token,
      passwordResetExpires: { $gt: new Date() },
    });

    if (!user) throw new AppError('Invalid or expired reset link', 400);

    user.password = password;
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    user.refreshTokens = []; // invalidate all existing sessions
    await user.save();

    res.json({ message: 'Password reset successfully. You can now log in.' });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  register, login, refresh, logout, getMe,
  verifyEmail, resendVerification,
  forgotPassword, resetPassword,
};