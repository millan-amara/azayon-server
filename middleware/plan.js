const Org = require('../models/Org');
const Contact = require('../models/Contact');
const Deal = require('../models/Deal');
const { AppError } = require('./error');

// Attaches org + plan info to req — called after protect middleware
const attachPlan = async (req, res, next) => {
  try {
    if (!req.orgId) return next();

    const org = await Org.findById(req.orgId);
    if (!org) return next(new AppError('Organisation not found', 404));

    req.org = org;
    req.planLimits = org.getPlanLimits();
    next();
  } catch (err) {
    next(err);
  }
};

// Check if a feature is available on the current plan
const requireFeature = (feature) => (req, res, next) => {
  const limits = req.planLimits;
  if (!limits) return next();

  if (!limits.features.includes(feature)) {
    return res.status(403).json({
      error: 'plan_limit',
      feature,
      message: `${feature} is not available on your current plan`,
      upgrade: true,
    });
  }
  next();
};

// Check contact count limit before creation
const checkContactLimit = async (req, res, next) => {
  try {
    const limits = req.planLimits;
    if (!limits || limits.maxContacts >= 999999) return next();

    const count = await Contact.countDocuments({ orgId: req.orgId });
    if (count >= limits.maxContacts) {
      return res.status(403).json({
        error: 'plan_limit',
        feature: 'contacts',
        current: count,
        limit: limits.maxContacts,
        message: `You've reached the ${limits.maxContacts} contact limit on the Free plan`,
        upgrade: true,
      });
    }
    // Warn at 80%
    req.contactUsage = { count, limit: limits.maxContacts, nearLimit: count >= limits.maxContacts * 0.8 };
    next();
  } catch (err) {
    next(err);
  }
};

// Check deal count limit before creation
const checkDealLimit = async (req, res, next) => {
  try {
    const limits = req.planLimits;
    if (!limits || limits.maxDeals >= 999999) return next();

    const count = await Deal.countDocuments({ orgId: req.orgId, status: 'open' });
    if (count >= limits.maxDeals) {
      return res.status(403).json({
        error: 'plan_limit',
        feature: 'deals',
        current: count,
        limit: limits.maxDeals,
        message: `You've reached the ${limits.maxDeals} deal limit on the Free plan`,
        upgrade: true,
      });
    }
    req.dealUsage = { count, limit: limits.maxDeals, nearLimit: count >= limits.maxDeals * 0.8 };
    next();
  } catch (err) {
    next(err);
  }
};

module.exports = { attachPlan, requireFeature, checkContactLimit, checkDealLimit };