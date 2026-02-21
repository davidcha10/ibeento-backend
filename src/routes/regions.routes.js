const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/region.controller");

// Crear
router.post("/", ctrl.createRegion);

// Listar
router.get("/", ctrl.listRegions);

// Obtener por id
router.get("/:id", ctrl.getRegionById);

// Actualizar
router.put("/:id", ctrl.updateRegion);

// Eliminar
router.delete("/:id", ctrl.deleteRegion);

module.exports = router;
