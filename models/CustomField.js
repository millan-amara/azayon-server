const mongoose = require('mongoose');

// Per-org custom field definitions for entities (contacts, deals).
// Values land in the entity's existing `customFields` Map.
const customFieldSchema = new mongoose.Schema({
  orgId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Org', required: true, index: true },
  entity: { type: String, enum: ['contact', 'deal'], required: true, index: true },

  // `key` is the storage key in the entity's customFields Map. Stable across renames.
  key:   { type: String, required: true, trim: true },
  label: { type: String, required: true, trim: true },

  type: { type: String, enum: ['text', 'number', 'date', 'select'], default: 'text' },
  // For type=select only
  options: { type: [String], default: [] },

  required: { type: Boolean, default: false },
  order:    { type: Number,  default: 0 },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

// One key per (org, entity)
customFieldSchema.index({ orgId: 1, entity: 1, key: 1 }, { unique: true });

module.exports = mongoose.model('CustomField', customFieldSchema);
