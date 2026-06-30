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
const { mapearColumnas } = require('./mapeoColumnas');

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

// ─── Información laboral (empresa + NIT) ─────────────────────────────────────

// Placeholders habituales de celdas "vacías" en los Excel de Finandina:
// "----", "#N/A", "#N/D", "N/A", "0"
function limpiarPlaceholder(v) {
  const s = String(v ?? '').trim();
  if (!s || /^[#\-–—\s.]*$/.test(s) || /^#?N\/?[AD]$/i.test(s) || s === '0') return '';
  return s;
}

// Valida y limpia un NIT: numérico de 6-11 dígitos, con o sin separadores de
// miles y dígito de verificación ("900.812.875-1" → "900812875").
function limpiarNit(v) {
  const s = limpiarPlaceholder(v);
  if (!s) return '';
  const m = s.replace(/[.\s,]/g, '').match(/^(\d{6,11})(?:-\d)?$/);
  return m ? m[1] : '';
}

// El NIT del empleador debe venir del Excel, pero el encabezado varía entre
// archivos (NIT, CC_NIT, SALARIO, ID EMPLEADOR… u otro nombre no estandarizado).
// Prioridad: mapeo canónico (heurística+Ollama) → columna a la izquierda de la
// empresa (por contenido) → nombres explícitos.
// (Algunos Excel repiten encabezados como CC_NIT al final con cédulas que NO son
// el NIT del empleador; el mapeo y la adyacencia son las señales confiables.)
function extraerNitEmpresa(row, idx, canon = {}) {
  // 1) Mapeo canónico
  if (canon.NIT_EMPLEADOR !== undefined) {
    const nit = limpiarNit(row[canon.NIT_EMPLEADOR]);
    if (nit) return nit;
  }
  // 2) Por contenido: columna a la izquierda de EMPRESA (NIT|EMPRESA, SALARIO|EMPRESA…)
  const empIdx = canon.NOMBRE_EMPRESA !== undefined ? canon.NOMBRE_EMPRESA : idx['EMPRESA'];
  if (empIdx !== undefined && empIdx > 0) {
    const nit = limpiarNit(row[empIdx - 1]);
    if (nit) return nit;
  }
  // 3) Columnas con nombre explícito
  for (const name of ['NIT_EMPRESA', 'NIT_EMPLEADOR', 'NIT', 'CC_NIT']) {
    const nit = limpiarNit(getCol(row, idx, name));
    if (nit) return nit;
  }
  // 4) Alias conocido: "SALARIO" trae el NIT en algunos archivos
  return limpiarNit(getCol(row, idx, 'SALARIO'));
}

// ─── Parseo principal ─────────────────────────────────────────────────────────

async function parsearExcelEntrada(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', raw: true, cellDates: false });

  if (wb.SheetNames.length < 2) throw new Error('El Excel debe tener al menos 2 hojas (Hoja1 y Hoja2)');

  // ── Hoja1: datos maestros ─────────────────────────────────────────────────
  const ws1   = wb.Sheets[wb.SheetNames[0]];
  const hoja1 = XLSX.utils.sheet_to_json(ws1, { header: 1, raw: true, defval: '' });
  if (hoja1.length < 2) throw new Error('Hoja1 sin filas de datos');

  const h1 = buildIndex(hoja1[0]);

  // ── Mapeo canónico de columnas de Hoja1 ──────────────────────────────────
  // Los encabezados cambian entre envíos; el mapeo (heurística + Ollama local)
  // identifica qué columna es cada campo. getCanon usa el mapeo primero y los
  // alias de nombre exacto como respaldo.
  let canon = {};
  try {
    canon = await mapearColumnas(hoja1[0], hoja1.slice(1));
  } catch (e) {
    console.error(`[MAPEO] Falló el mapeo de columnas (${e.message}) — se usan solo alias exactos`);
  }
  const getCanon = (row, campo, ...aliases) => {
    if (canon[campo] !== undefined) {
      const v = row[canon[campo]];
      if (v !== undefined && String(v).trim() !== '') return v;
    }
    return getCol(row, h1, ...aliases);
  };

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
    const abo     = String(getCol(row, h2, 'ABOGADO', 'ABOGADOS', 'ABOG') ?? '').trim();
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
    const obl = String(getCanon(row, 'OBLIGACION', 'OBLIGACION', 'NUMERO_OBLIGACION', 'NRO_OBLIGACION') ?? '').trim();
    if (!obl) continue;
    const fechaRaw = getCanon(row, 'FECHA_MORA', 'FECHA_INI_MORA_ACT', 'FECHA INI MORA ACT');
    if (fechaRaw !== '' && fechaRaw !== undefined && fechaRaw !== null) {
      oblFechaMap[obl] = fechaRaw;
    }
  }

  // ── Filtro por tipo de proceso: solo EJECUTIVO SINGULAR ───────────────────
  // El encabezado varía entre envíos ("POSIBLE PROCESO", "PROCESO", "TIPO DE
  // PROCESO"…) → se localiza la columna por contener "PROCESO". Una cédula se
  // genera si AL MENOS una de sus filas dice singular ("EJECUTIVO SINGULAR",
  // "EJECUTIVO SINGU", "SINGULAR"); se excluye si todas son de otro proceso
  // (RESTITUCIÓN, etc.). Si no hay columna de proceso, no se filtra (compat).
  const procesoIdx = (hoja1[0] || []).findIndex(h => /proceso/i.test(String(h || '')));
  const ES_SINGULAR = /singu/i;
  const omitidosProceso = [];
  const excluidasProceso = new Set();
  if (procesoIdx >= 0) {
    const conSingular = new Set();
    const conOtro = new Map(); // cedula → proceso (para el reporte)
    for (let r = 1; r < hoja1.length; r++) {
      const ced = String(getCanon(hoja1[r], 'IDENTIFICACION', 'IDENTIFICACION', 'CEDULA') ?? '').trim();
      if (!/^\d{5,12}$/.test(ced)) continue;
      const proc = String(hoja1[r][procesoIdx] ?? '').trim();
      if (!proc) continue;                       // celda vacía → neutral
      if (ES_SINGULAR.test(proc)) conSingular.add(ced);
      else if (!conOtro.has(ced)) conOtro.set(ced, proc);
    }
    for (const [ced, proc] of conOtro) {
      if (!conSingular.has(ced)) {
        excluidasProceso.add(ced);
        omitidosProceso.push({ cedula: ced, nombre: '', motivo: `proceso "${proc}" (no es ejecutivo singular)` });
      }
    }
    console.error(`[EXCEL] Proceso: columna "${hoja1[0][procesoIdx]}" — ${excluidasProceso.size} cédula(s) excluida(s) por no ser ejecutivo singular`);
  }

  // ── Candidatos: filas con cédula (de proceso ejecutivo singular) ──────────
  // La selección final del tipo de pagaré (DECEVAL/FINANDINA) se hace después
  // validando el pagaré (ver leerDatosDeDeceval + orquestador).
  // Set para evitar duplicados de cédula (solo la primera aparición).
  const cedulas_vistas = new Set();
  const clientes = [];

  for (let r = 1; r < hoja1.length; r++) {
    const row = hoja1[r];

    const cedula = String(getCanon(row, 'IDENTIFICACION', 'IDENTIFICACION', 'CEDULA') ?? '').trim();
    if (!cedula || !/^\d{5,12}$/.test(cedula)) continue;
    if (excluidasProceso.has(cedula)) continue;   // proceso ≠ ejecutivo singular
    if (cedulas_vistas.has(cedula)) continue;
    cedulas_vistas.add(cedula);

    const ciudadRaw = String(getCanon(row, 'CIUDAD', 'CIUDAD') ?? '').trim();
    const depto     = String(getCanon(row, 'DEPARTAMENTO', 'DEPARTAMENTO') ?? '').trim().toUpperCase();

    // Nombre: intentar Hoja1 primero, luego Hoja2 como respaldo
    const h1nombre = String(getCanon(row, 'NOMBRE', 'NOMBRE_CLIENTE', 'NOMBRE_DEUDOR', 'NOMBRE') ?? '').trim();

    // Dirección de residencia. Placeholders tipo "----" se tratan como vacío.
    const direccion = limpiarPlaceholder(
      getCanon(row, 'DIRECCION', 'DIRECCION', 'DIRECCION_RESIDENCIA', 'DIRECCION_DE_RESIDENCIA')
    );

    // ── Información laboral: el NIT es obligatorio para completarla ─────────
    // Coherencia: NIT y nombre de empresa van juntos a la demanda; si falta
    // cualquiera de los dos no se completa nada — regla del despacho.
    let nitEmpresa = extraerNitEmpresa(row, h1, canon);
    let empresa    = limpiarPlaceholder(
      getCanon(row, 'NOMBRE_EMPRESA', 'EMPRESA', 'NOMBRE_EMPRESA', 'NOMBRE_EMP')
    );
    if (!nitEmpresa || !empresa) { nitEmpresa = ''; empresa = ''; }

    // ── Inmueble: hay inmueble solo si la columna INM trae un valor real ────
    // ("----", "#N/A", vacío → sin inmueble → se quita la medida cautelar PRIMERO)
    const tieneInmueble = !!limpiarPlaceholder(
      getCanon(row, 'INMUEBLE', 'INM', 'INMUEBLE', 'INMUEBLES')
    );

    // ── Placas en columna separada (cuando no viene el detalle de vehículos) ─
    // Pueden venir varias separadas por coma/espacio. Se validan como placa
    // colombiana (3 letras + 3 dígitos, o 3 letras + 2 dígitos + letra en motos).
    const placasRaw = limpiarPlaceholder(getCanon(row, 'PLACA', 'PLACA', 'PLACAS'));
    const placas = placasRaw
      ? placasRaw.split(/[,;&\/\s]+/).map(p => p.trim().toUpperCase())
          .filter(p => /^[A-Z]{3}\d{2}[A-Z0-9]$/.test(p) || /^[A-Z]{3}\d{3}$/.test(p))
      : [];

    // FECHA MORA: usar la fecha de la obligación con mayor mora.
    // Si hay un mapa oblacion→fecha (Hoja1 tiene col OBLIGACION), usar la obligación
    // con mayor mora de Hoja2. De lo contrario, usar FECHA_INI_MORA_ACT de esta fila.
    const finCliente = fin[cedula];
    let fechaMoraRaw = getCanon(row, 'FECHA_MORA', 'FECHA_INI_MORA_ACT', 'FECHA INI MORA ACT') ?? '';
    if (finCliente?.maxMoraObl && oblFechaMap[finCliente.maxMoraObl] !== undefined) {
      // Existe un mapa de fechas en Hoja1 → usar la fecha de la obligación con más mora
      fechaMoraRaw = oblFechaMap[finCliente.maxMoraObl];
    }

    clientes.push({
      cedula,
      nombre: h1nombre || (finCliente?.nombre ?? ''),
      direccion,
      ciudad:       extraerCiudad(ciudadRaw),
      departamento: depto,
      empresa,
      nitEmpresa,
      tieneInmueble,
      cantVehiculos: toNum(getCanon(row, 'CANT_VEHICULOS', 'CANT_VS_NO_PRENDADOS', 'CANT VS NO PRENDADOS', 'CANT_VHS', 'CANT_VEHICULOS')),
      descrVehiculos: limpiarPlaceholder(
        getCanon(row, 'DETALLE_VEHICULOS', 'DESCRP_VS_NO_PRENDADOS', 'DESCRP VS NO PRENDADOS', 'DESCRIPCION_VS_NO_PRENDADOS', 'DETALLE_VHS', 'DETALLE')
      ),
      placas,
      fechaMoraRaw,
      fechaDesembolsoRaw: getCanon(row, 'FECHA_DESEMBOLSO', 'FECHA_DESEMBOLSO', 'FECHA DESEMBOLSO') ?? '',
      financieros: finCliente || null,
    });
  }

  // Adjuntar (como propiedad del array, sin romper clientes.length) las cédulas
  // excluidas por proceso, para que el orquestador las reporte como omitidas.
  clientes.omitidosProceso = omitidosProceso;
  return clientes;
}

module.exports = { parsearExcelEntrada };
