const { Router } = require('express');
const Itineraries = require('../controllers/itinerary.controller');
const Items = require('../controllers/itinerary-item.controller');
const authOptional = require('../middlewares/authOptional');

const router = Router();
router.use(authOptional);

// /api/itineraries
router.get('/share/link/view', Itineraries.viewShareLink);
router.get('/share/view', Itineraries.viewSharedItinerary);
router.post('/share/link/accept', Itineraries.acceptShareLink);
router.post('/', Itineraries.create);
router.get('/',  Itineraries.list);
router.get('/:itineraryId', Itineraries.get);
router.patch('/:itineraryId', Itineraries.update);
router.delete('/:itineraryId', Itineraries.remove);
router.post('/:itineraryId/duplicate', Itineraries.duplicate);
router.get('/:itineraryId/share', Itineraries.listShares);
router.post('/:itineraryId/share', Itineraries.share);
router.post('/:itineraryId/share/link', Itineraries.createShareLink);
router.post('/:itineraryId/share/accept', Itineraries.acceptInvite);
router.delete('/:itineraryId/share/:memberId', Itineraries.unshare);

// /api/itineraries/:itineraryId/items
router.get('/:itineraryId/items', Items.list);
router.get('/:itineraryId/items/:itemId', Items.get);
router.post('/:itineraryId/items', Items.create);
router.patch('/:itineraryId/items/:itemId', Items.update);
router.delete('/:itineraryId/items/:itemId', Items.remove);
router.post('/:itineraryId/items/bulk', Items.bulkCreate);
router.post('/:itineraryId/items/reorder', Items.reorder);

module.exports = router;
