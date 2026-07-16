"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConfigController = void 0;
const settings_1 = require("../../infrastructure/config/settings");
function withUmbrales(s) {
    return { ...s, cuantiaMinimaMax: s.smmv * 40, cuantiaMenorMax: s.smmv * 150 };
}
class ConfigController {
    // Cualquier usuario autenticado puede leer (umbrales de cuantía, tránsito, …)
    async get(_req, res) {
        res.json(withUmbrales((0, settings_1.getSettings)()));
    }
    // Solo ADMIN puede modificar (lo gatea la ruta con requireAdmin).
    // Acepta { smmv? } y/o { transito? } — se actualiza solo lo que llegue.
    async update(req, res) {
        const body = req.body;
        const patch = {};
        if (body.smmv !== undefined) {
            const n = Number(body.smmv);
            if (!Number.isFinite(n) || n <= 0) {
                res.status(400).json({ message: 'SMMV inválido (debe ser un número positivo)' });
                return;
            }
            patch.smmv = Math.round(n);
        }
        if (body.transito !== undefined) {
            if (!Array.isArray(body.transito)) {
                res.status(400).json({ message: 'transito debe ser una lista' });
                return;
            }
            patch.transito = body.transito
                .map((t) => ({
                ciudad: String(t?.ciudad ?? '').trim(),
                entidad: String(t?.entidad ?? '').trim(),
                correo: String(t?.correo ?? '').trim(),
            }))
                .filter((t) => t.ciudad || t.entidad || t.correo);
        }
        res.json(withUmbrales((0, settings_1.updateSettings)(patch)));
    }
}
exports.ConfigController = ConfigController;
//# sourceMappingURL=ConfigController.js.map