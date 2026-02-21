const router = require("express").Router();
const ctrl = require("../controllers/zone.controller");

router.post("/", ctrl.createZone);
router.get("/", ctrl.listZones);
router.get("/:id", ctrl.getZoneById);
router.put("/:id", ctrl.updateZone);
router.delete("/:id", ctrl.deleteZone);

module.exports = router;
