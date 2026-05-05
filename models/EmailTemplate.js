const mongoose = require('mongoose');

// Reusable email/message templates with simple {{placeholder}} substitution.
// Categories let the UI surface relevant templates for the current context
// (e.g. only "invoice" templates when sending an invoice).
const emailTemplateSchema = new mongoose.Schema({
  orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Org', required: true, index: true },

  name:     { type: String, required: true, trim: true },
  category: {
    type: String,
    enum: ['invoice', 'quote', 'follow_up', 'thank_you', 'general'],
    default: 'general',
    index: true,
  },

  subject:  { type: String, default: '' },
  body:     { type: String, required: true }, // plain text or HTML — caller decides

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

emailTemplateSchema.index({ orgId: 1, category: 1 });

// Replace {{key}} (or {{ key }}) in `text` with values from `vars`.
// Unknown keys are left as-is so the user notices them.
emailTemplateSchema.statics.fillPlaceholders = function (text, vars = {}) {
  if (!text) return text;
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key) => {
    const parts = key.split('.');
    let value = vars;
    for (const p of parts) {
      if (value == null) return match;
      value = value[p];
    }
    return value == null ? match : String(value);
  });
};

module.exports = mongoose.model('EmailTemplate', emailTemplateSchema);
