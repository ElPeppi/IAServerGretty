import { Response } from 'express';
import axios from 'axios';
import { getSettings, updateSettings, TransitoEntry, AppSettings } from '../../infrastructure/config/settings';
import { AuthRequest } from '../middlewares/authMiddleware';
import { EngineService } from '../../infrastructure/services/EngineService';
import { sincronizarInsumos } from '../../infrastructure/storage/sincronizarInsumos';

function withUmbrales(s: AppSettings) {
  return { ...s, cuantiaMinimaMax: s.smmv * 40, cuantiaMenorMax: s.smmv * 150 };
}

const engine = new EngineService();

/**
 * El motor ya responde con un motivo entendible ("no es un Word válido", "plantilla
 * desconocida"); se reenvía tal cual con su código. Si ni siquiera contestó, el
 * problema es que el motor está caído — que es un mensaje muy distinto.
 */
function errorDelMotor(e: unknown, res: Response, accionFallida: string): void {
  if (axios.isAxiosError(e) && e.response) {
    const data = e.response.data as { error?: string; message?: string } | undefined;
    res.status(e.response.status).json({ message: data?.error ?? data?.message ?? accionFallida });
    return;
  }
  res.status(503).json({
    message: 'El motor de generación no responde. Verifica que el servicio esté arriba.',
  });
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

  // ─── Plantillas ──────────────────────────────────────────────────────────────
  // Las plantillas .docx/.xlsx viven en el DISCO del servidor (carpeta PLANTILLAS),
  // no en Drive: actualizarlas en Drive no cambia nada. Estos endpoints son la vía
  // para reemplazarlas sin entrar por SSH.

  // Leer el estado lo puede hacer cualquier usuario autenticado (sirve para
  // entender por qué una demanda salió con la plantilla vieja).
  async plantillas(_req: AuthRequest, res: Response): Promise<void> {
    try {
      res.json({ plantillas: await engine.listarPlantillas() });
    } catch (e) {
      errorDelMotor(e, res, 'No se pudieron leer las plantillas');
    }
  }

  // Fuerza la sincronización desde Drive sin esperar al próximo lote. Solo ADMIN
  // (lo gatea la ruta): reemplaza los insumos que usan TODAS las generaciones.
  async sincronizarPlantillas(_req: AuthRequest, res: Response): Promise<void> {
    try {
      const r = await sincronizarInsumos(true);
      const plantillas = await engine.listarPlantillas();
      res.json({ ...r, plantillas });
    } catch (e) {
      errorDelMotor(e, res, 'No se pudo sincronizar desde Drive');
    }
  }

  async restaurarPlantilla(req: AuthRequest, res: Response): Promise<void> {
    const clave = String(req.params.clave ?? '');
    const archivo = String((req.body as { archivo?: unknown })?.archivo ?? '');
    if (!archivo) {
      res.status(400).json({ message: 'Falta el respaldo a restaurar' });
      return;
    }
    try {
      res.json(await engine.restaurarPlantilla(clave, archivo));
    } catch (e) {
      errorDelMotor(e, res, 'No se pudo restaurar la plantilla');
    }
  }
}
