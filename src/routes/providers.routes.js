// routes/providers.routes.js
const express = require('express');
const provider = require('../controllers/provider.controller');
const auth = require('../middlewares/auth');

const router = express.Router();

// Public resolver used by guest landing pages
router.get('/guest-links/resolve', provider.resolveGuestLink);
router.post('/guest-links/save-main-guest', auth, provider.saveGuestLinkMainGuest);
router.post('/guest-links/complete', auth, provider.completeGuestLink);

// ===== Providers =====
router.get('', provider.list);
router.get('/:id', provider.get);
router.post('', auth, provider.create);
router.patch('/:id', auth, provider.update);
router.delete('/:id', auth, provider.remove);

// ===== Provider guest links =====
router.get('/:id/guest-links', auth, provider.listGuestLinks);
router.get('/:id/bookings', auth, provider.listBookings);
router.post('/:id/guest-links', auth, provider.createGuestLink);
router.patch('/:id/guest-links/:linkId', auth, provider.updateGuestLink);
router.delete('/:id/guest-links/:linkId', auth, provider.deleteGuestLink);
router.post('/:id/guest-links/:linkId/send', auth, provider.sendGuestLink);

// ===== Admin Management =====
router.post('/:id/admins', auth, provider.addAdmin);

module.exports = router;
