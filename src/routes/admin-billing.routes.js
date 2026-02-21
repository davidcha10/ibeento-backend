const { Router } = require('express');
const auth = require('../middlewares/auth');
const authAdmin = require('../middlewares/authAdmin');
const adminBillingController = require('../controllers/admin-billing.controller');

const router = Router();

router.use(auth, authAdmin);

router.get('/transactions', adminBillingController.transactions);
router.get('/subscriptions', adminBillingController.subscriptions);

module.exports = router;
