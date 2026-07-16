"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const FileController_1 = require("../controllers/FileController");
const router = (0, express_1.Router)();
const controller = new FileController_1.FileController();
// Called by n8n to persist a generated or signed file
router.post('/upload', (req, res) => controller.upload(req, res));
exports.default = router;
//# sourceMappingURL=fileRoutes.js.map