import { Request, Response } from 'express';
import { leerCasos, cuadroDisponible, motivoNoDisponible } from '../../infrastructure/libertador/cuadroJuridico';
import { EngineService } from '../../infrastructure/services/EngineService';
import {
  libertadorDriveDisponible, bajarPlantillaEstadoCuenta, resolverCarpetaCaso, subirArchivoCaso,
  asegurarCarpetaCaso, normalizarProceso, ProcesoLibertador, CarpetaCasoAsegurada,
} from '../../infrastructure/storage/libertadorDrive';
import { notificationHub } from '../../infrastructure/services/NotificationHub';
import { AuthRequest } from '../middlewares/authMiddleware';

const engineService = new EngineService();

// Las peticiones de carpetas se atienden de a una: si llegan juntos dos correos
// con la misma solicitud, el segundo tiene que ver la carpeta que creó el primero
// en vez de crear otra.
let colaCarpetas: Promise<unknown> = Promise.resolve();
function enCola<T>(fn: () => Promise<T>): Promise<T> {
  const p = colaCarpetas.then(fn, fn);
  colaCarpetas = p.catch(() => undefined);
  return p;
}

/**
 * LibertadorController — los casos de Libertador.
 *
 * A diferencia de Finandina, aquí NO hay lotes: los casos llegan de uno en uno y
 * la oficina los lleva en el cuadro jurídico (Google Sheet), que por ahora es la
 * fuente de verdad. Esta pantalla lo lee; más adelante el workflow del correo
 * llenará el cuadro y alimentará estos casos automáticamente.
 */
export class LibertadorController {
  /** GET /api/libertador/casos */
  async casos(_req: AuthRequest, res: Response): Promise<void> {
    // Sin cuadro configurado no es un error del servidor: es que falta un dato
    // de configuración. Se responde 503 con el motivo exacto para que la página
    // lo muestre tal cual en vez de un "algo salió mal".
    if (!cuadroDisponible()) {
      res.status(503).json({ message: motivoNoDisponible() });
      return;
    }
    try {
      res.json(await leerCasos());
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Error al leer el cuadro jurídico';
      res.status(502).json({ message });
    }
  }

