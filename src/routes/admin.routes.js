const { Router } = require('express');
const auth = require('../middlewares/auth');
const authAdmin = require('../middlewares/authAdmin');
const adminAnalyticsController = require('../controllers/admin-analytics.controller');
const adminTaxonomyController = require('../controllers/admin-taxonomy.controller');
const adminZonesController = require('../controllers/admin-zones.controller');

const router = Router();

router.use(auth, authAdmin);

router.get('/analytics/overview', adminAnalyticsController.overview);
router.get('/analytics/funnel', adminAnalyticsController.funnel);
router.get('/analytics/revenue', adminAnalyticsController.revenueInsights);
router.get('/analytics/screens', adminAnalyticsController.screenDropoff);
router.get('/analytics/users', adminAnalyticsController.usersInsights);

router.get('/taxonomy/zone-types', adminTaxonomyController.list);
router.get('/taxonomy/zone-types/:qid', adminTaxonomyController.getByQid);
router.post('/taxonomy/zone-types', adminTaxonomyController.createOrUpsert);
router.put('/taxonomy/zone-types/:qid', adminTaxonomyController.updateByQid);
router.delete('/taxonomy/zone-types/:qid', adminTaxonomyController.deleteByQid);

router.post('/zones/:id/update-taxonomy-snapshot', adminZonesController.updateTaxonomySnapshotByZoneId);

module.exports = router;
