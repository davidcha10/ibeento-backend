// routes/providers.routes.js
const express = require('express');
const provider = require('../controllers/provider.controller');

const router = express.Router();

// ===== Providers =====
router.get('', provider.list);
router.get('/:id', provider.get);
router.post('', provider.create);
router.patch('/:id', provider.update);
router.delete('/:id', provider.remove);

// ===== Admin Management =====
router.post('/:id/admins', provider.addAdmin);

module.exports = router;