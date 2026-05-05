const mongoose = require('mongoose');

// Per-user saved filter combinations for list/board pages.
// `page` namespaces them so the same name can exist across pages
// ("My deals" on Pipeline AND on Contacts is fine).
//
// `filters` is intentionally a generic Mixed object — each page is free
// to stuff whatever shape it likes. The client owns serialisation.
const savedViewSchema = new mongoose.Schema({
  orgId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Org',  required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  page: {
    type: String,
    enum: ['pipeline', 'contacts', 'tasks', 'documents'],
    required: true,
    index: true,
  },

  name:    { type: String, required: true, trim: true, maxlength: 60 },
  filters: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });

// One name per (user, page) — prevents accidental dupes
savedViewSchema.index({ userId: 1, page: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('SavedView', savedViewSchema);
