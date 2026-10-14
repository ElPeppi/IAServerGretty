/**
 * services/comun/excelEntrada.js — Parseo del Excel de entrada
 *
 * El Excel trae:
 *   Hoja1 → datos maestros (cliente, ciudad, vehículos, fechas)
 *   otra hoja → datos financieros por OBLIGACIÓN (capital, intereses), que se
 *               consolidan por cédula. Cuál es se decide por sus encabezados
 *               (ver hojaFinanciera): hasta sept-2026 era la Hoja2
 *               "OBLIGACIONES"; desde oct-2026 la Hoja2 es un consolidado por
 *               deudor sin nº de obligación y el detalle va en la Hoja3
 *               "OBLIGACIONES LIQUIDADAS".
 * Se filtran los clientes por tipo de proceso (ver columnaProceso).
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
// "----", "#N/A", "#N/D", "N/A", "0", y desde oct-2026 el texto "NULL"
function limpiarPlaceholder(v) {
  const s = String(v ?? '').trim();
  if (!s || /^[#\-–—\s.]*$/.test(s) || /^#?N\/?[AD]$/i.test(s) || s === '0' || /^NULL$/i.test(s)) return '';
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

// ─── Hoja financiera ──────────────────────────────────────────────────────────

// Encabezado reducido a letras y dígitos sin tildes, para reconocerlo aunque el
// banco cambie mayúsculas, tildes o signos: "N° Obligación" → "N OBLIGACION",
// "Cédula/NIT" → "CEDULA NIT".
function claveEncabezado(h) {
  return String(h ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

// Columnas de la hoja financiera (sobre claveEncabezado). Cada campo es una lista
// EN ORDEN DE PREFERENCIA: gana la primera que exista aunque venga vacía en una
// fila, igual que getCol con los alias del formato viejo.
const COLS_FIN = {
  cedula:     [/^CEDULA$/, /^IDENTIFICACION$/, /^ID$/, /^ID CLIENTE$/, /^CEDULA NIT$/],
  obligacion: [/^OBLIGACION$/, /^(N|NO|NRO|NUMERO) OBLIGACION$/],
  nombre:     [/^NOMBRE$/, /^NOMBRE CLIENTE$/, /^NOMBRBE CLIENTE$/, /^NOMBRE TITULAR$/],
  capital:    [/^CAPITAL$/, /^CAPITAL EXIGIBLE$/],
  total:      [/^TOTAL$/, /^TOTAL OBLIGACION\b/],
  abogado:    [/^ABOGADOS?$/, /^ABOG$/],
  fechaMora:  [/^FECHA INICIO MORA$/],
  // Formato viejo: TOTAL_INTERES = intereses de mora acumulados (monto real a
  // cobrar); MORA puede estar en $0 cuando van bajo TOTAL_INTERES; INTERES a
  // veces es la tasa nominal (~$1), NO el monto → va de último.
  interes:    [/^TOTAL INTERES$/, /^MORA$/, /^INTERES$/],
  mora:       [/^MORA$/],
  // Formato oct-2026: los intereses vienen partidos y se SUMAN. Regla del
  // despacho: interés = corriente + moratorio.
  interesCorriente: [/^INTERES(ES)? CORRIENTES?$/],
  interesMora:      [/^(SUBTOTAL )?INTERES(ES)? MORATORIOS?\b/],
};

function indiceCol(claves, patrones) {
  for (const re of patrones) {
    const i = claves.findIndex(k => re.test(k));
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * Hoja con el detalle financiero POR OBLIGACIÓN. Se busca por encabezados entre
 * las hojas que siguen a la maestra, no por posición: en oct-2026 el banco puso
 * en la Hoja2 un consolidado por deudor (sin nº de obligación) y movió el
 * detalle a la Hoja3. Exige cédula y (obligación o capital); si hay varias, gana
 * la que trae nº de obligación.
 */
function hojaFinanciera(wb) {
  let mejor = null;
  for (let i = 1; i < wb.SheetNames.length; i++) {
    const filas  = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[i]], { header: 1, raw: true, defval: '' });
    const claves = (filas[0] || []).map(claveEncabezado);
    const col = {};
    for (const [campo, patrones] of Object.entries(COLS_FIN)) col[campo] = indiceCol(claves, patrones);
    if (col.cedula < 0 || (col.obligacion < 0 && col.capital < 0)) continue;
    const puntaje = (col.obligacion >= 0 ? 2 : 0) + (col.capital >= 0 ? 1 : 0);
    if (!mejor || puntaje > mejor.puntaje) mejor = { nombre: wb.SheetNames[i], filas, col, puntaje };
  }
  return mejor;
}

