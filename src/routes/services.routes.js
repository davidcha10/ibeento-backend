'use strict';

const express = require('express');
const ctrl = require('../controllers/service.controller');

const router = express.Router();

router.get('/', ctrl.list);
router.get('/activity/:activityId', ctrl.listByActivity);

router.get('/:id', ctrl.get);

router.post('/', ctrl.create);

router.patch('/:id', ctrl.update);

router.delete('/:id', ctrl.remove);

router.post('/:id/restore', ctrl.restore);

module.exports = router;
