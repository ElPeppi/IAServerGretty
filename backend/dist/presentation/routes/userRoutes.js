"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const UsersController_1 = require("../controllers/UsersController");
const authMiddleware_1 = require("../middlewares/authMiddleware");
const router = (0, express_1.Router)();
const controller = new UsersController_1.UsersController();
// Solo ADMIN/TI puede gestionar usuarios.
router.use(authMiddleware_1.authenticate, authMiddleware_1.requireAdmin);
router.get('/', (req, res) => controller.list(req, res));
router.post('/', (req, res) => controller.create(req, res));
router.get('/:id/password', (req, res) => controller.viewPassword(req, res));
router.patch('/:id/password', (req, res) => controller.resetPassword(req, res));
router.delete('/:id', (req, res) => controller.remove(req, res));
exports.default = router;
//# sourceMappingURL=userRoutes.js.map