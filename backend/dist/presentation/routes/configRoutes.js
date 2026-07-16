"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const ConfigController_1 = require("../controllers/ConfigController");
const authMiddleware_1 = require("../middlewares/authMiddleware");
const router = (0, express_1.Router)();
const controller = new ConfigController_1.ConfigController();
// La configuración (SMMV y directorio de tránsito) la pueden ver y EDITAR todos
// los usuarios autenticados: tanto administradores como abogados (LAWYER).
router.use(authMiddleware_1.authenticate);
router.get('/', (req, res) => controller.get(req, res));
router.patch('/', (req, res) => controller.update(req, res));
exports.default = router;
//# sourceMappingURL=configRoutes.js.map