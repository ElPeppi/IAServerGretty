/**
 * services/singular/excelEntrada.js — Parseo del Excel de entrada
 *
 * El Excel trae dos hojas:
 *   Hoja1 → datos maestros (cliente, ciudad, vehículos, fechas)
 *   Hoja2 → datos financieros (capital, intereses, obligaciones)
 * Se filtran los clientes con APLICATIVO = DECEVAL y se consolidan
 * los financieros de Hoja2 agrupados por cédula.
 */

'use strict';

const XLSX = require('xlsx');

const { toNum } = require('../../utils/numeros');

// ─── Helpers de columnas ──────────────────────────────────────────────────────

function normHeader(h) {
  return String(h || '').trim().toUpperCase().replace(/\s+/g, '_');
}

function buildIndex(headers) {
  const idx = {};
  headers.forEach((h, i) => {
    const n = normHeader(h);
    if (n) idx[n] = i;
  });
  return idx;
}

// Devuelve undefined si no se encuentra la columna
function getCol(row, idx, ...names) {
  for (const name of names) {
    const n = normHeader(name);
    if (idx[n] !== undefined) return row[idx[n]];
  }
  return undefined;
}

// ─── Ciudad ───────────────────────────────────────────────────────────────────

function extraerCiudad(ciudadStr) {
  const s = (ciudadStr || '').trim();
  // Formato habitual: "COTORRA (CORD)" → ciudad = COTORRA
  const m = s.match(/^([^(]+?)(?:\s*\([^)]*\))?$/);
  return (m ? m[1] : s).trim().toUpperCase();
}

// ─── Parseo principal ─────────────────────────────────────────────────────────

