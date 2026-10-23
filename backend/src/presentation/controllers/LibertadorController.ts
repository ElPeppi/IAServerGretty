import { Request, Response } from 'express';
import { leerCasos, cuadroDisponible, motivoNoDisponible } from '../../infrastructure/libertador/cuadroJuridico';
import { EngineService } from '../../infrastructure/services/EngineService';
import {
  libertadorDriveDisponible, bajarPlantillaEstadoCuenta, resolverCarpetaCaso, subirArchivoCaso,
  asegurarCarpetaCaso, normalizarProceso, ProcesoLibertador, CarpetaCasoAsegurada, mimeDeArchivo, leerArchivoCaso,
} from '../../infrastructure/storage/libertadorDrive';
import {
  Formulario, formularioActivo, configFormulario, leerFormulario, armarRespuesta, enviarFormulario, textoDelEnvio,
} from '../../infrastructure/libertador/formularioSolicitud';
import {
  RecepcionLibertador, registrarRecepcion, marcarCarpeta, marcarAnexos, marcarFormulario, listarRecibidas,
} from '../../infrastructure/libertador/solicitudesRecibidas';
import { notificationHub } from '../../infrastructure/services/NotificationHub';
import { AuthRequest } from '../middlewares/authMiddleware';

// Queda en la carpeta del caso con lo que se mandó a Bolívar (y cuándo). Además de
// servirle a la oficina, evita mandar dos veces el mismo formulario.
const REGISTRO_FORMULARIO = 'SOLICITUD DE DOCUMENTOS - FORMULARIO.txt';

