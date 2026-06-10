/**
 * domain/cuantia.js — Reglas de cuantía y tipo de juzgado
 *
 * Umbrales legales colombianos para clasificar la cuantía de la demanda
 * y determinar el juzgado competente.
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
//   MAYOR           → JUZGADO CIVIL DEL CIRCUITO
//   MINIMA / MENOR  → Pequeñas Causas (si existe) → Promiscuo (si no hay civil) → Civil Municipal
function tipoJuzgado(cuantia, hasSmallClaims = false, hasPromiscuo = false) {
  if (cuantia === 'MAYOR') return 'JUZGADO CIVIL DEL CIRCUITO';
  // MINIMA o MENOR: elegir el juzgado disponible según especialidad de la ciudad
  if (hasSmallClaims) return 'JUZGADO CIVIL DE PEQUEÑAS CAUSAS';
  if (hasPromiscuo)   return 'JUZGADO PROMISCUO MUNICIPAL';
  return 'JUZGADO CIVIL MUNICIPAL';
}

module.exports = {
  CUANTIA_MINIMA_MAX,
  CUANTIA_MENOR_MAX,
  calcularCuantia,
  tipoCuantia,
  tipoJuzgado,
};
