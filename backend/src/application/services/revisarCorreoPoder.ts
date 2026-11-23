/**
 * Revisión del correo del poder ANTES de lanzar una generación.
 *
 * El correo (ANEXO 1) es la impresión de Gmail del mensaje del banco: el motor le
 * escribe ENCIMA el poder de cada cliente. Dos cosas salían mal:
 *   - se elegía un PDF que no es el correo (el Word de los poderes que se manda al
 *     banco: mismo nombre de asignación y fecha) → el ANEXO 1 de TODAS las demandas
 *     salía con dos poderes montados. Eso se BLOQUEA aquí, con el motivo.
 *   - el correo traía el cuerpo sin borrar (saludo, firma, avisos legales) → ya no se
 *     bloquea: el motor lo tapa solo. Solo se avisa.
 *
 * Si el motor no responde, NO se bloquea: la revisión es una ayuda, no un requisito.
 */
import type { IEngineService } from './IEngineService';

export interface ResultadoRevisionCorreo {
  bloqueo?: { codigo: string; message: string };
  aviso?: string;
}

export async function revisarCorreoPoder(engine: IEngineService, pdf: Buffer): Promise<ResultadoRevisionCorreo> {
  try {
    const r = await engine.revisarCorreoPoder(pdf);
    if (r.estado === 'no_es_correo') {
      return {
        bloqueo: {
          codigo: 'CORREO_NO_VALIDO',
          message: `No se puede usar ese PDF como ANEXO 1: ${r.mensaje || 'no es el correo del banco'}.`,
        },
      };
    }
    if (r.estado === 'con_texto') {
      return { aviso: 'El correo del poder traía el texto del mensaje debajo del encabezado: se limpia solo al armar el ANEXO 1.' };
    }
    return {};
  } catch (e) {
    console.error('[correo-poder] no se pudo revisar el correo (se sigue sin revisar):', e instanceof Error ? e.message : e);
    return {};
  }
}
