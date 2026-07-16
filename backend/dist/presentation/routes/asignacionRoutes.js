"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const multer_1 = __importDefault(require("multer"));
const AsignacionController_1 = require("../controllers/AsignacionController");
const authMiddleware_1 = require("../middlewares/authMiddleware");
const router = (0, express_1.Router)();
const upload = (0, multer_1.default)({ storage: multer_1.default.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const controller = new AsignacionController_1.AsignacionController();
router.use(authMiddleware_1.authenticate);
router.get('/', (req, res) => controller.listar(req, res));
router.post('/', upload.single('excelFile'), (req, res) => controller.subir(req, res));
router.post('/actualizar', (req, res) => controller.actualizar(req, res));
router.post('/:id/generar-poderes', (req, res) => controller.generarPoderes(req, res));
router.post('/:id/poder', upload.single('poderFile'), (req, res) => controller.subirPoder(req, res));
router.post('/:id/generar-demandas', (req, res) => controller.generarDemandas(req, res));
exports.default = router;
//# sourceMappingURL=asignacionRoutes.js.map