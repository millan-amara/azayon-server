const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Org = require('../models/Org');

// Protect route - verify access token
const protect = async (req, res, next) => {
  try {
    let token;

    if (req.headers.authorization?.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    } else if (req.cookies?.accessToken) {
      token = req.cookies.accessToken;
    }

    if (!token) {
      return res.status(401).json({ error: 'Not authorised, no token' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId).select('-password -refreshTokens');

    if (!user || !user.isActive) {
      return res.status(401).json({ error: 'User not found or inactive' });
    }

    req.user = user;
    req.orgId = user.orgId;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Not authorised' });
  }
};

// API key auth - for n8n and external integrations
const apiKeyAuth = async (req, res, next) => {
  const apiKey = req.headers['x-api-key'];

  if (!apiKey) {
    return res.status(401).json({ error: 'API key required' });
  }

  const org = await Org.findOne({ apiKey });
  if (!org) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  req.org = org;
  req.orgId = org._id;
  req.isApiKeyAuth = true;
  next();
};

// Role-based access
const requireRole = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authorised' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
};

// Either JWT or API key
const protectOrApiKey = async (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey) return apiKeyAuth(req, res, next);
  return protect(req, res, next);
};

// Block viewers from any write operations
const restrictViewer = (req, res, next) => {
  if (req.user?.role === 'viewer' && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    return res.status(403).json({ error: 'Viewers cannot make changes. Contact your admin to update your role.' });
  }
  next();
};

// Platform-level superadmin gate — for the founders' cross-tenant dashboard.
// Always pair with `protect` first.
const requireSuperadmin = (req, res, next) => {
  if (!req.user?.isSuperadmin) {
    return res.status(403).json({ error: 'Superadmin access required' });
  }
  next();
};

module.exports = { protect, apiKeyAuth, requireRole, protectOrApiKey, restrictViewer, requireSuperadmin };