function parsearExcelEntrada(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', raw: true, cellDates: false });

  if (wb.SheetNames.length < 2) throw new Error('El Excel debe tener al menos 2 hojas (Hoja1 y Hoja2)');

  // ── Hoja1: datos maestros ─────────────────────────────────────────────────
  const ws1   = wb.Sheets[wb.SheetNames[0]];
  const hoja1 = XLSX.utils.sheet_to_json(ws1, { header: 1, raw: true, defval: '' });
  if (hoja1.length < 2) throw new Error('Hoja1 sin filas de datos');

  const h1 = buildIndex(hoja1[0]);

  // ── Hoja2: datos financieros ──────────────────────────────────────────────
  const ws2   = wb.Sheets[wb.SheetNames[1]];
  const hoja2 = XLSX.utils.sheet_to_json(ws2, { header: 1, raw: true, defval: '' });

  const h2 = buildIndex(hoja2[0] || []);

  // Agrupar Hoja2 por cédula
  const fin = {};
  for (let r = 1; r < hoja2.length; r++) {
    const row    = hoja2[r];
    const cedula = String(getCol(row, h2, 'CEDULA', 'IDENTIFICACION') ?? '').trim();
    if (!cedula) continue;

    const nombre  = String(getCol(row, h2, 'NOMBRE', 'NOMBRE_CLIENTE') ?? '').trim();
    const cap     = toNum(getCol(row, h2, 'CAPITAL'));
    // TOTAL_INTERES = intereses de mora acumulados (monto real a cobrar).
    // MORA puede estar en $0 cuando los intereses van bajo TOTAL_INTERES.
    // INTERES en Hoja2 a veces es la tasa nominal (~$1 o un número pequeño), NO el monto.
    const int     = toNum(getCol(row, h2, 'TOTAL_INTERES', 'MORA', 'INTERES'));
    const total   = toNum(getCol(row, h2, 'TOTAL'));
    const obl     = String(getCol(row, h2, 'OBLIGACION') ?? '').trim();
    const abo     = String(getCol(row, h2, 'ABOGADO') ?? '').trim();
    // MORA pura (sin TOTAL_INTERES) para determinar cuál obligación tiene más mora
    const moraAmt = toNum(getCol(row, h2, 'MORA'));

    if (!fin[cedula]) {
      fin[cedula] = {
        obligacion: obl, obligaciones: obl ? [obl] : [], capital: cap, interes: int, total, abogado: abo, nombre,
        // obligación con mayor mora (para calcular FECHA MORA)
        maxMoraObl: obl, maxMoraVal: moraAmt,
      };
    } else {
      // Múltiples obligaciones → acumular
      fin[cedula].capital  += cap;
      fin[cedula].interes  += int;
      fin[cedula].total    += total;
      if (!fin[cedula].nombre && nombre) fin[cedula].nombre = nombre;
      // Agregar obligación al listado (sin duplicados)
      if (obl && !fin[cedula].obligaciones.includes(obl)) fin[cedula].obligaciones.push(obl);
      // Actualizar obligación con mayor mora
      if (moraAmt > fin[cedula].maxMoraVal) {
        fin[cedula].maxMoraVal = moraAmt;
        fin[cedula].maxMoraObl = obl;
      }
    }
  }

  // ── Construir mapa obligacion → FECHA_INI_MORA_ACT desde Hoja1 ──────────
  // Permite encontrar la fecha de mora de la obligación con mayor mora.
  // Clave: numero de obligación (string). Valor: raw fecha (número serial o string).
  const oblFechaMap = {};
  for (let r = 1; r < hoja1.length; r++) {
    const row = hoja1[r];
    const obl = String(getCol(row, h1, 'OBLIGACION', 'NUMERO_OBLIGACION', 'NRO_OBLIGACION') ?? '').trim();
    if (!obl) continue;
    const fechaRaw = getCol(row, h1, 'FECHA_INI_MORA_ACT', 'FECHA INI MORA ACT');
    if (fechaRaw !== '' && fechaRaw !== undefined && fechaRaw !== null) {
      oblFechaMap[obl] = fechaRaw;
    }
  }

  // ── Filtrar Hoja1 por DECEVAL ─────────────────────────────────────────────
  // Usar un Set para evitar duplicados de cédula (si hay múltiples filas por cédula
  // con el mismo APLICATIVO=DECEVAL, sólo tomamos la primera aparición).
  const cedulas_vistas = new Set();
  const clientes = [];

  for (let r = 1; r < hoja1.length; r++) {
    const row = hoja1[r];
    const ap  = String(getCol(row, h1, 'APLICATIVO') ?? '').trim().toUpperCase();
    if (ap !== 'DECEVAL') continue;

    const cedula = String(getCol(row, h1, 'IDENTIFICACION', 'CEDULA') ?? '').trim();
    if (!cedula) continue;
    if (cedulas_vistas.has(cedula)) continue;
    cedulas_vistas.add(cedula);

    const ciudadRaw = String(getCol(row, h1, 'CIUDAD') ?? '').trim();
    const depto     = String(getCol(row, h1, 'DEPARTAMENTO') ?? '').trim().toUpperCase();

    // Nombre: intentar Hoja1 primero (col NOMBRE_CLIENTE), luego Hoja2 como respaldo
    const h1nombre = String(getCol(row, h1, 'NOMBRE_CLIENTE') ?? '').trim()
                  || String(getCol(row, h1, 'NOMBRE') ?? '').trim();

    // FECHA MORA: usar la fecha de la obligación con mayor mora.
    // Si hay un mapa oblacion→fecha (Hoja1 tiene col OBLIGACION), usar la obligación
    // con mayor mora de Hoja2. De lo contrario, usar FECHA_INI_MORA_ACT de esta fila.
    const finCliente = fin[cedula];
    let fechaMoraRaw = getCol(row, h1, 'FECHA_INI_MORA_ACT', 'FECHA INI MORA ACT') ?? '';
    if (finCliente?.maxMoraObl && oblFechaMap[finCliente.maxMoraObl] !== undefined) {
      // Existe un mapa de fechas en Hoja1 → usar la fecha de la obligación con más mora
      fechaMoraRaw = oblFechaMap[finCliente.maxMoraObl];
    }

    clientes.push({
      cedula,
      nombre: h1nombre || (finCliente?.nombre ?? ''),
      ciudad:       extraerCiudad(ciudadRaw),
      departamento: depto,
      empresa:      String(getCol(row, h1, 'EMPRESA') ?? '').trim(),
      nitEmpresa:   String(getCol(row, h1, 'CC_NIT', 'NIT') ?? '').trim(),
      cantVehiculos: toNum(getCol(row, h1, 'CANT_VS_NO_PRENDADOS', 'CANT VS NO PRENDADOS')),
      descrVehiculos: String(
        getCol(row, h1, 'DESCRP_VS_NO_PRENDADOS', 'DESCRP VS NO PRENDADOS', 'DESCRIPCION_VS_NO_PRENDADOS') ?? ''
      ).trim(),
      fechaMoraRaw,
      fechaDesembolsoRaw: getCol(row, h1, 'FECHA_DESEMBOLSO', 'FECHA DESEMBOLSO') ?? '',
      financieros: finCliente || null,
    });
  }

  return clientes;
}

module.exports = { parsearExcelEntrada };
