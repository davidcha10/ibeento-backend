const { Router } = require('express');
const ctrl = require('../controllers/auth.controller');
const auth = require('../middlewares/auth');
const rejectSensitiveBodyFields = require('../middlewares/rejectSensitiveBodyFields');

const router = Router();

router.post('/register', rejectSensitiveBodyFields, ctrl.register);
router.post('/login', ctrl.login);
router.post('/refresh', ctrl.refresh);
router.post('/logout', ctrl.logout);
router.get('/me', auth, ctrl.me);
router.post('/google', rejectSensitiveBodyFields, ctrl.google);
router.post('/apple', rejectSensitiveBodyFields, ctrl.apple);

module.exports = router;
