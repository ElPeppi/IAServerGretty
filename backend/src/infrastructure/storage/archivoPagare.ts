/**
 * archivoPagare — qué PDF de la carpeta del cliente es el pagaré, por el NOMBRE.
 *
 * ESPEJO de sac_scripts/src/services/comun/archivoPagare.js: el backend decide con
 * esto si hay pagaré ANTES de llamar al motor (gate de generación), y el motor
 * elige con la misma regla el PDF que valida y anexa. Si cambia uno, cambiar el otro.
 *
 * Formas reales en Drive:
 *   "{NOMBRE} PAGARE.pdf", "{NOMBRE} DECEVAL.pdf", "Pagaré.pdf"  ← dice qué es
 *   "{NOMBRE}.pdf" junto a "{NOMBRE} DATACREDITO.pdf"           ← ZIP del banco
 *   "PAG.pdf"                                                    ← abreviatura de la oficina
 *
 * Desde el lote de nov-2026 el banco entrega el certificado Deceval como
 * "{NOMBRE}.pdf" a secas (antes "{NOMBRE} DECEVAL.pdf"): con la regla vieja
 * —el nombre debía decir PAGARE o DECEVAL— ninguna de esas demandas se generaba.
 */

/** Mayúsculas, sin tildes (NFC o NFD: Drive guarda de las dos) y sin espacios dobles. */
export function normalizarNombre(nombre: string): string {
  return String(nombre).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/\s+/g, ' ').trim();
}

// Documentos que solo COPIAN el pagaré (la demanda o los anexos armados lo traen
// adentro) o que nunca lo son.
const NO_ES_PAGARE_RE = new RegExp([
  '^SAC_', '^CONTACTOS_', 'DATACREDITO',
  'FOR (?:EJE|INI)', 'PRENDA', 'TESTIGO',
  '^DEMANDA', '^ANEXO', '^ANTECEDENTE', '^PODER', 'OTORGAMIENTO PODER',
].join('|'));

/**
 * Prioridad del PDF como pagaré (1 = la mejor) o 0 si no lo es:
 *   1. el nombre lo dice (PAGARE / DECEVAL)
 *   2. es el compañero del DataCrédito ("{X}.pdf" con "{X} DATACREDITO.pdf")
 *   3. abreviatura "PAG.pdf"
 * `todos` = los nombres de la misma carpeta (para reconocer el par del banco).
 */
export function prioridadPagare(nombre: string, todos: string[] = []): number {
  const n = normalizarNombre(nombre);
  if (!/\.PDF$/.test(n) || NO_ES_PAGARE_RE.test(n)) return 0;
  if (/PAGARE|DECEVAL/.test(n)) return 1;
  const base = n.replace(/\.PDF$/, '');
  const resto = new Set(todos.map(normalizarNombre));
  if (resto.has(`${base} DATACREDITO.PDF`) || resto.has(`DATACREDITO ${base}.PDF`)) return 2;
  if (/^PAG\b/.test(n)) return 3;
  return 0;
}

/** ¿Hay algún PDF que sea el pagaré entre estos nombres (de UNA carpeta)? */
export function hayPagare(nombres: string[]): boolean {
  return nombres.some((f) => prioridadPagare(f, nombres) > 0);
}
