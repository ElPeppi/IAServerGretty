/**
 * utils/numeros.js — Conversión y formateo de montos
 */

'use strict';

/**
 * Convierte cualquier valor a número, entendiendo el formato colombiano:
 * el PUNTO separa miles y la COMA los decimales ("$ 6.080.541,50 M.C" → 6080541.5).
 *
 * OJO con la versión anterior: hacía `parseFloat("6.080.541")`, que se detiene en
 * el segundo punto y devuelve 6.08 → la demanda salía con "$6" de capital en vez
 * de "$6.080.541". Solo se notaba cuando el monto llegaba como TEXTO (si el Excel
 * lo da como número, `typeof val === 'number'` lo dejaba pasar intacto).
 */
function toNum(val) {
  if (typeof val === 'number') return isFinite(val) ? val : 0;

  // Se conservan dígitos, separadores y el signo; fuera "$", "M.C", espacios…
  let s = String(val ?? '').replace(/[^0-9.,-]/g, '').trim();
  if (!s) return 0;

  const negativo = s.startsWith('-');
  s = s.replace(/-/g, '');

  // Separadores que NO están entre dígitos son ruido, no parte del número: el
  // punto de "M.C" en "$ 6.080.541 M.C" hacía que el monto se leyera como 6.08.
  s = s.replace(/(?<!\d)[.,]|[.,](?!\d)/g, '');

  if (s.includes(',')) {
    // Hay coma → es el separador decimal; los puntos son de miles.
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (s.includes('.')) {
    // Solo puntos: son de miles si TODOS los grupos tras el primero tienen 3
    // dígitos ("6.080.541" → 6080541). Si no, el punto es decimal ("6.08" → 6.08).
    const partes = s.split('.');
    const milesValidos = partes.length > 1 && partes.slice(1).every((p) => /^\d{3}$/.test(p));
    if (milesValidos) s = partes.join('');
  }

  const n = parseFloat(s);
  if (!isFinite(n)) return 0;
  return negativo ? -n : n;
}

// Formato moneda colombiana sin decimales: 11116596 → "11.116.596"
function fmtCOP(val) {
  return toNum(val).toLocaleString('es-CO', { maximumFractionDigits: 0 });
}

module.exports = { toNum, fmtCOP };
