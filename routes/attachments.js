const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const Contact = require('../models/Contact');
const Deal = require('../models/Deal');
const { protect } = require('../middleware/auth');
const { AppError } = require('../middleware/error');

router.use(protect);

// Helper — get model by resource type
const getModel = (type) => {
  if (type === 'contact') return Contact;
  if (type === 'deal') return Deal;
  throw new AppError('Invalid resource type', 400);
};

// POST /api/attachments/:type/:id
// Called after Cloudinary upload succeeds — saves metadata to the resource
router.post('/:type/:id', async (req, res, next) => {
  try {
    const { type, id } = req.params;
    const { publicId, url, name, size, mimeType } = req.body;

    if (!publicId || !url || !name) {
      throw new AppError('publicId, url and name are required', 400);
    }

    const Model = getModel(type);
    const doc = await Model.findOneAndUpdate(
      { _id: id, orgId: req.orgId },
      {
        $push: {
          attachments: {
            publicId,
            url,
            name,
            size,
            type: mimeType,
            uploadedBy: req.user._id,
            uploadedAt: new Date(),
          },
        },
      },
      { new: true }
    );

    if (!doc) throw new AppError('Resource not found', 404);

    const attachment = doc.attachments[doc.attachments.length - 1];
    res.status(201).json({ attachment });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/attachments/:type/:id/:attachmentId
router.delete('/:type/:id/:attachmentId', async (req, res, next) => {
  try {
    const { type, id, attachmentId } = req.params;
    const Model = getModel(type);

    // Find the doc and the attachment
    const doc = await Model.findOne({ _id: id, orgId: req.orgId });
    if (!doc) throw new AppError('Resource not found', 404);

    const attachment = doc.attachments.id(attachmentId);
    if (!attachment) throw new AppError('Attachment not found', 404);

    const publicId = attachment.publicId;

    // Delete from Cloudinary using signed request
    if (process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
      try {
        const timestamp = Math.round(Date.now() / 1000);
        const str = `public_id=${publicId}&timestamp=${timestamp}${process.env.CLOUDINARY_API_SECRET}`;
        const signature = crypto.createHash('sha1').update(str).digest('hex');

        await fetch(
          `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/image/destroy`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              public_id: publicId,
              api_key: process.env.CLOUDINARY_API_KEY,
              timestamp,
              signature,
            }),
          }
        );
      } catch (err) {
        // Don't fail the deletion if Cloudinary call fails — just log it
        console.error('Cloudinary deletion failed:', err.message);
      }
    }

    // Remove from MongoDB
    await Model.findOneAndUpdate(
      { _id: id, orgId: req.orgId },
      { $pull: { attachments: { _id: attachmentId } } }
    );

    res.json({ message: 'Attachment deleted' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;