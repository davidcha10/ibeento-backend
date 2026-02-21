const express = require('express');
const router = express.Router();

const controller = require('../controllers/security-compliance-item.controller');

router.post('/', controller.createItem);
router.get('/', controller.getItems);
router.get('/:id', controller.getItemById);
router.patch('/:id', controller.updateItem);
router.delete('/:id', controller.deleteItem);
router.delete('/:id/remove', controller.removeItem);

module.exports = router;