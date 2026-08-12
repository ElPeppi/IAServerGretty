/**
 * domain/cuantia.js — Reglas de cuantía y tipo de juzgado
 *
 * Umbrales legales colombianos para clasificar la cuantía de la demanda
 * y determinar el juzgado competente.
 *
 * NOTA: los valores de tipo de juzgado NO llevan la palabra "JUZGADO" —
 * la plantilla de demanda dice "JUEZ «TIPO_DE_JUZGADO» DE «CIUDAD»",
 * así que el valor correcto es p.ej. "CIVIL MUNICIPAL".
 */

'use strict';

const { toNum } = require('../utils/numeros');

// Umbrales de cuantía: se CALCULAN desde el SMMV (salario mínimo mensual vigente):
//   MÍNIMA → hasta 40 SMMV   |   MENOR → >40 y hasta 150 SMMV   |   MAYOR → más de 150
const SMMV_DEFAULT  = 1_750_905;   // valor por defecto (configurable desde el panel)
const FACTOR_MINIMA = 40;
const FACTOR_MENOR  = 150;

// Umbrales según el SMMV (usa el default si no llega uno válido).
function umbralesCuantia(smmv) {
  const s = toNum(smmv) || SMMV_DEFAULT;
  return { smmv: s, minimaMax: s * FACTOR_MINIMA, menorMax: s * FACTOR_MENOR };
}

// Compat: umbrales con el SMMV por defecto.
const CUANTIA_MINIMA_MAX = SMMV_DEFAULT * FACTOR_MINIMA;   // 40 SMMV
const CUANTIA_MENOR_MAX  = SMMV_DEFAULT * FACTOR_MENOR;    // 150 SMMV

function calcularCuantia(capital, interes) {
  return toNum(capital) + toNum(interes);
}

// total: capital+interés. smmv: opcional (configurable); por defecto SMMV_DEFAULT.
function tipoCuantia(total, smmv) {
  const { minimaMax, menorMax } = umbralesCuantia(smmv);
  if (total <= minimaMax) return 'MINIMA';
  if (total <= menorMax)  return 'MENOR';
  return 'MAYOR';
}

// Determina el tipo de juzgado según la cuantía y los tipos disponibles en la ciudad.
// Reglas:
//   MAYOR           → CIVIL DEL CIRCUITO
//   MINIMA / MENOR  → Pequeñas Causas (si existe) → Promiscuo (si no hay civil) → Civil Municipal
function tipoJuzgado(cuantia, hasSmallClaims = false, hasPromiscuo = false) {
  if (cuantia === 'MAYOR') return 'CIVIL DEL CIRCUITO';
  // MINIMA o MENOR: elegir el juzgado disponible según especialidad de la ciudad
  if (hasSmallClaims) return 'DE PEQUEÑAS CAUSAS Y COMPETENCIAS MÚLTIPLES';
  if (hasPromiscuo)   return 'PROMISCUO MUNICIPAL';
  return 'CIVIL MUNICIPAL';
}

/**
 * Tipo de juzgado del TRÁMITE DE PAGO DIRECTO (garantía mobiliaria, Ley 1676/2013).
 *
 * NO depende de la cuantía —la solicitud de aprehensión y entrega no la tiene—:
 * es CIVIL MUNICIPAL, o PROMISCUO MUNICIPAL en los municipios que no tienen juzgado
 * civil (regla del despacho, según lo que reporte la Rama Judicial de esa ciudad).
 * Tampoco va a Pequeñas Causas aunque la ciudad las tenga.
 */
function tipoJuzgadoPagoDirecto(hasPromiscuo = false) {
  return hasPromiscuo ? 'PROMISCUO MUNICIPAL' : 'CIVIL MUNICIPAL';
}

// Regla del despacho: la categoría municipal nunca se escribe "MUNICIPAL"
// a secas — siempre "CIVIL MUNICIPAL". Las especialidades explícitas
// (PROMISCUO, PEQUEÑAS CAUSAS) y el CIRCUITO se conservan tal cual.
// También elimina la palabra "JUZGADO" si llega desde otra fuente.
function normalizarTipoJuzgado(tipo) {
  let t = String(tipo || '').trim().toUpperCase().replace(/\s+/g, ' ');
  t = t.replace(/^JUZGADO\s+/, '').trim();
  if (!t) return 'CIVIL MUNICIPAL';
  if (t.includes('MUNICIPAL')
      && !t.includes('CIVIL')
      && !t.includes('PROMISCUO')
      && !t.includes('PEQUEÑAS') && !t.includes('PEQUENAS')) {
    return 'CIVIL MUNICIPAL';
  }
  return t;
}

module.exports = {
  SMMV_DEFAULT,
  CUANTIA_MINIMA_MAX,
  CUANTIA_MENOR_MAX,
  umbralesCuantia,
  calcularCuantia,
  tipoCuantia,
  tipoJuzgado,
  tipoJuzgadoPagoDirecto,
  normalizarTipoJuzgado,
};
