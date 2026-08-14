/**
 * Deduce la fecha de una asignación a partir de su NOMBRE de archivo, que es la
 * única fuente que traen los Excel de la oficina.
 *
 * Vive aparte del controller para que los scripts de mantenimiento
 * (`npm run db:fechas`) puedan reusarlo sin arrastrar Drive ni el motor.
 */

const MESES: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
  // Abreviaturas: los Excel de la oficina también vienen como "1 SEP 2025".
  ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6,
  jul: 7, ago: 8, sep: 9, sept: 9, set: 9, oct: 10, nov: 11, dic: 12,
};

// "11 DE JUNIO DE 2026", "31 MARZO 2026", "(30 ENERO 2026)", "10 julio 2026",
// "1 SEP 2025", "30 SEP2025" → Date. El "de" es opcional (los Excel de la oficina
// lo omiten) y el espacio entre mes y año también. null si no matchea.
export function fechaDesdeNombre(nombre: string): Date | null {
  const m = nombre
    .toLowerCase()
    .match(/(\d{1,2})\s+(?:de\s+)?([a-záéíóúñ]+)\.?\s*(?:de\s+)?(\d{4})/i);
  if (!m) return null;
  const dia = parseInt(m[1], 10);
  const mes = MESES[m[2].normalize('NFD').replace(/[̀-ͯ]/g, '')];
  const anio = parseInt(m[3], 10);
  if (!mes || dia < 1 || dia > 31) return null;
  return fechaCalendario(anio, mes, dia);
}

/**
 * Construye la fecha a MEDIODÍA UTC, no a medianoche local.
 *
 * `new Date(a, m, d)` crea medianoche en la zona del proceso: en el EC2 (UTC) eso
 * son las 00:00Z, que un navegador en Colombia (UTC-5) pinta como las 19:00 del
 * DÍA ANTERIOR. El mediodía UTC deja el mismo día calendario en cualquier zona
 * entre UTC-11 y UTC+11, así que se ve igual en el servidor y en un portátil.
 * También lo lee bien `fechaDMY`, que formatea con getDate() en hora local.
 */
export function fechaCalendario(anio: number, mes: number, dia: number): Date {
  return new Date(Date.UTC(anio, mes - 1, dia, 12, 0, 0));
}