  /**
   * POST /api/libertador/carpetas   (lo llama n8n; header x-n8n-secret)
   * body: { casos: [{ solicitud: string, procesos: string[] }] }
   *
   * Al llegar una asignación por correo, deja lista en Drive la carpeta de cada
   * solicitud ("<solicitud> <MES> <AÑO>" en DOCUMENTOS CLIENTES) con una
   * subcarpeta por proceso. Un proceso que no se reconoce no frena el caso: la
   * carpeta se crea igual y el proceso vuelve en `ignorados`.
   *
   * Responde 502 si falló alguna solicitud, para que la ejecución de n8n quede
   * en rojo; repetirla es seguro porque no duplica carpetas.
   */
  async carpetas(req: Request, res: Response): Promise<void> {
    if (!libertadorDriveDisponible()) {
      res.status(503).json({ message: 'Drive no está configurado en el backend (DRIVE_SA_KEY / DRIVE_IMPERSONATE_USER).' });
      return;
    }

    // Agrupado por solicitud: n8n manda una fila por proceso y un MIXTO trae la
    // misma solicitud dos o tres veces.
    const crudos = Array.isArray(req.body?.casos) ? (req.body.casos as unknown[]) : [];
    const porSolicitud = new Map<string, Set<ProcesoLibertador>>();
    const ignorados: { solicitud: string; proceso: string }[] = [];
    for (const c of crudos as { solicitud?: unknown; procesos?: unknown }[]) {
      const solicitud = String(c?.solicitud ?? '').trim();
      if (!solicitud) continue;
      const procesos = porSolicitud.get(solicitud) ?? new Set<ProcesoLibertador>();
      for (const p of Array.isArray(c.procesos) ? c.procesos : []) {
        const n = normalizarProceso(p);
        if (n) procesos.add(n);
        else ignorados.push({ solicitud, proceso: String(p ?? '') });
      }
      porSolicitud.set(solicitud, procesos);
    }
    if (!porSolicitud.size) {
      res.status(400).json({ message: 'No se recibió ninguna solicitud.' });
      return;
    }

    type Resultado = { solicitud: string; success: boolean; error?: string } & Partial<CarpetaCasoAsegurada>;
    const resultados = await enCola(async () => {
      const out: Resultado[] = [];
      for (const [solicitud, procesos] of porSolicitud) {
        try {
          out.push({ solicitud, success: true, ...(await asegurarCarpetaCaso(solicitud, [...procesos])) });
        } catch (e: unknown) {
          out.push({ solicitud, success: false, error: e instanceof Error ? e.message : 'error de Drive' });
        }
      }
      return out;
    });

    // Se avisa siempre: cada llamada es una asignación que llegó por correo, y la
    // oficina tiene que enterarse aunque las carpetas ya estuvieran listas.
    const ok = resultados.filter((r) => r.success);
    const fallidas = resultados.filter((r) => !r.success);
    const nuevas = ok.filter((r) => r.creada).length;
    const completadas = ok.filter((r) => !r.creada && r.subcarpetasCreadas?.length).length;
    const listas = ok.length - nuevas - completadas;
    const sols = resultados.map((r) => r.solicitud);
    const partes = [
      nuevas ? `${nuevas} carpeta(s) nueva(s)` : '',
      completadas ? `${completadas} con subcarpetas agregadas` : '',
      listas ? `${listas} ya estaba(n) lista(s)` : '',
    ].filter(Boolean);
    notificationHub.broadcast({
      type: 'generacion',
      level: fallidas.length || ignorados.length ? 'warning' : 'success',
      title: 'Asignación Libertador',
      message: `Llegó ${sols.length <= 5 ? `la solicitud ${sols.join(', ')}` : `${sols.length} solicitudes`}`
        + (partes.length ? `: ${partes.join(', ')}` : '')
        + (ignorados.length ? `. Tipo de proceso sin reconocer: ${ignorados.map((x) => `${x.solicitud} (${x.proceso})`).join(', ')}` : '')
        + (fallidas.length ? `. Fallaron: ${fallidas.map((r) => `${r.solicitud} (${r.error})`).join(', ')}` : '') + '.',
      meta: { solicitudes: sols },
    });

    res.status(fallidas.length ? 502 : 200).json({ success: !fallidas.length, resultados, ignorados });
  }

  /**
   * POST /api/libertador/estados-cuenta   body: { solicitudes: string[] }
   *
   * Pide los estados de cuenta de un conjunto de solicitudes. No cuelga de
   * ninguna asignación: en Libertador no hay lotes, la unidad es la solicitud, y
   * un mismo estado de cuenta sirve para TODOS los procesos de esa solicitud —
   * por eso se piden deduplicadas.
   *
   * Responde 202: el portal tarda minutos y el avance llega por notificación.
   */
  async estadosCuenta(req: AuthRequest, res: Response): Promise<void> {
    const crudas = Array.isArray(req.body?.solicitudes) ? (req.body.solicitudes as unknown[]) : [];
    const solicitudes = [...new Set(crudas.map((x) => String(x ?? '').trim()).filter(Boolean))];

    if (!solicitudes.length) {
      res.status(400).json({ message: 'No se recibió ninguna solicitud.' });
      return;
    }

    res.status(202).json({
      success: true,
      started: true,
      total: solicitudes.length,
      message: `Consultando ${solicitudes.length} estado(s) de cuenta en el portal. Te aviso al terminar.`,
    });

    void this.estadosCuentaBg(solicitudes);
  }

