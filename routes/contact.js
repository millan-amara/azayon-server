const express = require('express');
const router = express.Router();
const {
  getContacts,
  getContact,
  createContact,
  updateContact,
  deleteContact,
  addTimelineEntry,
  getAllTags,
  importContacts,
} = require('../controllers/contact');
const { protect } = require('../middleware/auth');
const { attachPlan, checkContactLimit } = require('../middleware/plan');

router.use(protect);
router.use(attachPlan);

router.get('/tags/all', getAllTags);
router.post('/import', checkContactLimit, importContacts);

router.route('/')
  .get(getContacts)
  .post(checkContactLimit, createContact);

router.route('/:id')
  .get(getContact)
  .put(updateContact)
  .delete(deleteContact);

router.post('/:id/timeline', addTimelineEntry);

module.exports = router;