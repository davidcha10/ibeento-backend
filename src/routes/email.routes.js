const { Router } = require('express');
const auth = require('../middlewares/auth');
const emailController = require('../controllers/email.controller');

const router = Router();

router.post('/test', auth, emailController.sendTest);

module.exports = router;
