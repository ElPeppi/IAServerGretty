"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileStorage = void 0;
/**
 * FileStorage — persiste archivos generados y devuelve su URL pública.
 *
 * Hoy guarda en la carpeta local `uploads/` (servida en `/uploads`). Para migrar
 * a Amazon S3 más adelante basta cambiar esta clase; el resto del backend no se
 * entera (solo recibe la URL).
 */
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const UPLOADS_DIR = path_1.default.join(process.cwd(), 'uploads');
function baseUrl() {
    return process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3001}`;
}
class FileStorage {
    ensureDir() {
        if (!fs_1.default.existsSync(UPLOADS_DIR))
            fs_1.default.mkdirSync(UPLOADS_DIR, { recursive: true });
    }
    saveBuffer(buffer, filename, mimeType = 'application/octet-stream') {
        this.ensureDir();
        const safe = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        fs_1.default.writeFileSync(path_1.default.join(UPLOADS_DIR, safe), buffer);
        return { url: `${baseUrl()}/uploads/${safe}`, filename: safe, mimeType };
    }
    saveBase64(content, filename, mimeType = 'application/octet-stream') {
        return this.saveBuffer(Buffer.from(content, 'base64'), filename, mimeType);
    }
}
exports.FileStorage = FileStorage;
//# sourceMappingURL=FileStorage.js.map