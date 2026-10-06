/**
 * cuadroJuridico.ts — Lee los casos de Libertador del CUADRO JURÍDICO (Sheets).
 *
 * Libertador no manda lotes: los casos entran de uno en uno y la oficina los
 * lleva en un Google Sheet ("CUADRO JURIDICO EL LIBERTADOR"), que hoy es la
 * fuente de verdad. Esta capa lo lee; no escribe nada.
 *
 * Dos trampas de ese cuadro, por eso no se mapea por posición ni a ciegas:
 *  - Los encabezados se REPITEN: "FECHA" ×8, "OBSERVACIONES" ×3, "MES GRAB" ×6.
 *    Se resuelve por nombre tomando la PRIMERA aparición, que es la que la
 *    oficina usa (p. ej. OBSERVACIONES = AA, no BJ ni BZ).
 *  - Tiene 19 pestañas de histórico. Solo interesa la de casos activos.
 *
 * Config (env):
 *   LIBERTADOR_CUADRO_ID    id del spreadsheet (el de la URL /d/<ID>/edit)
 *   LIBERTADOR_CUADRO_HOJA  pestaña a leer (por defecto "Activos")
 * Autenticación: la misma service account que el resto del Drive. El cuadro
 * tiene que estar compartido como Editor (o lector) con esa cuenta.
 */
import { google } from 'googleapis';

const SA_KEY = process.env.DRIVE_SA_KEY || '';
const CUADRO_ID = process.env.LIBERTADOR_CUADRO_ID || '';
const HOJA = process.env.LIBERTADOR_CUADRO_HOJA || 'Activos';

export interface CasoLibertador {
  solicitud: string;
  proceso: string;
  recibido: string;
  cedula: string;
  demandante: string;
  demandado: string;
  ciudad: string;
  canon: string;
  observaciones: string;
  documentacion: string;           // valor crudo de la columna "DOCUMENTACION COMPLETA"
  documentacionCompleta: boolean;  // normalizado: solo "SI" (en cualquier caja) cuenta
  fila: number; // nº de fila en el cuadro, para poder ir a verla
}

export function cuadroDisponible(): boolean {
  return !!(SA_KEY && CUADRO_ID);
}

/** Motivo concreto por el que no se puede leer, para decírselo al usuario. */
export function motivoNoDisponible(): string {
  if (!SA_KEY) return 'Falta DRIVE_SA_KEY: no hay credenciales de Google configuradas.';
  if (!CUADRO_ID) return 'Falta LIBERTADOR_CUADRO_ID en el .env del backend (el id del cuadro jurídico en Drive).';
  return 'El cuadro jurídico no está disponible.';
}

function sheets() {
  const auth = new google.auth.JWT({
    keyFile: SA_KEY,
    // Solo lectura: esta capa nunca escribe en el cuadro de la oficina.
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    // SIN impersonación, a propósito. Suplantar a servidor@ entra por delegación
    // de dominio, y Google valida los scopes contra lo autorizado en el Admin de
    // Workspace: allí solo está `auth/drive`, así que pedir `spreadsheets.readonly`
    // devuelve `unauthorized_client`. Autenticando como la propia service account
    // no hay delegación que validar y se conserva el scope de SOLO LECTURA.
    // A cambio, el cuadro tiene que estar COMPARTIDO con la service account.
  });
  return google.sheets({ version: 'v4', auth });
}

const norm = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim();

/** Índice de la PRIMERA columna cuyo encabezado coincide exactamente. */
function idxDe(headers: string[], nombre: string): number {
  return headers.findIndex((h) => h.toUpperCase() === nombre.toUpperCase());
}

export interface CuadroLeido {
  fuente: string;
  total: number;
  sinDocumentacion: number; // casos con "DOCUMENTACION COMPLETA" ≠ SI
  casos: CasoLibertador[];
}

/**
 * Devuelve los casos del cuadro. Una fila cuenta como caso si trae SOLICITUD;
 * el cuadro arrastra filas en blanco y de relleno que no son casos.
 */
export async function leerCasos(): Promise<CuadroLeido> {
  if (!cuadroDisponible()) throw new Error(motivoNoDisponible());

  const api = sheets();
  const meta = await api.spreadsheets.get({ spreadsheetId: CUADRO_ID });
  const titulo = meta.data.properties?.title || CUADRO_ID;

  const hojas = (meta.data.sheets ?? []).map((s) => s.properties?.title || '');
  if (!hojas.some((h) => h.toUpperCase() === HOJA.toUpperCase())) {
    throw new Error(`El cuadro "${titulo}" no tiene una pestaña "${HOJA}". Tiene: ${hojas.join(', ')}`);
  }

  const { data } = await api.spreadsheets.values.get({
    spreadsheetId: CUADRO_ID,
    range: `'${HOJA}'!A:CZ`,
  });
  const filas = data.values ?? [];
  if (filas.length < 2) return { fuente: titulo, total: 0, sinDocumentacion: 0, casos: [] };

  const headers = (filas[0] ?? []).map(norm);
  const i = {
    solicitud: idxDe(headers, 'SOLICITUD'),
    proceso: idxDe(headers, 'TIPO DE PROCESO'),
    recibido: idxDe(headers, 'RECIBIDO'),
    cedula: idxDe(headers, 'CEDULA'),
    demandante: idxDe(headers, 'DEMANDANTE'),
    demandado: idxDe(headers, 'DEMANDADO'),
    ciudad: idxDe(headers, 'CIUDAD'),
    canon: idxDe(headers, 'CANON'),
    observaciones: idxDe(headers, 'OBSERVACIONES'),
    documentacion: idxDe(headers, 'DOCUMENTACION COMPLETA'),
  };
  if (i.solicitud < 0) {
    throw new Error(`La pestaña "${HOJA}" no tiene columna SOLICITUD (encabezados en la fila 1).`);
  }

  const celda = (fila: unknown[], idx: number) => (idx >= 0 ? norm(fila[idx]) : '');

  const casos: CasoLibertador[] = [];
  for (let f = 1; f < filas.length; f++) {
    const fila = filas[f] ?? [];
    const solicitud = celda(fila, i.solicitud);
    if (!solicitud) continue; // fila de relleno, no un caso
    const documentacion = celda(fila, i.documentacion);
    casos.push({
      solicitud,
      proceso: celda(fila, i.proceso),
      recibido: celda(fila, i.recibido),
      cedula: celda(fila, i.cedula),
      demandante: celda(fila, i.demandante),
      demandado: celda(fila, i.demandado),
      ciudad: celda(fila, i.ciudad),
      canon: celda(fila, i.canon),
      observaciones: celda(fila, i.observaciones),
      documentacion,
      // En el cuadro hay 466 "SI", 140 vacías y un "Si" en minúscula: comparar
      // contra 'SI' a secas clasificaría ese último como pendiente. Vacío o
      // cualquier otra cosa = falta documentación.
      documentacionCompleta: documentacion.toUpperCase() === 'SI',
      fila: f + 1, // 1-based, como lo numera Sheets
    });
  }

  return {
    fuente: titulo,
    total: casos.length,
    sinDocumentacion: casos.filter((c) => !c.documentacionCompleta).length,
    casos,
  };
}
