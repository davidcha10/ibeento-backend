const express = require('express');
const router = express.Router();

const auth = require('../middlewares/auth');

const userFavoriteController = require('../controllers/user-favorite.controller');

// User Favorites Routes (authenticated)
router.post('/', auth, userFavoriteController.create);        // Add favorite
router.get('/', auth, userFavoriteController.list);           // List user favorites
router.get('/top-tags', auth, userFavoriteController.topTags); // List top favorite tags
router.delete('/:id', auth, userFavoriteController.remove);   // Remove favorite

module.exports = router;
