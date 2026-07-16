"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSettings = getSettings;
exports.updateSettings = updateSettings;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
// Configuración editable de la app (SMMV para los umbrales de cuantía y el
// directorio de tránsito). Se guarda en data/settings.json.
const FILE = path_1.default.join(process.cwd(), 'data', 'settings.json');
const DEFAULTS = { smmv: 1750905, transito: [] };
function getSettings() {
    try {
        return { ...DEFAULTS, ...JSON.parse(fs_1.default.readFileSync(FILE, 'utf8')) };
    }
    catch {
        return { ...DEFAULTS };
    }
}
function updateSettings(partial) {
    const next = { ...getSettings(), ...partial };
    fs_1.default.mkdirSync(path_1.default.dirname(FILE), { recursive: true });
    fs_1.default.writeFileSync(FILE, JSON.stringify(next, null, 2), 'utf8');
    return next;
}
//# sourceMappingURL=settings.js.map