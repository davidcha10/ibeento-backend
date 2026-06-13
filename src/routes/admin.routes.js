const { Router } = require('express');
const auth = require('../middlewares/auth');
const authAdmin = require('../middlewares/authAdmin');
const adminAnalyticsController = require('../controllers/admin-analytics.controller');
const adminTaxonomyController = require('../controllers/admin-taxonomy.controller');
const adminZonesController = require('../controllers/admin-zones.controller');
const adminActivitySyncController = require('../controllers/admin-activity-sync.controller');
const adminZoneSyncController = require('../controllers/admin-zone-sync.controller');
const adminCompliancePacksController = require('../controllers/admin-compliance-packs.controller');
const adminSocialImportLinksController = require('../controllers/admin-social-import-links.controller');
const adminPaywallVariantsController = require('../controllers/admin-paywall-variants.controller');
const adminEmailTemplatesController = require('../controllers/admin-email-templates.controller');
const adminActivityImageSearchController = require('../controllers/admin-activity-image-search.controller');
const onboardingTrackingController = require('../controllers/onboarding-tracking.controller');

const router = Router();

router.use(auth, authAdmin);

router.get('/analytics/overview', adminAnalyticsController.overview);
router.get('/analytics/funnel', adminAnalyticsController.funnel);
router.get('/analytics/revenue', adminAnalyticsController.revenueInsights);
router.get('/analytics/screens', adminAnalyticsController.screenDropoff);
router.get('/analytics/users', adminAnalyticsController.usersInsights);
router.get('/analytics/users-directory', adminAnalyticsController.usersDirectory);
router.get('/analytics/content', adminAnalyticsController.contentInsights);
router.get('/analytics/onboarding-funnel', onboardingTrackingController.getAdminFunnel);
router.get('/analytics/users-timeline-stats', adminAnalyticsController.usersTimelineStats);

router.get('/taxonomy/zone-types', adminTaxonomyController.list);
router.get('/taxonomy/zone-types/:qid', adminTaxonomyController.getByQid);
router.post('/taxonomy/zone-types', adminTaxonomyController.createOrUpsert);
router.put('/taxonomy/zone-types/:qid', adminTaxonomyController.updateByQid);
router.delete('/taxonomy/zone-types/:qid', adminTaxonomyController.deleteByQid);

router.post('/zones/:id/update-taxonomy-snapshot', adminZonesController.updateTaxonomySnapshotByZoneId);

router.get('/activity-sync/status', adminActivitySyncController.status);
router.get('/activity-sync/activities/compare', adminActivitySyncController.compareActivities);
router.post('/activity-sync/activities/missing-keys-by-zone', adminActivitySyncController.listMissingKeysByZone);
router.post('/activity-sync/activities/push-local-to-prod', adminActivitySyncController.pushLocalToProd);
router.post('/activity-sync/activities/push-prod-to-local', adminActivitySyncController.pushProdToLocal);

router.get('/zone-sync/status', adminZoneSyncController.status);
router.get('/zone-sync/zones/compare', adminZoneSyncController.compareZones);
router.get('/zone-sync/zones/sync-chain', adminZoneSyncController.syncChain);
router.post('/zone-sync/zones/push-local-to-prod', adminZoneSyncController.pushLocalToProd);
router.post('/zone-sync/zones/push-prod-to-local', adminZoneSyncController.pushProdToLocal);

router.get('/compliance-packs', adminCompliancePacksController.list);
router.get('/compliance-packs/:id', adminCompliancePacksController.getById);
router.post('/compliance-packs', adminCompliancePacksController.create);
router.put('/compliance-packs/:id', adminCompliancePacksController.updateById);
router.delete('/compliance-packs/:id', adminCompliancePacksController.deleteById);
router.get('/social-import-links', adminSocialImportLinksController.list);
router.get('/paywall-variants', adminPaywallVariantsController.list);
router.post('/paywall-variants', adminPaywallVariantsController.create);
router.put('/paywall-variants/:id', adminPaywallVariantsController.updateById);
router.delete('/paywall-variants/:id', adminPaywallVariantsController.removeById);
router.get('/activity-images/search', adminActivityImageSearchController.search);
router.get('/email-templates', adminEmailTemplatesController.list);
router.post('/email-templates', adminEmailTemplatesController.create);
router.put('/email-templates/:id', adminEmailTemplatesController.updateById);
router.delete('/email-templates/:id', adminEmailTemplatesController.removeById);

module.exports = router;
