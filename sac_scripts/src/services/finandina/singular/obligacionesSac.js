/**
 * services/finandina/singular/obligacionesSac.js — Obligaciones del cliente que
 * están en el SAC y no en el Excel de asignación.
 *
 * El SAC baja un PDF por cada obligación VIGENTE del cliente, con el número en
 * el nombre: SAC_{cedula}_OBL{número}.pdf (ver generarPDFsVigentes en
 * sac_puppeteer.js). Regla del despacho: el poder y la demanda citan las
 * obligaciones del Excel y, además, las del SAC que el Excel no trae.
 *
 * Solo se suman los NÚMEROS. Capital e intereses siguen saliendo del Excel (los
 * PDF del SAC no se leen para montos), así que esas obligaciones no entran en
 * la cuantía.
 */

'use strict';

const fs = require('fs');

const { resolverCarpetaCedula } = require('../../../utils/carpetas');

// "SAC_12345678_OBL9876543210.pdf" (alguno viejo con "_OBL_"). Si la fila del
// SAC no traía número, el archivo lleva el índice de la fila (0, 1, …): por eso
// se exigen al menos 4 dígitos.
const RE_ARCHIVO_OBL = /^SAC_(\d+)_OBL_?(\d{4,})\.pdf$/i;

// Para comparar números: solo dígitos y sin ceros a la izquierda.
const normNum = (v) => String(v ?? '').replace(/\D/g, '').replace(/^0+/, '');

/** Números de obligación de una cédula en una lista de nombres de archivo. */
function obligacionesDeArchivos(nombres, cedula) {
  const ced = normNum(cedula);
  const out = [];
  for (const nombre of nombres || []) {
    const m = String(nombre).match(RE_ARCHIVO_OBL);
    if (!m || (ced && normNum(m[1]) !== ced)) continue;
    if (!out.includes(m[2])) out.push(m[2]);
  }
  return out;
}

/** Obligaciones del SAC en la carpeta local del cliente (la que hidrata el backend). */
function obligacionesSacEnDisco(sacDocsDir, cedula) {
  let nombres;
  try {
    nombres = fs.readdirSync(resolverCarpetaCedula(sacDocsDir, cedula));
  } catch {
    return [];
  }
  return obligacionesDeArchivos(nombres, cedula);
}

/**
 * Copia de los financieros del cliente con las obligaciones del SAC que el Excel
 * no trae: `obligaciones` = las del Excel y luego las del SAC; `obligacionesSac`
 * = solo las agregadas. No toca montos ni `obligacion` (el respaldo del nº de
 * pagaré sigue siendo la del Excel).
 */
function agregarObligacionesSac(financieros, delSac) {
  const f = { ...(financieros || { capital: 0, interes: 0, total: 0, obligacion: '' }) };
  const base = f.obligaciones && f.obligaciones.length
    ? [...f.obligaciones]
    : (f.obligacion ? [f.obligacion] : []);
  const vistas = new Set(base.map(normNum));
  const agregadas = [];
  for (const o of delSac || []) {
    const k = normNum(o);
    if (!k || vistas.has(k)) continue;
    vistas.add(k);
    agregadas.push(String(o).trim());
  }
  f.obligaciones = [...base, ...agregadas];
  f.obligacionesSac = agregadas;
  return f;
}

module.exports = { obligacionesDeArchivos, obligacionesSacEnDisco, agregarObligacionesSac };
