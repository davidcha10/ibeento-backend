

const express = require('express');
const router = express.Router();

const controller = require('../controllers/service-tag.controller');

// CRUD
router.post('/', controller.create);
router.post('/many', controller.createMany);
router.get('/', controller.list);
router.get('/:id', controller.get);
router.patch('/:id', controller.update);

// Soft delete / restore
router.patch('/:id/deactivate', controller.deactivate);
router.patch('/:id/restore', controller.restore);

// Hard delete
router.delete('/:id', controller.remove);

module.exports = router;