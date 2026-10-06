/**
 * _evaluarHoja.js — Evaluador mínimo de fórmulas, SOLO para pruebas.
 *
 * La plantilla del estado de cuenta se llena con fórmulas (totales, saldos,
 * honorarios, IVA) y ni SheetJS ni esta máquina de desarrollo las calculan: el
 * archivo sale con los valores cacheados hasta que Excel lo abre. Sin algo que
 * las evalúe, "verificar" el resultado sería mirar números viejos.
 *
 * Cubre lo que esa plantilla usa y nada más: SUM(rango), referencias, + - * /,
 * paréntesis, porcentajes y números. Si aparece una fórmula que no entiende,
 * LANZA — antes eso que devolver un número inventado y dar por buena la prueba.
 *
 * No es una hoja de cálculo. No lo uses en producción.
 */

'use strict';

const XLSX = require('xlsx');

function celdasDeRango(ref) {
  const r = XLSX.utils.decode_range(ref);
  const out = [];
  for (let f = r.s.r; f <= r.e.r; f++) {
    for (let c = r.s.c; c <= r.e.c; c++) out.push(XLSX.utils.encode_cell({ r: f, c }));
  }
  return out;
}

/**
 * @param {object} ws  hoja de SheetJS
 * @returns {(addr:string)=>number}  valor calculado de una celda
 */
function evaluador(ws) {
  const cache = new Map();
  const enCurso = new Set();

  function valor(addr) {
    if (cache.has(addr)) return cache.get(addr);
    if (enCurso.has(addr)) throw new Error(`Referencia circular en ${addr}`);

    const cel = ws[addr];
    let v;
    if (!cel) v = 0;
    else if (cel.f) {
      enCurso.add(addr);
      v = evaluar(cel.f, addr);
      enCurso.delete(addr);
    } else if (typeof cel.v === 'number') v = cel.v;
    else v = 0;  // texto en una celda numérica cuenta como 0, igual que Excel

    cache.set(addr, v);
    return v;
  }

  function evaluar(formula, origen) {
    let expr = String(formula).trim().replace(/^=/, '');

    // SUM(A1:B2) → la suma ya resuelta, para no tener que parsear rangos después.
    expr = expr.replace(/SUM\(([A-Z]+\d+):([A-Z]+\d+)\)/gi, (_, a, b) =>
      '(' + (celdasDeRango(`${a}:${b}`).reduce((s, c) => s + valor(c), 0)) + ')');

    // SUM(1+2) y SUM(A1,B2): formas sueltas que también aparecen.
    expr = expr.replace(/SUM\(([^()]*)\)/gi, (_, dentro) =>
      '(' + dentro.split(',').map((t) => t.trim()).filter(Boolean).join('+') + ')');

    // Referencias sueltas → su valor.
    expr = expr.replace(/\$?([A-Z]{1,2})\$?(\d{1,5})/g, (todo) => String(valor(todo.replace(/\$/g, ''))));

    // 25% → 0.25
    expr = expr.replace(/(\d+(?:\.\d+)?)%/g, (_, n) => String(Number(n) / 100));

    if (!/^[-+*/().\d\s]+$/.test(expr)) {
      throw new Error(`Fórmula no soportada en ${origen}: "${formula}" → "${expr}"`);
    }
    // eslint-disable-next-line no-new-func
    const n = Function(`"use strict";return (${expr});`)();
    if (!Number.isFinite(n)) throw new Error(`Fórmula no numérica en ${origen}: "${formula}"`);
    return n;
  }

  return valor;
}

module.exports = { evaluador };
