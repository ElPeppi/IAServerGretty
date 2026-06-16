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

// Umbrales de cuantía (valores definidos por el usuario)
const CUANTIA_MINIMA_MAX = 70_036_200;
const CUANTIA_MENOR_MAX  = 262_635_750;

function calcularCuantia(capital, interes) {
  return toNum(capital) + toNum(interes);
}

function tipoCuantia(total) {
  if (total <= CUANTIA_MINIMA_MAX) return 'MINIMA';
  if (total <= CUANTIA_MENOR_MAX)  return 'MENOR';
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
  CUANTIA_MINIMA_MAX,
  CUANTIA_MENOR_MAX,
  calcularCuantia,
  tipoCuantia,
  tipoJuzgado,
  normalizarTipoJuzgado,
};
