const express = require('express');
const router = express.Router();

const serviceCategoryController = require('../controllers/service-category.controller');

// Service Category routes
router.post('/', serviceCategoryController.createServiceCategory);
router.get('/', serviceCategoryController.listServiceCategories);
router.get('/:id', serviceCategoryController.getServiceCategoryById);
router.patch('/:id', serviceCategoryController.updateServiceCategory);
router.delete('/:id', serviceCategoryController.deleteServiceCategory);
router.post('/:id/restore', serviceCategoryController.restoreServiceCategory);
router.delete('/:id/remove', serviceCategoryController.removeServiceCategory);

module.exports = router;