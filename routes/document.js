const express = require('express');
const router = express.Router();
const {
  listDocuments, getDocument, createDocument, updateDocument, deleteDocument,
  downloadDocumentPdf, sendDocument, markPaid, acceptQuote, declineQuote,
  convertQuoteToInvoice,
} = require('../controllers/document');
const { protect } = require('../middleware/auth');

router.use(protect);

router.route('/')
  .get(listDocuments)
  .post(createDocument);

router.route('/:id')
  .get(getDocument)
  .put(updateDocument)
  .delete(deleteDocument);

router.get('/:id/pdf',     downloadDocumentPdf);
router.post('/:id/send',   sendDocument);
router.post('/:id/paid',   markPaid);
router.post('/:id/accept', acceptQuote);
router.post('/:id/decline', declineQuote);
router.post('/:id/convert-to-invoice', convertQuoteToInvoice);

module.exports = router;
