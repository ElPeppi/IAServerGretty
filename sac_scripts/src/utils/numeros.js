/**
 * utils/numeros.js — Conversión y formateo de montos
 */

'use strict';

// Convierte cualquier valor a número; texto con símbolos ($, puntos, comas) incluido.
function toNum(val) {
  if (typeof val === 'number') return val;
  return parseFloat(String(val || '').replace(/[^0-9.]/g, '')) || 0;
}

// Formato moneda colombiana sin decimales: 11116596 → "11.116.596"
function fmtCOP(val) {
  const n = typeof val === 'number' ? val : parseFloat(String(val || '').replace(/[^0-9.]/g, '')) || 0;
  return n.toLocaleString('es-CO', { maximumFractionDigits: 0 });
}

module.exports = { toNum, fmtCOP };
