const { Router } = require('express');
const auth = require('../middlewares/auth');
const billingController = require('../controllers/billing.controller');

const router = Router();

router.get('/me-subscription', auth, billingController.getMySubscription);
router.get('/trial-eligibility', auth, billingController.getTrialEligibility);
router.post('/stripe/checkout-session', auth, billingController.createCheckoutSession);
router.post('/stripe/customer-portal', auth, billingController.createCustomerPortalSession);
router.post('/stripe/webhook', billingController.handleStripeWebhook);

module.exports = router;
