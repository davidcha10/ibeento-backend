const express = require('express');
const router = express.Router();

const cancellationPolicyController = require('../controllers/cancellation-policy.controller');

router.post('/', cancellationPolicyController.create);
router.get('/', cancellationPolicyController.list);
router.get('/:id', cancellationPolicyController.get);
router.patch('/:id', cancellationPolicyController.update);
router.patch('/:id/deactivate', cancellationPolicyController.deactivate);
router.patch('/:id/restore', cancellationPolicyController.restore);
router.delete('/:id', cancellationPolicyController.remove);

module.exports = router;