  /** Corre el lote contra el motor y reporta por notificación. No lanza. */
  private async estadosCuentaBg(solicitudes: string[]): Promise<void> {
    const t0 = Date.now();
    notificationHub.broadcast({
      type: 'generacion', level: 'info', title: 'Estados de cuenta',
      message: `Consultando ${solicitudes.length} solicitud(es) de Libertador en el portal…`,
      meta: { total: solicitudes.length },
    });

    try {
      // La plantilla vive en Drive y el motor no habla con Drive: se la bajamos
      // nosotros. Si no está, el lote sigue igual y devuelve los datos leídos,
      // solo que sin el Excel armado.
      let plantillaBase64: string | undefined;
      if (libertadorDriveDisponible()) {
        const plantilla = await bajarPlantillaEstadoCuenta().catch(() => null);
        if (plantilla) plantillaBase64 = plantilla.toString('base64');
        else notificationHub.broadcast({
          type: 'generacion', level: 'warning', title: 'Sin plantilla',
          message: 'No encontré "ESTADO DE CUENTA IA.xls" en LIBERTADOR/PLANTILLAS: se consultará el portal pero no se armará el Excel.',
          meta: {},
        });
      }

      const r = await engineService.estadosCuentaLibertador({ solicitudes, plantillaBase64 });

      // Cada omitida se avisa por separado: es la razón por la que la oficina no
      // verá ese estado de cuenta, y hay que poder actuar sobre ella.
      for (const item of r.resultados ?? []) {
        if (item.success) continue;
        notificationHub.broadcast({
          type: 'generacion',
          level: 'warning',
          title: item.omitido ? 'Solicitud omitida' : 'Solicitud fallida',
          message: `${item.solicitud}: ${item.motivo || item.error || 'el motor no pudo abrirla'}.`,
          meta: { solicitud: item.solicitud },
        });
      }

      // Subir cada Excel a la carpeta del caso en Drive, que es donde la oficina
      // lo busca. Un fallo de subida no tumba el lote: se avisa y sigue.
      let subidos = 0;
      for (const item of r.resultados ?? []) {
        if (!item.success || !item.archivoBase64) continue;
        try {
          const carpeta = await resolverCarpetaCaso(item.solicitud);
          if (!carpeta) {
            notificationHub.broadcast({
              type: 'generacion', level: 'warning', title: 'Sin carpeta en Drive',
              message: `${item.solicitud}: se generó el estado de cuenta pero no encontré su carpeta para guardarlo.`,
              meta: { solicitud: item.solicitud },
            });
            continue;
          }
          await subirArchivoCaso(
            carpeta.folderId,
            item.nombreArchivo || `ESTADO DE CUENTA ${item.solicitud}.xlsx`,
            Buffer.from(item.archivoBase64, 'base64'),
          );
          subidos++;
        } catch (e: unknown) {
          notificationHub.broadcast({
            type: 'generacion', level: 'warning', title: 'No se pudo guardar',
            message: `${item.solicitud}: ${e instanceof Error ? e.message : 'error al subir a Drive'}.`,
            meta: { solicitud: item.solicitud },
          });
        }
      }

      const ok = r.ok ?? 0;
      const omitidas = (r.resultados ?? []).filter((x) => x.omitido).length;
      const fallidas = (r.resultados ?? []).filter((x) => !x.success && !x.omitido).length;
      notificationHub.broadcast({
        type: 'generacion',
        level: ok ? 'success' : 'warning',
        title: 'Estados de cuenta',
        message: `${subidos} estado(s) de cuenta guardado(s) en Drive`
          + (ok !== subidos ? ` (${ok} consultada(s))` : '')
          + (omitidas ? `, ${omitidas} omitida(s)` : '')
          + (fallidas ? `, ${fallidas} con error` : '') + '.',
        meta: { ok, subidos, omitidas, fallidas },
      });
      console.error(`[LIB-ESTCTA] ${ok}/${solicitudes.length} en ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    } catch (e: unknown) {
      notificationHub.broadcast({
        type: 'generacion', level: 'error', title: 'Fallaron los estados de cuenta',
        message: e instanceof Error ? e.message : 'Error desconocido',
        meta: {},
      });
    }
  }
}
