const express = require('express');
const router = express.Router();

const controller = require('../controllers/possible-risk-item.controller');

// CRUD
router.post('/', controller.create);
router.get('/', controller.list);
router.get('/:id', controller.get);
router.patch('/:id', controller.update);
router.patch('/:id/deactivate', controller.deactivate);
router.patch('/:id/restore', controller.restore);
router.delete('/:id', controller.remove);

module.exports = router;