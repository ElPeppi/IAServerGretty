/**
 * rutas — convención de carpetas de la oficina (espejo del NAS), relativa a la raíz
 * del storage (DRIVE_ROOT_FOLDER_ID = "DOCUMENTOS ACTUALIZADOS 2019", o DOCS_DIR).
 *
 * Reusa los MISMOS nombres que el motor (sac_scripts/src/config.js):
 *   DEMANDAS/{BANCO}/ASIGNACION/{AÑO}                    ← buzón de asignaciones (entrada)
 *   DEMANDAS/{BANCO}/{PROCESO}/GARANTIAS                 ← demandas generadas ({cedula}/...)
 *   DEMANDAS/{BANCO}/{PROCESO}/PODERES                   ← poderes
 *
 * {PROCESO} = "EJECUTIVAS SINGULARES" o "GARANTIA MOBILIARIAS" (pago directo):
 * cada proceso tiene su propio árbol, no se mezclan.
 *
 * La RUTA codifica el banco y el año. Al LEER (recorrer el árbol) se sacan de la
 * carpeta; al ESCRIBIR (subir por web / guardar demanda) se DERIVAN del contenido:
 * el año de la fecha/nombre, el banco de EMPRESA/NIT/APLICATIVO (no hay columna
 * "BANCO"). Hoy la oficina solo trabaja FINANDINA; `detectarBanco` es el único
 * punto a extender para más bancos (o para enchufar el LLM del motor si se quiere
 * matching difuso).
 */

export const RAIZ_DEMANDAS = 'DEMANDAS';
export const BANCO_DEFAULT = process.env.BANCO_DEFAULT || 'FINANDINA';

// Bancos conocidos: keyword (sobre EMPRESA/NIT/APLICATIVO) → nombre de carpeta.
// Agregar aquí nuevos bancos. El orden importa (primer match gana).
const BANCOS: Array<{ re: RegExp; carpeta: string }> = [
  { re: /finandina/i, carpeta: 'FINANDINA' },
  // { re: /bbva/i, carpeta: 'BBVA' },
  // { re: /bancolombia/i, carpeta: 'BANCOLOMBIA' },
];

/** Nombres de banco (carpetas) conocidos. Sirve para validar/recorrer el árbol. */
export function bancosConocidos(): string[] {
  return [...new Set([BANCO_DEFAULT, ...BANCOS.map((b) => b.carpeta)])];
}

/**
 * Deriva el banco de una asignación a partir de sus filas. Mira EMPRESA/APLICATIVO/
 * NIT (no hay columna "BANCO"). Si nada matchea, cae al BANCO_DEFAULT.
 */
export function detectarBanco(filas: Array<Record<string, unknown>>): string {
  for (const fila of filas) {
    const blob = `${fila['EMPRESA'] ?? ''} ${fila['APLICATIVO'] ?? ''} ${fila['NIT'] ?? ''} ${fila['BANCO'] ?? ''}`;
    for (const b of BANCOS) if (b.re.test(blob)) return b.carpeta;
  }
  return BANCO_DEFAULT;
}

/** Año (carpeta) de la asignación: de la fecha, si no del nombre, si no el actual. */
export function detectarAnio(fecha: Date | null | undefined, nombre?: string): string {
  if (fecha && !isNaN(fecha.getTime())) return String(fecha.getFullYear());
  const m = String(nombre || '').match(/\b(20\d{2})\b/);
  return m ? m[1] : String(new Date().getFullYear());
}

const baseBanco = (banco: string) => `${RAIZ_DEMANDAS}/${banco}`;

/**
 * Cada tipo de proceso tiene su PROPIO árbol dentro del banco, con la misma forma
 * (GARANTIAS/{cédula}, PODERES/{año}, PLANTILLAS). Así lo tiene la oficina:
 *   DEMANDAS/FINANDINA/EJECUTIVAS SINGULARES/…   ← ejecutivo singular
 *   DEMANDAS/FINANDINA/GARANTIA MOBILIARIAS/…    ← trámite de pago directo
 */
export const CARPETA_PROCESO = {
  singular: 'EJECUTIVAS SINGULARES',
  pago_directo: 'GARANTIA MOBILIARIAS',
} as const;

export type Proceso = keyof typeof CARPETA_PROCESO;

const baseProceso = (banco: string, proceso: Proceso) =>
  `${baseBanco(banco)}/${CARPETA_PROCESO[proceso]}`;

/** Buzón de asignaciones de un banco/año: DEMANDAS/{banco}/ASIGNACION/{año}.
 *  Es común a todos los procesos: el Excel del banco los trae mezclados. */
export const carpetaAsignaciones = (banco: string, anio: string): string =>
  `${baseBanco(banco)}/ASIGNACION/${anio}`;

/** Carpeta de las demandas generadas: DEMANDAS/{banco}/{proceso}/GARANTIAS. */
export const carpetaGarantias = (banco: string, proceso: Proceso = 'singular'): string =>
  `${baseProceso(banco, proceso)}/GARANTIAS`;

/** Carpeta de los poderes: DEMANDAS/{banco}/{proceso}/PODERES. */
export const carpetaPoderes = (banco: string, proceso: Proceso = 'singular'): string =>
  `${baseProceso(banco, proceso)}/PODERES`;

/** Une segmentos en un relPath posix, ignorando vacíos y barras sobrantes. */
export function unir(...partes: Array<string | undefined | null>): string {
  return partes
    .filter((p): p is string => !!p)
    .map((p) => p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
}
