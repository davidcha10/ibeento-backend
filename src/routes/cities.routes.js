const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/city.controller");

// Crear
router.post("/", ctrl.createCity);

// Listar
router.get("/", ctrl.listCities);

// Obtener por id
router.get("/:id", ctrl.getCityById);

// Actualizar
router.put("/:id", ctrl.updateCity);

// Eliminar
router.delete("/:id", ctrl.deleteCity);

module.exports = router;