// Tipo propio para los avisos del flujo de asignaciones: la página de Libertador
// se recarga con ellos, y así no se recarga con cada aviso de Finandina.
const TIPO_AVISO = 'libertador';

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
   * GET /api/libertador/recibidas
   * Las solicitudes que llegaron por correo en los últimos 60 días, con en qué va
   * cada paso automático (carpeta, anexos, formulario).
   */
  async recibidas(_req: AuthRequest, res: Response): Promise<void> {
    try {
      res.json({ solicitudes: await listarRecibidas() });
    } catch (error: unknown) {
      res.status(500).json({ message: error instanceof Error ? error.message : 'No se pudieron leer las solicitudes recibidas' });
    }
  }

  /**
   * POST /api/libertador/carpetas   (lo llama n8n; header x-n8n-secret)
   * body: { casos: [{ solicitud, procesos: string[], tipoAlistamiento?, estadoSiniestro?,
   *                   valorCanon?, valorDeuda?, asunto? }] }
   *
   * Al llegar una asignación por correo, deja lista en Drive la carpeta de cada
   * solicitud ("<solicitud> <MES> <AÑO>" en DOCUMENTOS CLIENTES) con una
   * subcarpeta por proceso. Un proceso que no se reconoce no frena el caso: la
   * carpeta se crea igual y el proceso vuelve en `ignorados`. Cada solicitud queda
   * registrada (libertador_solicitudes) para que la página la muestre al instante.
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
    const datosCorreo = new Map<string, Omit<RecepcionLibertador, 'solicitud' | 'procesos'>>();
    const ignorados: { solicitud: string; proceso: string }[] = [];
    const texto = (v: unknown) => String(v ?? '').trim() || undefined;
    const numero = (v: unknown) => Number(String(v ?? '').replace(/\D/g, '')) || undefined;
    for (const c of crudos as Record<string, unknown>[]) {
      const solicitud = String(c?.solicitud ?? '').trim();
      if (!solicitud) continue;
      const procesos = porSolicitud.get(solicitud) ?? new Set<ProcesoLibertador>();
      for (const p of Array.isArray(c.procesos) ? c.procesos : []) {
        const n = normalizarProceso(p);
        if (n) procesos.add(n);
        else ignorados.push({ solicitud, proceso: String(p ?? '') });
      }
      porSolicitud.set(solicitud, procesos);
      // Lo demás de la tabla del correo es opcional: solo sirve para mostrarlo.
      if (!datosCorreo.has(solicitud)) {
        datosCorreo.set(solicitud, {
          tipoAlistamiento: texto(c.tipoAlistamiento),
          estadoSiniestro: texto(c.estadoSiniestro),
          canon: numero(c.valorCanon ?? c.canon),
          deuda: numero(c.valorDeuda ?? c.deuda),
          asuntoCorreo: texto(c.asunto),
        });
      }
    }
    if (!porSolicitud.size) {
      res.status(400).json({ message: 'No se recibió ninguna solicitud.' });
      return;
    }

    const conFormulario = formularioActivo();
    for (const [solicitud, procesos] of porSolicitud) {
      await registrarRecepcion({ solicitud, procesos: [...procesos], ...datosCorreo.get(solicitud) }, conFormulario);
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

    for (const r of resultados) {
      if (!r.success) {
        await marcarCarpeta(r.solicitud, 'error', { detalle: r.error });
        continue;
      }
      await marcarCarpeta(r.solicitud, r.creada ? 'creada' : 'existente', {
        nombre: r.folderName,
        id: r.folderId,
        detalle: r.subcarpetasCreadas?.length ? `subcarpetas creadas: ${r.subcarpetasCreadas.join(', ')}` : undefined,
      });
    }

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
      type: TIPO_AVISO,
      level: fallidas.length || ignorados.length ? 'warning' : 'success',
      title: 'Asignación Libertador',
      message: `Llegó ${sols.length <= 5 ? `la solicitud ${sols.join(', ')}` : `${sols.length} solicitudes`}`
        + (partes.length ? `: ${partes.join(', ')}` : '')
        + (ignorados.length ? `. Tipo de proceso sin reconocer: ${ignorados.map((x) => `${x.solicitud} (${x.proceso})`).join(', ')}` : '')
        + (fallidas.length ? `. Fallaron: ${fallidas.map((r) => `${r.solicitud} (${r.error})`).join(', ')}` : '') + '.',
      meta: { solicitudes: sols },
    });

    res.status(fallidas.length ? 502 : 200).json({ success: !fallidas.length, resultados, ignorados });

    // Con la carpeta lista se bajan sus anexos (contrato, reconocimientos…) del
    // portal de Bolívar. Son minutos (dos portales, cada uno con su login): va
    // después de responder, para que n8n no se quede esperando, y avisa al terminar.
    const carpetasListas = new Map(ok.map((r) => [r.solicitud, r.folderId as string]));
    if (carpetasListas.size) void this.documentosBg(carpetasListas);
  }

  /**
   * Baja los anexos de cada solicitud y los deja en la raíz de su carpeta y, si
   * LIBERTADOR_FORM_URL está configurado, manda el formulario de solicitud de
   * documentos con los datos que el motor leyó del Huella. No lanza.
   */
  private async documentosBg(carpetas: Map<string, string>): Promise<void> {
    const solicitudes = [...carpetas.keys()];
    const conFormulario = formularioActivo();
    notificationHub.broadcast({
      type: TIPO_AVISO, level: 'info', title: 'Documentos Libertador',
      message: `Bajando los anexos de ${solicitudes.length <= 5 ? solicitudes.join(', ') : `${solicitudes.length} solicitudes`} del portal de Bolívar`
        + (conFormulario ? ' y enviando el formulario de solicitud de documentos…' : '…'),
      meta: { solicitudes },
    });

    try {
      const r = await engineService.documentosLibertador(solicitudes);
      const resumen: string[] = [];
      // La estructura del formulario se lee una sola vez por lote.
      let formulario: Promise<Formulario> | null = null;
      const obtenerFormulario = () => (formulario ??= leerFormulario(configFormulario().url));

      for (const item of r.resultados ?? []) {
        const folderId = carpetas.get(item.solicitud);
        if (!folderId) continue;
        const partes: string[] = [];

        if (item.success) {
          // Van a la raíz de la carpeta: son comunes a todos los procesos de la solicitud.
          let subidos = 0;
          const fallidos: string[] = [];
          for (const a of item.archivos ?? []) {
            try {
              await subirArchivoCaso(folderId, a.nombre, Buffer.from(a.base64, 'base64'), mimeDeArchivo(a.nombre));
              subidos++;
            } catch (e: unknown) {
              fallidos.push(a.nombre);
              notificationHub.broadcast({
                type: TIPO_AVISO, level: 'warning', title: 'No se pudo guardar',
                message: `${item.solicitud} / ${a.nombre}: ${e instanceof Error ? e.message : 'error al subir a Drive'}.`,
                meta: { solicitud: item.solicitud },
              });
            }
          }
          partes.push(item.archivos?.length ? `${subidos} documento(s)` : 'el portal no tiene anexos');
          if (!item.archivos?.length) await marcarAnexos(item.solicitud, 'sin_anexos', 0, item.motivo);
          else if (fallidos.length) await marcarAnexos(item.solicitud, 'error', subidos, `no se pudieron guardar: ${fallidos.join(', ')}`);
          else await marcarAnexos(item.solicitud, 'ok', subidos, item.archivos.map((a) => a.nombre).join(', '));
        } else {
          await marcarAnexos(item.solicitud, 'error', undefined, item.error || 'el motor no pudo bajarlos');
          notificationHub.broadcast({
            type: TIPO_AVISO, level: 'warning', title: 'Documentos sin bajar',
            message: `${item.solicitud}: ${item.error || 'el motor no pudo bajarlos'}.`,
            meta: { solicitud: item.solicitud },
          });
        }

        // El formulario no depende de los anexos, solo de lo leído en el Huella.
        // Sin `huella` el aviso de arriba ya dice por qué (no se abrió la solicitud).
        if (conFormulario && item.huella) {
          const f = await this.formularioCaso(item.solicitud, folderId, item.huella, obtenerFormulario);
          if (f) partes.push(f);
        } else if (conFormulario) {
          await marcarFormulario(item.solicitud, 'error', `no se leyeron sus datos en el Huella: ${item.error || 'sin detalle'}`);
        }
        if (partes.length) resumen.push(`${item.solicitud}: ${partes.join(', ')}`);
      }

      if (resumen.length) {
        notificationHub.broadcast({
          type: TIPO_AVISO, level: 'success', title: 'Documentos Libertador',
          message: `Guardados en Drive — ${resumen.join('; ')}.`,
          meta: { solicitudes },
        });
      }
    } catch (e: unknown) {
      const motivo = e instanceof Error ? e.message : 'Error desconocido';
      for (const s of solicitudes) {
        await marcarAnexos(s, 'error', undefined, motivo);
        if (conFormulario) await marcarFormulario(s, 'error', motivo);
      }
      notificationHub.broadcast({
        type: TIPO_AVISO, level: 'error', title: 'Fallaron los documentos de Libertador',
        message: motivo,
        meta: { solicitudes },
      });
    }
  }

  /**
   * Manda el formulario de solicitud de documentos de UNA solicitud, salvo que ya
   * se haya mandado a ese mismo formulario: lo enviado queda escrito en su carpeta
   * (REGISTRO_FORMULARIO), y n8n vuelve a disparar esto con cada correo de
   * asignación. Devuelve el fragmento para el resumen, o null si falló (ya avisado).
   */
  private async formularioCaso(
    solicitud: string,
    folderId: string,
    huella: { poliza: string; estado: string; ciudad: string; errores?: { ciudad?: string } },
    obtenerFormulario: () => Promise<Formulario>,
  ): Promise<string | null> {
    // Todo lo que falla se avisa Y queda en la página, con el mismo texto.
    const fallo = async (message: string) => {
      await marcarFormulario(solicitud, 'error', message);
      notificationHub.broadcast({
        type: TIPO_AVISO, level: 'warning', title: 'Formulario sin enviar',
        message: `${solicitud}: ${message}`, meta: { solicitud },
      });
    };
    const faltan = [
      !huella.poliza && 'la póliza',
      !huella.estado && 'el estado del siniestro',
      !huella.ciudad && `la ciudad del arrendatario${huella.errores?.ciudad ? ` (${huella.errores.ciudad})` : ''}`,
    ].filter(Boolean);
    if (faltan.length) {
      await fallo(`no leí del Huella ${faltan.join(', ')}.`);
      return null;
    }

    try {
      const form = await obtenerFormulario();
      const previo = (await leerArchivoCaso(folderId, REGISTRO_FORMULARIO))?.toString('utf8') || '';
      // El id del formulario va en el registro: lo enviado a la copia de prueba no
      // cuenta como enviado al de Bolívar.
      if (previo.includes(`(${form.id})`)) {
        await marcarFormulario(solicitud, 'ya_enviado', `ya estaba en ${REGISTRO_FORMULARIO}`);
        return 'formulario ya enviado antes';
      }

      const pares = armarRespuesta(form, { solicitud, ...huella });
      await enviarFormulario(form, pares);
      await marcarFormulario(solicitud, 'enviado', `póliza ${huella.poliza} · ${huella.estado} · ${huella.ciudad}`);
      try {
        const texto = `${previo}${previo ? '\n' : ''}${textoDelEnvio(form, pares)}`;
        await subirArchivoCaso(folderId, REGISTRO_FORMULARIO, Buffer.from(texto, 'utf8'), mimeDeArchivo(REGISTRO_FORMULARIO));
      } catch (e: unknown) {
        notificationHub.broadcast({
          type: TIPO_AVISO, level: 'warning', title: 'Formulario sin registro',
          message: `${solicitud}: el formulario SÍ se envió, pero no pude dejar el registro en su carpeta `
            + `(${e instanceof Error ? e.message : 'error de Drive'}). Si se vuelve a disparar, se mandaría otra vez.`,
          meta: { solicitud },
        });
      }
      return 'formulario enviado';
    } catch (e: unknown) {
      await fallo(e instanceof Error ? e.message : 'no se pudo enviar el formulario.');
      return null;
    }
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
