import { Response } from 'express';
import { getSettings, updateSettings, TransitoEntry, AppSettings } from '../../infrastructure/config/settings';
import { AuthRequest } from '../middlewares/authMiddleware';

function withUmbrales(s: AppSettings) {
  return { ...s, cuantiaMinimaMax: s.smmv * 40, cuantiaMenorMax: s.smmv * 150 };
}

export class ConfigController {
  // Cualquier usuario autenticado puede leer (umbrales de cuantía, tránsito, …)
  async get(_req: AuthRequest, res: Response): Promise<void> {
    res.json(withUmbrales(getSettings()));
  }

  // Solo ADMIN puede modificar (lo gatea la ruta con requireAdmin).
  // Acepta { smmv? } y/o { transito? } — se actualiza solo lo que llegue.
  async update(req: AuthRequest, res: Response): Promise<void> {
    const body = req.body as { smmv?: unknown; transito?: unknown };
    const patch: Partial<AppSettings> = {};

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
      patch.transito = (body.transito as TransitoEntry[])
        .map((t) => ({
          ciudad: String(t?.ciudad ?? '').trim(),
          entidad: String(t?.entidad ?? '').trim(),
          correo: String(t?.correo ?? '').trim(),
        }))
        .filter((t) => t.ciudad || t.entidad || t.correo);
    }

    res.json(withUmbrales(updateSettings(patch)));
  }
}
