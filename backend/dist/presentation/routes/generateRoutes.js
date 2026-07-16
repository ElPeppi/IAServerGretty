"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const multer_1 = __importDefault(require("multer"));
const GenerateController_1 = require("../controllers/GenerateController");
const authMiddleware_1 = require("../middlewares/authMiddleware");
const router = (0, express_1.Router)();
const upload = (0, multer_1.default)({ storage: multer_1.default.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const controller = new GenerateController_1.GenerateController();
router.use(authMiddleware_1.authenticate);
router.post('/from-excel', upload.single('file'), (req, res) => controller.fromExcel(req, res));
// Descarga de obligaciones del SAC por cédula (reemplaza el ZIP/n8n).
// Acepta cédulas pegadas (body.cedulas) y/o el Excel de asignación (campo excelFile,
// de donde se sacan las cédulas de la columna IDENTIFICACION).
router.post('/descargar-sac', upload.single('excelFile'), (req, res) => controller.descargarSac(req, res));
// Demandas singulares con el motor real (sac_scripts): Excel + correo del poder.
router.post('/singular', upload.fields([{ name: 'excelFile', maxCount: 1 }, { name: 'correoPoder', maxCount: 1 }]), (req, res) => controller.singular(req, res));
exports.default = router;
//# sourceMappingURL=generateRoutes.js.map