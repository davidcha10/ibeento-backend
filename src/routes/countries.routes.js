const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/country.controller");

// Crear
router.post("/", ctrl.createCountry);

// Listar
router.get("/", ctrl.listCountries);

// Obtener por id
router.get("/:id", ctrl.getCountryById);

// Actualizar
router.put("/:id", ctrl.updateCountry);

// Eliminar
router.delete("/:id", ctrl.deleteCountry);

module.exports = router;
