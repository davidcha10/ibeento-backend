const router = require("express").Router();
const ctrl = require("../controllers/neighborhood.controller");

router.post("/", ctrl.createNeighborhood);
router.get("/", ctrl.listNeighborhoods);
router.get("/:id", ctrl.getNeighborhoodById);
router.put("/:id", ctrl.updateNeighborhood);
router.delete("/:id", ctrl.deleteNeighborhood);

module.exports = router;
