const express = require('express');
const router = express.Router();
const {
  register, login, googleAuth, refresh, logout, getMe,
  verifyEmail, resendVerification,
  forgotPassword, resetPassword,
} = require('../controllers/auth');
const { protect } = require('../middleware/auth');

router.post('/register', register);
router.post('/login', login);
router.post('/google', googleAuth);
router.post('/refresh', refresh);
router.post('/logout', protect, logout);
router.get('/me', protect, getMe);

// Email verification
router.get('/verify-email', verifyEmail);
router.post('/resend-verification', resendVerification);

// Password reset
router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);

module.exports = router;