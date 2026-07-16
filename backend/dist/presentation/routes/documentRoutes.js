"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const multer_1 = __importDefault(require("multer"));
const DocumentController_1 = require("../controllers/DocumentController");
const GenerateController_1 = require("../controllers/GenerateController");
const authMiddleware_1 = require("../middlewares/authMiddleware");
const router = (0, express_1.Router)();
const controller = new DocumentController_1.DocumentController();
const generateController = new GenerateController_1.GenerateController();
// .docx editado desde el navegador (hasta 25 MB) → se sobreescribe en el NAS.
const upload = (0, multer_1.default)({ storage: multer_1.default.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
router.use(authMiddleware_1.authenticate);
router.get('/', (req, res) => controller.getAll(req, res));
router.get('/:id', (req, res) => controller.getById(req, res));
router.post('/:id/sign', (req, res) => controller.sign(req, res));
router.post('/:id/regenerar', (req, res) => generateController.regenerarUno(req, res));
router.put('/:id/file', upload.single('file'), (req, res) => controller.saveFile(req, res));
exports.default = router;
//# sourceMappingURL=documentRoutes.js.map