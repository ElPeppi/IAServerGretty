/**
 * estadoCuentaDesdePortal.js — Convierte los movimientos del portal en el
 * contrato mensual que espera la plantilla del estado de cuenta.
 *
 * El portal lista MOVIMIENTOS (un pago de la agencia, un abono del inquilino) y
 * la plantilla pide MESES. Las reglas salen de un estado de cuenta diligenciado
 * a mano por la oficina y de lo que ellos mismos confirmaron:
 *
 *  1. "Pgdo a la Agencia" es la DEUDA; "Pagos del Inquilino" son los ABONOS.
 *  2. La columna CONCEPTO dice a qué rubro va: 01 = canon, 02 = administración.
 *  3. El `Periodo` de un pago puede abarcar varios meses ("01/05/2026 a
 *     30/06/2026" = mayo y junio): el valor se reparte en partes iguales.
 *     Los abonos llegan con periodo "TD REIN", que no es ningún mes.
 *  4. Los abonos se aplican del mes MÁS VIEJO hacia adelante hasta dejarlo en
 *     cero; lo que sobre pasa al siguiente, y así hasta agotarlos. Cada rubro
 *     va por su lado: un abono de administración no cubre canon.
 *
 * Verificado contra la solicitud 5918715: deuda 9.470.590, abonos 2.317.082 y
 * saldo 7.153.508 — los tres idénticos a los que cierra el portal.
 */

'use strict';

// Concepto del portal → rubro de la plantilla. Lo que no esté aquí NO se
// adivina: se reporta, porque meterlo en el rubro equivocado descuadra el cuadro
// de liquidación sin que se note.
const RUBRO_POR_CONCEPTO = {
  '01': 'canon',
  '02': 'adm',
};

/** "$ 3,712,500" → 3712500. El portal usa coma de miles. */
function aNumero(v) {
  const s = String(v ?? '').replace(/[^0-9.,-]/g, '').replace(/,/g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

/** "01/05/2026" → Date (UTC). null si no es una fecha. */
function aFecha(dmy) {
  const m = String(dmy ?? '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
}

/** Clave de mes comparable y ordenable: "2026-05". */
const claveMes = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

/**
 * Meses que cubre un periodo "01/05/2026 a 30/06/2026" (ambos inclusive).
 * Un periodo sin fechas ("TD REIN") no cubre ninguno.
 */
function mesesDelPeriodo(periodo) {
  const fechas = String(periodo ?? '').match(/\d{1,2}\/\d{1,2}\/\d{4}/g) || [];
  const ini = aFecha(fechas[0]);
  if (!ini) return [];
  const fin = aFecha(fechas[1]) || ini;

  const meses = [];
  const cursor = new Date(Date.UTC(ini.getUTCFullYear(), ini.getUTCMonth(), 1));
  const tope = new Date(Date.UTC(fin.getUTCFullYear(), fin.getUTCMonth(), 1));
  // Guarda contra un periodo absurdo (fechas invertidas o basura): mejor devolver
  // lo poco que se entienda que colgarse en un bucle infinito.
  while (cursor <= tope && meses.length < 120) {
    meses.push(new Date(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return meses;
}

/** Rubro de un movimiento, o null si el concepto no está mapeado. */
function rubroDe(concepto) {
  const c = String(concepto ?? '').trim();
  return RUBRO_POR_CONCEPTO[c] ?? RUBRO_POR_CONCEPTO[c.padStart(2, '0')] ?? null;
}

/**
 * @param {Array<object>} movimientos  filas tal cual las devuelve el portal
 * @returns {{
 *   meses: Array<{fecha:Date, deuda:{canon:number,adm:number}, abono:{canon:number,adm:number}, saldo:{canon:number,adm:number}}>,
 *   totales: object, abonosSinAplicar: object, avisos: string[]
 * }}
 */
function construirMeses(movimientos) {
  const porMes = new Map();                       // "2026-05" → { fecha, deuda, abono, saldo }
  const abonoTotal = { canon: 0, adm: 0 };
  const avisos = [];

  const nuevoMes = (fecha) => ({
    fecha,
    deuda: { canon: 0, adm: 0 },
    abono: { canon: 0, adm: 0 },
    saldo: { canon: 0, adm: 0 },
  });

  for (const mov of movimientos || []) {
    const agencia = aNumero(mov['Pgdo a la Agencia']);
    const inquilino = aNumero(mov['Pagos del Inquilino']);
    if (!agencia && !inquilino) continue;

    const rubro = rubroDe(mov['Concepto']);
    if (!rubro) {
      avisos.push(`Concepto "${mov['Concepto']}" desconocido: $${agencia || inquilino} queda fuera del desglose (solo están mapeados 01=canon y 02=administración).`);
      continue;
    }

    if (inquilino) abonoTotal[rubro] += inquilino;
    if (!agencia) continue;

    const meses = mesesDelPeriodo(mov['Periodo']);
    if (!meses.length) {
      // Un pago a la agencia sin periodo legible no se puede imputar a ningún
      // mes. No se reparte a ojo: se deja fuera y se avisa, porque si no
      // descuadraría el total en silencio.
      avisos.push(`Movimiento con periodo ilegible ("${mov['Periodo']}"): $${agencia} queda fuera del desglose.`);
      continue;
    }

    const porCadaMes = agencia / meses.length;
    for (const f of meses) {
      const k = claveMes(f);
      if (!porMes.has(k)) porMes.set(k, nuevoMes(f));
      porMes.get(k).deuda[rubro] += porCadaMes;
    }
  }

  // Del más viejo al más nuevo: es el orden en que se aplican los abonos.
  const meses = [...porMes.values()].sort((a, b) => a.fecha - b.fecha);

  const restante = { ...abonoTotal };
  for (const rubro of ['canon', 'adm']) {
    for (const m of meses) {
      const aplica = Math.min(restante[rubro], m.deuda[rubro]);
      m.abono[rubro] = aplica;
      m.saldo[rubro] = m.deuda[rubro] - aplica;
      restante[rubro] -= aplica;
    }
  }

  const suma = (campo, rubro) => meses.reduce((s, m) => s + m[campo][rubro], 0);

  // Si sobra abono es que el inquilino pagó de más o falta deuda por listar: no
  // se inventa un mes para meterlo, se reporta.
  for (const rubro of ['canon', 'adm']) {
    if (restante[rubro] > 0) {
      avisos.push(`Quedaron $${Math.round(restante[rubro])} de abono de ${rubro} sin aplicar: los pagos superan la deuda listada.`);
    }
  }

  return {
    meses,
    totales: {
      deuda: { canon: suma('deuda', 'canon'), adm: suma('deuda', 'adm') },
      abono: { canon: suma('abono', 'canon'), adm: suma('abono', 'adm') },
      saldo: { canon: suma('saldo', 'canon'), adm: suma('saldo', 'adm') },
    },
    abonosSinAplicar: restante,
    avisos,
  };
}

module.exports = { construirMeses, mesesDelPeriodo, rubroDe, aNumero, aFecha, RUBRO_POR_CONCEPTO };
