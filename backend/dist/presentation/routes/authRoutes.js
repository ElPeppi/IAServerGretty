"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const AuthController_1 = require("../controllers/AuthController");
const authMiddleware_1 = require("../middlewares/authMiddleware");
const router = (0, express_1.Router)();
const controller = new AuthController_1.AuthController();
router.post('/login', (req, res) => controller.login(req, res));
// El registro queda restringido a ADMIN/TI (la creación normal es por /api/users).
router.post('/register', authMiddleware_1.authenticate, authMiddleware_1.requireAdmin, (req, res) => controller.register(req, res));
router.get('/me', authMiddleware_1.authenticate, (req, res) => controller.me(req, res));
router.patch('/profile', authMiddleware_1.authenticate, (req, res) => controller.updateProfile(req, res));
router.patch('/password', authMiddleware_1.authenticate, (req, res) => controller.changePassword(req, res));
exports.default = router;
//# sourceMappingURL=authRoutes.js.map