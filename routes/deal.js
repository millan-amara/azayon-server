const express = require('express');
const router = express.Router();
const {
  getDeals, getKanban, getDeal,
  createDeal, updateDeal,
  markWon, markLost, deleteDeal,
} = require('../controllers/deal');
const { protect } = require('../middleware/auth');
const { attachPlan, checkDealLimit } = require('../middleware/plan');

router.use(protect);
router.use(attachPlan);

router.get('/kanban/:pipelineId', getKanban);

router.route('/')
  .get(getDeals)
  .post(checkDealLimit, createDeal);

router.route('/:id')
  .get(getDeal)
  .put(updateDeal)
  .delete(deleteDeal);

router.post('/:id/won', markWon);
router.post('/:id/lost', markLost);

module.exports = router;