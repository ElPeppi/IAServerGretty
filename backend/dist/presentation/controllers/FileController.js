"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileController = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const UPLOADS_DIR = path_1.default.join(process.cwd(), 'uploads');
function ensureUploadsDir() {
    if (!fs_1.default.existsSync(UPLOADS_DIR)) {
        fs_1.default.mkdirSync(UPLOADS_DIR, { recursive: true });
    }
}
class FileController {
    // Called by n8n to store a generated/signed file
    async upload(req, res) {
        try {
            const { content, filename, mimeType } = req.body;
            if (!content || !filename) {
                res.status(400).json({ message: 'content y filename son requeridos' });
                return;
            }
            ensureUploadsDir();
            const safeFilename = `${Date.now()}-${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
            const filePath = path_1.default.join(UPLOADS_DIR, safeFilename);
            const buffer = Buffer.from(content, 'base64');
            fs_1.default.writeFileSync(filePath, buffer);
            const baseUrl = process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3001}`;
            const url = `${baseUrl}/uploads/${safeFilename}`;
            res.json({ url, filename: safeFilename, mimeType: mimeType ?? 'application/octet-stream' });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'Error interno';
            res.status(500).json({ message });
        }
    }
}
exports.FileController = FileController;
//# sourceMappingURL=FileController.js.map