const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Org', required: true, index: true },
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, lowercase: true, trim: true },
  password: { type: String, required: true, minlength: 6 },
  role: { type: String, enum: ['admin', 'sales_rep', 'viewer'], default: 'sales_rep' },
  // Platform-level flag — orthogonal to org `role`. Grants access to /api/superadmin/*
  // for the founders' cross-tenant dashboard. Never set this through the UI.
  isSuperadmin: { type: Boolean, default: false },
  phone: { type: String, trim: true },
  avatar: { type: String },
  isActive: { type: Boolean, default: true },
  lastLogin: { type: Date },
  refreshTokens: [{ type: String }], // store hashed refresh tokens
  inviteToken: { type: String },
  inviteExpires: { type: Date },
  emailVerified: { type: Boolean, default: false },
  emailVerifyToken: { type: String },
  emailVerifyExpires: { type: Date },
  passwordResetToken: { type: String },
  passwordResetExpires: { type: Date },
}, { timestamps: true });

// Compound unique index - email unique per org
userSchema.index({ email: 1, orgId: 1 }, { unique: true });

// Hash password before save
userSchema.pre('save', async function () {
  if (!this.isModified('password')) return;
  this.password = await bcrypt.hash(this.password, 12);
});

// Compare password
userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

// Remove sensitive fields when converting to JSON. Reset / verify tokens are
// scrubbed too — they're stored as SHA-256 hashes rather than raw values, but
// even the hash should never leave the server (it's the only thing needed to
// claim the corresponding email link).
userSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.refreshTokens;
  delete obj.inviteToken;
  delete obj.passwordResetToken;
  delete obj.passwordResetExpires;
  delete obj.emailVerifyToken;
  delete obj.emailVerifyExpires;
  return obj;
};

module.exports = mongoose.model('User', userSchema);