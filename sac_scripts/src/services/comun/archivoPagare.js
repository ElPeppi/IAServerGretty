/**
 * services/comun/archivoPagare.js — Qué PDF de la carpeta del cliente es el pagaré.
 *
 * Se decide por el NOMBRE (el contenido lo valida después carpetaCliente.js).
 * Formas reales vistas en Drive:
 *
 *   "{NOMBRE} PAGARE.pdf", "{NOMBRE} DECEVAL.pdf", "Pagaré.pdf"   ← dice qué es
 *   "{NOMBRE}.pdf" junto a "{NOMBRE} DATACREDITO.pdf"            ← ZIP del banco
 *                                                                   (lote nov-2026)
 *   "PAG.pdf"                                                     ← abreviatura de
 *                                                                   la oficina
 *
 * El ZIP del banco trae SIEMPRE el par certificado + DataCrédito con el mismo
 * nombre de persona. Hasta oct-2026 el certificado venía como "{NOMBRE}
 * DECEVAL.pdf"; desde el lote de nov-2026 viene como "{NOMBRE}.pdf" a secas y
 * ninguna demanda Deceval se generaba ("falta el pagaré").
 *
 * Nunca cuentan como pagaré los documentos que solo lo COPIAN: la demanda, los
 * anexos o los antecedentes que la oficina sube armados (traen el certificado
 * adentro), el poder, el DataCrédito ni los del SAC.
 *
 * Espejo en el backend: backend/src/infrastructure/storage/archivoPagare.ts
 * (el gate de generación). Si cambia la regla, cambiar los dos.
 */

'use strict';

/** Mayúsculas, sin tildes (NFC o NFD: Drive guarda de las dos) y sin espacios dobles. */
function normalizar(nombre) {
  return String(nombre).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/\s+/g, ' ').trim();
}

const NO_ES_PAGARE_RE = new RegExp([
  '^SAC_', '^CONTACTOS_', 'DATACREDITO',
  'FOR (?:EJE|INI)', 'PRENDA', 'TESTIGO',
  '^DEMANDA', '^ANEXO', '^ANTECEDENTE', '^PODER', 'OTORGAMIENTO PODER',
].join('|'));

/** PDF que nunca es el pagaré, aunque su texto lo cite. */
function noEsPagare(nombre) {
  return NO_ES_PAGARE_RE.test(normalizar(nombre));
}

/**
 * Prioridad del PDF como pagaré (1 = la mejor) o 0 si no lo es:
 *   1. el nombre lo dice (PAGARE / DECEVAL)
 *   2. es el compañero del DataCrédito ("{X}.pdf" con "{X} DATACREDITO.pdf")
 *   3. abreviatura "PAG.pdf"
 * `todos` = los nombres de la misma carpeta (para reconocer el par del banco).
 */
function prioridadPagare(nombre, todos = []) {
  const n = normalizar(nombre);
  if (!/\.PDF$/.test(n) || noEsPagare(nombre)) return 0;
  if (/PAGARE|DECEVAL/.test(n)) return 1;
  const base = n.replace(/\.PDF$/, '');
  const resto = new Set(todos.map(normalizar));
  if (resto.has(`${base} DATACREDITO.PDF`) || resto.has(`DATACREDITO ${base}.PDF`)) return 2;
  if (/^PAG\b/.test(n)) return 3;
  return 0;
}

/** PDFs candidatos a pagaré de una carpeta, el más probable primero. */
function pdfsPagare(nombres) {
  return nombres
    .map((f) => ({ f, p: prioridadPagare(f, nombres) }))
    .filter((x) => x.p > 0)
    .sort((a, b) => (a.p - b.p) || a.f.localeCompare(b.f))
    .map((x) => x.f);
}

module.exports = { normalizar, noEsPagare, prioridadPagare, pdfsPagare };
