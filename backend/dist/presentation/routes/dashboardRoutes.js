"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const DashboardController_1 = require("../controllers/DashboardController");
const authMiddleware_1 = require("../middlewares/authMiddleware");
const router = (0, express_1.Router)();
const controller = new DashboardController_1.DashboardController();
router.use(authMiddleware_1.authenticate);
router.get('/stats', (req, res) => controller.getStats(req, res));
router.get('/observaciones', (req, res) => controller.getObservaciones(req, res));
exports.default = router;
//# sourceMappingURL=dashboardRoutes.js.map