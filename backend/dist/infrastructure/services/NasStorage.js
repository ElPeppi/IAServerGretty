"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.NasStorage = void 0;
/**
 * NasStorage — sirve y sobreescribe los documentos directamente desde el NAS.
 *
 * El MOTOR (sac_scripts) escribe todo en `SAC_OUT_DIR/{cedula}/...` (la carpeta
 * de la NAS). El backend NO copia esos archivos a su disco ni a S3: los referencia
 * por su ruta relativa y los publica en `/docs` (express.static(DOCS_DIR)).
 *
 *   DOCS_DIR (backend) DEBE apuntar a la MISMA carpeta que SAC_OUT_DIR (motor).
 *   En producción ambos usan por defecto la NAS (…/GARANTIAS). En local, si el
 *   motor escribe en C:/SAC_Documentos, pon DOCS_DIR=C:/SAC_Documentos.
 *
 * Así no se usa ni S3 ni el almacenamiento del servidor: la fuente única es el NAS.
 */
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const DOCS_DIR = process.env.DOCS_DIR || '';
function baseUrl() {
    return process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3001}`;
}
class NasStorage {
    /** ¿Está configurado el NAS (DOCS_DIR)? */
    get enabled() {
        return !!DOCS_DIR;
    }
    get root() {
        return DOCS_DIR;
    }
    /** Ruta relativa (posix) → URL pública servida por /docs. */
    urlForRelPath(rel) {
        const clean = String(rel).replace(/\\/g, '/').replace(/^\/+/, '');
        const encoded = clean.split('/').map(encodeURIComponent).join('/');
        return `${baseUrl()}/docs/${encoded}`;
    }
    /** URL pública (o fileUrl guardada) → ruta relativa dentro del NAS. */
    relPathFromUrl(url) {
        const marker = '/docs/';
        const i = url.indexOf(marker);
        if (i < 0)
            return null;
        return decodeURIComponent(url.slice(i + marker.length)).replace(/^\/+/, '');
    }
    /** Resuelve una ruta relativa a una ABSOLUTA dentro del NAS (evita path traversal). */
    absFromRelPath(rel) {
        if (!DOCS_DIR)
            throw new Error('DOCS_DIR no está configurado en el backend');
        const clean = String(rel).replace(/\\/g, '/').replace(/^\/+/, '');
        const root = path_1.default.resolve(DOCS_DIR);
        const abs = path_1.default.resolve(root, clean);
        if (abs !== root && !abs.startsWith(root + path_1.default.sep)) {
            throw new Error('Ruta fuera del directorio del NAS');
        }
        return abs;
    }
    /** Escribe un archivo nuevo en el NAS y devuelve su URL pública. */
    saveBuffer(buffer, rel) {
        const abs = this.absFromRelPath(rel);
        fs_1.default.mkdirSync(path_1.default.dirname(abs), { recursive: true });
        fs_1.default.writeFileSync(abs, buffer);
        return this.urlForRelPath(rel);
    }
    /** Sobreescribe un archivo EXISTENTE del NAS (usado por el editor de la demanda). */
    overwrite(rel, buffer) {
        const abs = this.absFromRelPath(rel);
        if (!fs_1.default.existsSync(abs))
            throw new Error('El archivo no existe en el NAS');
        fs_1.default.writeFileSync(abs, buffer);
    }
}
exports.NasStorage = NasStorage;
//# sourceMappingURL=NasStorage.js.map