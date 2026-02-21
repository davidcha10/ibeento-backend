const express = require('express');
const router = express.Router();

const privacyItemController = require('../controllers/privacy-item.controller');

router.post('/', privacyItemController.createPrivacyItem);
router.get('/', privacyItemController.getPrivacyItems);
router.get('/:id', privacyItemController.getPrivacyItemById);
router.patch('/:id', privacyItemController.updatePrivacyItem);
router.patch('/:id/deactivate', privacyItemController.deactivatePrivacyItem);
router.patch('/:id/restore', privacyItemController.restorePrivacyItem);
router.delete('/:id', privacyItemController.deletePrivacyItem);

module.exports = router;