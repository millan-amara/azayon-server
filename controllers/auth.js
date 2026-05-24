const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const User = require('../models/User');
const Org = require('../models/Org');
const Pipeline = require('../models/Pipeline');
const Invite = require('../models/Invite');
const { AppError } = require('../middleware/error');
const {
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendWelcomeEmail,
} = require('../utils/email');

// Single shared verifier — instantiated once at module load. Verifying an ID
// token here doesn't hit Google's network on every request: the library
// caches Google's public signing keys for us.
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// SHA-256 of a token. Used to store reset/verify tokens at rest so a DB
// snapshot can't be turned into account takeovers — the user keeps the raw
// token (sent in the email link), we only ever store the hash.
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

// Force scalar-string semantics. Even with the sanitize middleware in place,
// any handler that passes req.body fields straight into a Mongo query should
// also coerce, so a regression in one layer can't bring back operator injection.
const asString = (v) => (typeof v === 'string' ? v : '');
const asEmail = (v) => asString(v).toLowerCase().trim();

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
    const name = asString(req.body.name).trim();
    const email = asEmail(req.body.email);
    const password = asString(req.body.password);
    const orgName = asString(req.body.orgName).trim();
    const phone = asString(req.body.phone).trim();

    if (!email || !password || !name || !orgName) {
      throw new AppError('Name, email, password and organisation name are required', 400);
    }
    if (password.length < 6) {
      throw new AppError('Password must be at least 6 characters', 400);
    }

    // Block if email already exists as a user in any org
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      throw new AppError('An account with this email already exists. Please sign in or use a different email.', 409);
    }

    // Block if email has a pending invite — they should accept that instead
    const existingInvite = await Invite.findOne({ email, status: 'pending' });
    if (existingInvite) {
      throw new AppError('This email has a pending team invite. Check your inbox to accept it instead.', 409);
    }

    if (!phone) {
      throw new AppError('Phone number is required', 400);
    }

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

    // Generate email verification token (raw goes in email; SHA-256 hash stored)
    const emailVerifyTokenRaw = crypto.randomBytes(32).toString('hex');

    const user = await User.create({
      orgId: org._id,
      name,
      email,
      phone,
      password,
      role: 'admin',
      emailVerified: false,
      emailVerifyToken: hashToken(emailVerifyTokenRaw),
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
    sendVerificationEmail({ to: email, name, token: emailVerifyTokenRaw }).catch((err) => {
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

// Pre-computed throwaway bcrypt hash (cost 12) used in the no-user path of
// login so a non-existent email costs the same wall-clock time as an existing
// one. Without this, response time leaks which addresses are registered.
const DUMMY_BCRYPT_HASH = '$2a$12$' + 'C'.repeat(53);

// POST /api/auth/login
const login = async (req, res, next) => {
  try {
    const email = asEmail(req.body.email);
    const password = asString(req.body.password);

    if (!email || !password) {
      throw new AppError('Invalid email or password', 401);
    }

    const user = await User.findOne({ email }).select('+password +refreshTokens');
    // Always run bcrypt — if the user doesn't exist, compare against a dummy
    // hash so timing-side-channel can't enumerate registered addresses.
    let passwordOk = false;
    if (user) {
      passwordOk = await user.comparePassword(password);
    } else {
      await bcrypt.compare(password, DUMMY_BCRYPT_HASH).catch(() => false);
    }
    if (!user || !passwordOk) {
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

// Seed a brand-new org the way /register does: trial subscription, default
// pipeline, and a couple of safe automations. Shared by the Google sign-up
// path so Google users land on the same starting experience as email/password
// signups. Keep this in sync with the equivalent block in `register`.
const seedNewOrgForUser = async ({ orgName, user }) => {
  await Pipeline.createDefault(user.orgId, user._id);
  const Automation = require('../models/Automation');
  const TEMPLATES = require('../automations/templates');
  const defaultTemplateIds = ['follow_up_cold_deal', 'overdue_task_email'];
  await Automation.insertMany(
    TEMPLATES
      .filter((t) => defaultTemplateIds.includes(t.id))
      .map((t) => ({
        orgId: user.orgId,
        name: t.name,
        description: t.description,
        isActive: true,
        trigger: t.trigger,
        conditions: t.conditions,
        actions: t.actions,
        createdBy: user._id,
      }))
  );
  // orgName param is kept for future use (e.g. logging) — the Org itself is
  // already created and named by the caller before this runs.
  return orgName;
};

// POST /api/auth/google
//
// Single endpoint that handles sign-in AND sign-up via a Google Identity
// Services ID token (the JWT the browser receives from Google after the user
// clicks the Google button). Resolution order:
//   1. Existing user with this googleId  → sign them in.
//   2. Existing user with this email     → link Google to that account, sign them in.
//   3. Pending Invite for this email     → create user in inviter's org (mirrors /accept-invite).
//   4. Brand-new email                   → create a new Org + admin user (mirrors /register).
const googleAuth = async (req, res, next) => {
  try {
    const credential = asString(req.body.credential);
    if (!credential) throw new AppError('Missing Google credential', 400);
    if (!process.env.GOOGLE_CLIENT_ID) {
      throw new AppError('Google sign-in is not configured on this server', 500);
    }

    // Verify the token's signature, audience, and expiry against Google's
    // published keys. Any failure here means we can't trust the payload.
    let payload;
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken: credential,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      payload = ticket.getPayload();
    } catch {
      throw new AppError('Invalid Google credential', 401);
    }

    const googleId = asString(payload?.sub);
    const email = asEmail(payload?.email);
    const emailVerified = payload?.email_verified === true;
    const fullName = asString(payload?.name || payload?.given_name || '').trim();
    const avatar = asString(payload?.picture || '');

    if (!googleId || !email) {
      throw new AppError('Google account is missing required fields', 400);
    }
    // Google itself flagged the email as unverified — almost never happens for
    // standard consumer accounts but worth guarding against (a workspace admin
    // could in theory pre-create unverified aliases).
    if (!emailVerified) {
      throw new AppError('Your Google email is not verified. Please verify it with Google and try again.', 401);
    }

    // 1) Fast path: stable Google id match.
    let user = await User.findOne({ googleId }).select('+refreshTokens');

    // 2) Else look up by email and link this Google identity to the account.
    if (!user) {
      user = await User.findOne({ email }).select('+refreshTokens');
      if (user) {
        user.googleId = googleId;
        user.emailVerified = true;
        // authProvider stays 'local' because they have a password — they can
        // sign in either way going forward.
        if (!user.avatar && avatar) user.avatar = avatar;
      }
    }

    let org;
    if (user) {
      if (!user.isActive) throw new AppError('Account is deactivated', 403);
      org = await Org.findById(user.orgId);
    } else {
      // 3) No user yet — honour any pending invite for this email so the
      // new account joins the inviter's org instead of creating a fresh one.
      const invite = await Invite.findOne({
        email,
        status: 'pending',
        expiresAt: { $gt: new Date() },
      });

      if (invite) {
        org = await Org.findById(invite.orgId);
        if (!org) throw new AppError('Invitation organisation not found', 400);
        // Mirror /api/users/accept-invite seat-limit enforcement so a Google
        // accept can't bypass it.
        const limits = org.getPlanLimits();
        const activeUserCount = await User.countDocuments({
          orgId: invite.orgId,
          isActive: { $ne: false },
        });
        if (activeUserCount >= limits.maxUsers) {
          throw new AppError(
            `This team has reached its ${limits.maxUsers}-user limit. Please ask an administrator to upgrade the plan or remove an existing teammate before accepting this invite.`,
            403
          );
        }
        user = await User.create({
          orgId: org._id,
          name: fullName || invite.name || email.split('@')[0],
          email,
          googleId,
          authProvider: 'google',
          role: invite.role || 'sales_rep',
          emailVerified: true,
          avatar,
        });
        invite.status = 'accepted';
        await invite.save();
      } else {
        // 4) Brand-new signup: spin up a personal org. No phone collected on
        // this path (Google doesn't return one) — users can add it later in
        // Settings; this is the deliberate trade-off for one-click sign-up.
        const trialEndsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        const orgName = fullName ? `${fullName}'s Workspace` : 'My Workspace';
        org = await Org.create({
          name: orgName,
          createdBy: null,
          subscription: { plan: 'free', status: 'trialing', trialEndsAt },
        });
        user = await User.create({
          orgId: org._id,
          name: fullName || email.split('@')[0],
          email,
          googleId,
          authProvider: 'google',
          role: 'admin',
          emailVerified: true,
          avatar,
        });
        org.createdBy = user._id;
        await org.save();
        await seedNewOrgForUser({ orgName, user });
      }
    }

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
    const token = asString(req.cookies?.refreshToken || req.body.refreshToken);
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
    const token = asString(req.query.token);
    if (!token) throw new AppError('Verification token required', 400);

    // Stored as SHA-256 hash; lookup by the hash of the supplied raw token.
    const user = await User.findOne({
      emailVerifyToken: hashToken(token),
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
    const email = asEmail(req.body.email);
    const generic = { message: 'If that email exists, a verification link has been sent.' };
    if (!email) return res.json(generic);

    const user = await User.findOne({ email });

    // Always return success to prevent email enumeration
    if (!user || user.emailVerified) return res.json(generic);

    const tokenRaw = crypto.randomBytes(32).toString('hex');
    user.emailVerifyToken = hashToken(tokenRaw);
    user.emailVerifyExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await user.save();

    sendVerificationEmail({ to: email, name: user.name, token: tokenRaw }).catch(() => {});

    res.json(generic);
  } catch (error) {
    next(error);
  }
};

// POST /api/auth/forgot-password
const forgotPassword = async (req, res, next) => {
  try {
    const email = asEmail(req.body.email);
    const generic = { message: 'If that email is registered, a reset link has been sent.' };
    if (!email) return res.json(generic);

    const user = await User.findOne({ email });

    // Always return success to prevent email enumeration
    if (!user) return res.json(generic);

    const resetTokenRaw = crypto.randomBytes(32).toString('hex');
    user.passwordResetToken = hashToken(resetTokenRaw);
    user.passwordResetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await user.save();

    sendPasswordResetEmail({ to: email, name: user.name, token: resetTokenRaw }).catch((err) => {
      console.error('Failed to send reset email:', err.message);
    });

    res.json(generic);
  } catch (error) {
    next(error);
  }
};

// POST /api/auth/reset-password
const resetPassword = async (req, res, next) => {
  try {
    const token = asString(req.body.token);
    const password = asString(req.body.password);

    if (!token) throw new AppError('Reset token required', 400);
    if (!password || password.length < 6) throw new AppError('Password must be at least 6 characters', 400);

    const user = await User.findOne({
      passwordResetToken: hashToken(token),
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
  register, login, googleAuth, refresh, logout, getMe,
  verifyEmail, resendVerification,
  forgotPassword, resetPassword,
};