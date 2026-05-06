const express = require('express');
const router = express.Router();
const {
  getDeals, getKanban, getDeal,
  createDeal, updateDeal,
  markWon, markLost, deleteDeal,
  exportDeals, importDeals,
  addComment, deleteComment,
} = require('../controllers/deal');
const { protect } = require('../middleware/auth');
const { attachPlan, checkDealLimit } = require('../middleware/plan');

router.use(protect);
router.use(attachPlan);

router.get('/kanban/:pipelineId', getKanban);
router.get('/export', exportDeals);
router.post('/import', checkDealLimit, importDeals);

router.route('/')
  .get(getDeals)
  .post(checkDealLimit, createDeal);

router.route('/:id')
  .get(getDeal)
  .put(updateDeal)
  .delete(deleteDeal);

router.post('/:id/won', markWon);
router.post('/:id/lost', markLost);

// Comments — internal collaboration thread on the deal. The /api/deals
// router already mounts `restrictViewer` upstream in app.js, so viewers can
// read the deal (which carries the comments) but can't post or delete here.
router.post('/:id/comments', addComment);
router.delete('/:id/comments/:commentId', deleteComment);

module.exports = router;