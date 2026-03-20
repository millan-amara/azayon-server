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
// Job scheduler is initialized per-org when needed, not at startup

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
const internalRoutes = require('./routes/internal');
const aiRoutes = require('./routes/ai');
const attachmentRoutes = require('./routes/attachments');
const billingRoutes = require('./routes/billing');
const { attachPlan } = require('./middleware/plan');

const { errorHandler } = require('./middleware/error');
const { restrictViewer } = require('./middleware/auth');

const app = express();
const server = http.createServer(app);

// Socket.io
const io = new Server(server, {
  cors: {
    origin: [
      'https://app.azayon.com',
      'http://localhost:5173',
    ],
    credentials: true,
  },
});

// Make io accessible to routes
app.set('io', io);

// Connect DB
connectDB();


// Middleware
app.use(helmet());
app.use(compression());
app.use(morgan(process.env.NODE_ENV === 'development' ? 'dev' : 'combined'));
app.use(cors({
  origin: [
      'https://app.azayon.com',
      'http://localhost:5173',
  ],
  credentials: true,
}));

// Apply JSON parsing to everything EXCEPT the Paystack webhook (needs raw body for signature)
app.use((req, res, next) => {
  if (req.path === '/api/billing/webhook') return next();
  express.json({ limit: '10mb' })(req, res, next);
});
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: { error: 'Too many requests, please try again later.' },
});
app.use('/api/', limiter);

// Auth rate limit (stricter)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts, please try again later.' },
});

// Routes
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/contacts', restrictViewer, contactRoutes);
app.use('/api/deals', restrictViewer, dealRoutes);
app.use('/api/pipelines', restrictViewer, pipelineRoutes);
app.use('/api/tasks', restrictViewer, taskRoutes);
app.use('/api/automations', restrictViewer, automationRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/users', restrictViewer, userRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/internal', internalRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/attachments', attachmentRoutes);
app.use('/api/billing', billingRoutes);

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

// Socket.io connection
io.on('connection', (socket) => {
  socket.on('join_org', (orgId) => {
    socket.join(`org_${orgId}`);
  });

  socket.on('disconnect', () => {});
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT} in ${process.env.NODE_ENV} mode`);
});

module.exports = { app, io };