/**
 * Financieros agrupados por cédula, de la hoja financiera:
 *   fin[cedula] = { obligacion, obligaciones[], capital, interes, total, abogado,
 *                   nombre, maxMoraObl, maxMoraVal }
 * y fechaPorObligacion[obligacion] = fecha de inicio de mora, si la hoja la trae.
 */
function leerFinancieros(wb) {
  const fin = {};
  const fechaPorObligacion = {};
  const hoja = hojaFinanciera(wb);
  if (!hoja) {
    console.error('[EXCEL] Ninguna hoja trae el detalle financiero (cédula + obligación/capital): sin capital, intereses ni obligaciones');
    return { fin, fechaPorObligacion };
  }

  const { col } = hoja;
  const val = (row, campo) => (col[campo] >= 0 ? row[col[campo]] : undefined);
  const interesPartido = col.interesCorriente >= 0 || col.interesMora >= 0;
  console.error(`[EXCEL] Hoja financiera: "${hoja.nombre}"${interesPartido ? ' (interés = corriente + moratorio)' : ''}`);

  for (let r = 1; r < hoja.filas.length; r++) {
    const row    = hoja.filas[r];
    const cedula = String(val(row, 'cedula') ?? '').trim();
    if (!cedula) continue;

    const nombre  = String(val(row, 'nombre') ?? '').trim();
    const cap     = toNum(val(row, 'capital'));
    const int     = interesPartido
      ? toNum(val(row, 'interesCorriente')) + toNum(val(row, 'interesMora'))
      : toNum(val(row, 'interes'));
    const total   = toNum(val(row, 'total'));
    const obl     = String(val(row, 'obligacion') ?? '').trim();
    const abo     = String(val(row, 'abogado') ?? '').trim();
    // Monto de mora de esta obligación, para saber cuál lleva más (→ FECHA MORA)
    const moraAmt = toNum(val(row, interesPartido ? 'interesMora' : 'mora'));
    const fechaMora = val(row, 'fechaMora');
    if (obl && fechaMora !== undefined && fechaMora !== '') fechaPorObligacion[obl] = fechaMora;

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
  return { fin, fechaPorObligacion };
}

// ─── Tipo de proceso ──────────────────────────────────────────────────────────

// Encabezados con "PROCESO" que NO dicen el proceso de la asignación: estados y
// conteos de procesos anteriores ("EST PROCESO ACT", "Estados_Procesos",
// "No_Procesos_Activos", "Consolidado_Procesos", "MACRO PROCESO FUTURE",
// "PROCESOS ACTIVOS"…).
const NO_ES_PROCESO = /^EST[\s_]|ESTADO|^NO[\s_]|CONSOLIDADO|MACRO|ACTIVOS|INACTIVOS/i;

/**
 * Columna del tipo de proceso de la asignación. El encabezado cambia entre
 * envíos ("POSIBLE PROCESO", "PROCESO INICIAL", "PROCESO MAYO"…): "POSIBLE
 * PROCESO" si está; si no, la primera con "PROCESO" que no sea de estado/conteo.
 * Antes se tomaba la primera con "PROCESO" a secas, y desde oct-2026 esa es
 * "EST PROCESO ACT" (con "TERMINAdo"): excluía a esos clientes y dejaba de
 * separar singular de pago directo. Devuelve -1 si no hay.
 */
function columnaProceso(encabezados) {
  const hs = (encabezados || []).map(h => String(h || '').trim().toUpperCase());
  const posible = hs.indexOf('POSIBLE PROCESO');
  if (posible >= 0) return posible;
  return hs.findIndex(h => /PROCESO/.test(h) && !NO_ES_PROCESO.test(h));
}

// ─── Parseo principal ─────────────────────────────────────────────────────────

/**
 * Procesos que sabe filtrar el parser. `re` se prueba contra el valor crudo de la
 * columna de proceso del Excel ("EJECUTIVO SINGU", "TRAMIT PAGO DIR", …).
 */
const PROCESOS = {
  singular:     { re: /singu/i,             etiqueta: 'ejecutivo singular' },
  pago_directo: { re: /pago\s*dir|tramit/i, etiqueta: 'trámite de pago directo' },
};

/**
 * @param {Buffer} buffer  Excel de la asignación (Hoja1 + Hoja2)
 * @param {{proceso?: 'singular'|'pago_directo'}} [opts]  proceso a conservar
 *        (por defecto `singular`, que es como se comportaba antes).
 */
async function parsearExcelEntrada(buffer, opts = {}) {
  const PROC = PROCESOS[opts.proceso] || PROCESOS.singular;
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

  // ── Hoja financiera: capital, intereses y obligaciones por cédula ─────────
  const { fin, fechaPorObligacion } = leerFinancieros(wb);

  // ── Construir mapa obligacion → FECHA_INI_MORA_ACT desde Hoja1 ──────────
  // Permite encontrar la fecha de mora de la obligación con mayor mora.
  // Clave: numero de obligación (string). Valor: raw fecha (número serial o string).
  // Base: la fecha de inicio de mora de la hoja financiera (formato oct-2026);
  // la de Hoja1 manda cuando están las dos.
  const oblFechaMap = { ...fechaPorObligacion };
  for (let r = 1; r < hoja1.length; r++) {
    const row = hoja1[r];
    const obl = String(getCanon(row, 'OBLIGACION', 'OBLIGACION', 'NUMERO_OBLIGACION', 'NRO_OBLIGACION') ?? '').trim();
    if (!obl) continue;
    const fechaRaw = getCanon(row, 'FECHA_MORA', 'FECHA_INI_MORA_ACT', 'FECHA INI MORA ACT');
    if (fechaRaw !== '' && fechaRaw !== undefined && fechaRaw !== null) {
      oblFechaMap[obl] = fechaRaw;
    }
  }

  // ── Filtro por tipo de proceso ────────────────────────────────────────────
  // Columna: ver columnaProceso. Una cédula pasa si AL MENOS una de sus filas es
  // del proceso pedido; se excluye si todas son de otro. Celda vacía, placeholder
  // ("NULL", "----") o "SIN PROCESO" = neutral. Si no hay columna de proceso, no
  // se filtra (compat).
  const procesoIdx = columnaProceso(hoja1[0]);
  const omitidosProceso = [];
  const excluidasProceso = new Set();
  if (procesoIdx >= 0) {
    const conProceso = new Set();
    const conOtro = new Map(); // cedula → proceso (para el reporte)
    for (let r = 1; r < hoja1.length; r++) {
      const ced = String(getCanon(hoja1[r], 'IDENTIFICACION', 'IDENTIFICACION', 'CEDULA') ?? '').trim();
      if (!/^\d{5,12}$/.test(ced)) continue;
      const proc = limpiarPlaceholder(hoja1[r][procesoIdx]);
      if (!proc || /^SIN PROCESO$/i.test(proc)) continue;   // vacío → neutral
      if (PROC.re.test(proc)) conProceso.add(ced);
      else if (!conOtro.has(ced)) conOtro.set(ced, proc);
    }
    for (const [ced, proc] of conOtro) {
      if (!conProceso.has(ced)) {
        excluidasProceso.add(ced);
        omitidosProceso.push({ cedula: ced, nombre: '', motivo: `proceso "${proc}" (no es ${PROC.etiqueta})` });
      }
    }
    console.error(`[EXCEL] Proceso: columna "${hoja1[0][procesoIdx]}" — ${excluidasProceso.size} cédula(s) excluida(s) por no ser ${PROC.etiqueta}`);
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
      // Vehículo dado en GARANTÍA (pago directo / garantía mobiliaria). El Excel
      // del banco trae "CHEVROLET ONIX" en GARANTIA (marca + línea) y el AÑO en
      // MODELO. No son campos del esquema canónico: se leen por nombre exacto.
      garantia:      limpiarPlaceholder(getCol(row, h1, 'GARANTIA', 'GARANTIAS', 'VEHICULO')),
      modeloVehiculo: limpiarPlaceholder(getCol(row, h1, 'MODELO', 'MODELO_VEHICULO', 'ANIO_MODELO')),
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
