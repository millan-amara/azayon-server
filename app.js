require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const connectDB = require('./config/db');
// Scheduled work (reminders, inactive deals, overdue tasks) is driven by
// cron-job.org calling /api/internal/* every 15 min and hourly.

// Routes
const authRoutes = require('./routes/auth');
const contactRoutes = require('./routes/contact');
const dealRoutes = require('./routes/deal');
const pipelineRoutes = require('./routes/pipeline');
const taskRoutes = require('./routes/task');
const automationRoutes = require('./routes/automation');
const notificationRoutes = require('./routes/notification');
const webhookRoutes = require('./routes/webhook');
const dashboardRoutes = require('./routes/dashboard');
const userRoutes = require('./routes/user');
const orgRoutes = require('./routes/org');
const searchRoutes = require('./routes/search');
const internalRoutes = require('./routes/internal');
const aiRoutes = require('./routes/ai');
const attachmentRoutes = require('./routes/attachments');
const billingRoutes = require('./routes/billing');
const documentRoutes = require('./routes/document');
const publicRoutes = require('./routes/public');
const emailTemplateRoutes = require('./routes/emailTemplate');
const customFieldRoutes = require('./routes/customField');
const reportsRoutes = require('./routes/reports');
const customerRoutes = require('./routes/customer');
const savedViewRoutes = require('./routes/savedView');
const paymentsRoutes = require('./routes/payments');
const superadminRoutes = require('./routes/superadmin');
const { attachPlan } = require('./middleware/plan');

const { errorHandler } = require('./middleware/error');
const { restrictViewer } = require('./middleware/auth');
const { sanitizeRequest } = require('./middleware/sanitize');
const { attachSocketAuth } = require('./middleware/socketAuth');

const app = express();
const server = http.createServer(app);

// Socket.io
const io = new Server(server, {
  cors: {
    origin: [
      'https://app.azayon.com',
      'https://azayon-crm-client.netlify.app',
      'http://localhost:5173',
    ],
    credentials: true,
  },
});

// Make io accessible to routes
app.set('io', io);

// Connect DB
connectDB();

app.set('trust proxy', 1);

// Middleware
app.use(helmet());
app.use(compression());
app.use(morgan(process.env.NODE_ENV === 'development' ? 'dev' : 'combined'));
app.use(cors({
  origin: [
      'https://app.azayon.com',
      'https://azayon-crm-client.netlify.app',
      'http://localhost:5173',
  ],
  credentials: true,
  exposedHeaders: ['Content-Disposition'],
}));

app.use('/api/billing/webhook', express.raw({ type: '*/*' }));

// Apply JSON parsing to everything EXCEPT the Paystack webhook (needs raw body for signature)
app.use((req, res, next) => {
  if (req.path === '/api/billing/webhook') return next();
  express.json({ limit: '10mb' })(req, res, next);
});
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Strip Mongo operator keys ($-prefixed, dotted) from incoming payloads to
// block NoSQL operator injection (e.g. {email:{$gt:""}} bypassing /login).
// Runs after body parsing, before any route handler.
app.use((req, res, next) => {
  if (req.path === '/api/billing/webhook') return next();
  sanitizeRequest(req, res, next);
});

// Rate limiting — guards the API against abusive bursts. Skips
// /api/auth/refresh: the client refreshes silently every ~15 min during
// normal use, and counting those toward the bucket caused random
// forced-logouts when the limit hit (refresh 429 → interceptor logs out).
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500,
  message: { error: 'Too many requests, please try again later.' },
  // req.path is mount-relative inside this middleware (Express strips
  // /api/), so use req.originalUrl which always has the full path.
  skip: (req) => req.originalUrl.split('?')[0] === '/api/auth/refresh',
});
app.use('/api/', limiter);

// Auth rate limit (stricter) — guards credential-using endpoints (login,
// register, verify, etc.) against brute force / credential stuffing.
// Excludes /refresh: callers already hold a valid HTTP-only refresh cookie,
// so it's not a credential-stuffing vector, and rate-limiting it caused
// silent forced-logouts during normal long sessions (15-min access tokens
// → frequent refreshes → bucket exhausted → refresh 429 → client logs out).
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts, please try again later.' },
  skip: (req) => req.path === '/refresh',
});

// Even stricter limit on password-reset / verification endpoints — these
// generate emails and DB writes per request and are the natural target of
// account-enumeration / mailbomb attacks.
const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1h
  max: 5,
  message: { error: 'Too many password reset attempts, please try again later.' },
});

// Routes
app.use('/api/auth/forgot-password', passwordResetLimiter);
app.use('/api/auth/reset-password', passwordResetLimiter);
app.use('/api/auth/resend-verification', passwordResetLimiter);
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/contacts', restrictViewer, contactRoutes);
app.use('/api/deals', restrictViewer, dealRoutes);
app.use('/api/pipelines', restrictViewer, pipelineRoutes);
app.use('/api/tasks', restrictViewer, taskRoutes);
app.use('/api/automations', restrictViewer, automationRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/users', restrictViewer, userRoutes);
app.use('/api/orgs', restrictViewer, orgRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/internal', internalRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/attachments', attachmentRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/documents', restrictViewer, documentRoutes);
app.use('/api/email-templates', restrictViewer, emailTemplateRoutes);
app.use('/api/custom-fields', restrictViewer, customFieldRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/saved-views', savedViewRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/superadmin', superadminRoutes);
app.use('/api/public', publicRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 404
app.use('*path', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Error handler
app.use(errorHandler);

// Socket.io: authenticate on handshake (rejects unauthenticated connections),
// then auto-join the user's own org room. We ignore client-supplied orgIds
// so a logged-in user can't subscribe to a *different* org's events.
attachSocketAuth(io);
io.on('connection', (socket) => {
  if (socket.user?.orgId) {
    socket.join(`org_${socket.user.orgId}`);
  }
  // Kept for backwards compatibility but only honoured for the user's own org
  socket.on('join_org', (orgId) => {
    if (orgId && socket.user?.orgId && String(orgId) === socket.user.orgId) {
      socket.join(`org_${socket.user.orgId}`);
    }
  });

  socket.on('disconnect', () => {});
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT} in ${process.env.NODE_ENV} mode`);
});

module.exports = { app, io };