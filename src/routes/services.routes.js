'use strict';

const express = require('express');
const ctrl = require('../controllers/service.controller');
const auth = require('../middlewares/auth');

const router = express.Router();

router.get('/', ctrl.list);
router.get('/activity/:activityId', ctrl.listByActivity);

router.get('/:id', ctrl.get);

router.post('/', auth, ctrl.create);

router.patch('/:id', auth, ctrl.update);

router.delete('/:id', auth, ctrl.remove);

router.post('/:id/restore', auth, ctrl.restore);

module.exports = router;
