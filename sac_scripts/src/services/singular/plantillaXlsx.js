/**
 * services/singular/plantillaXlsx.js — Construcción y llenado de la Plantilla Singular
 *
 *   construirFilas → arma la fila principal del cliente + filas extra de vehículos
 *   fillTemplate   → escribe las filas en la plantilla XLSX (Hoja1 + Hoja2)
 */

'use strict';

const XLSX = require('xlsx');
const fs   = require('fs');

const { parseAnyDate } = require('../../utils/fechas');
const { calcularCuantia, tipoJuzgado } = require('../../domain/cuantia');

// Columnas exactas del template (en orden)
const TEMPLATE_HEADERS = [
  'FECHA DE ASIGNACION',
  'TIPO DE JUZGADO',
  'CIUDAD DE JUZGADO',
  'CUANTIA',
  'OBLIGACION',
  'OBLIGACIONES',
  'IDENTIFICACION',
  'NOMBRE',
  'CAPITAL',
  'INTERES',
  'FECHA MORA',
  'FECHA DE SUSCRIPCION',
  'VALOR CUANTIA',
  'DIRECCION DE RESIDENCIA',
  'DIRECCION ELECTRONICA',
  'NIT EMPRESA TT',
  'NOMBRE EMPRESA TT',
  'DIRECCION ELECTRONICA EMPLEADOR',
  'PLACA',
  'SERVICIO',
  'CLASE',
  'MARCA',
  'LINEA',
  'MODELO',
  'COLOR',
  'SERIE',
  'MOTOR',
  'CHASIS',
  'TIPO DE CARROCERIA',
  'STRIA MCPAL\nTTOyTTE',
  'DIRECCION ELECTRONICA DEL TRANSITO',
];

function vehiculoRow(vehiculo) {
  const v = vehiculo || {};
  return {
    'PLACA':             v.placa   || '',
    'SERVICIO':          v.servicio || '',
    'CLASE':             v.clase   || '',
    'MARCA':             v.marca   || '',
    'LINEA':             v.linea   || '',
    'MODELO':            v.modelo  || '',
    'COLOR':             v.color   || '',
    'SERIE':             v.serie   || '',
    'MOTOR':             v.motor   || '',
    'CHASIS':            v.chasis  || '',
    'TIPO DE CARROCERIA': v.tipoCarroceria || '',
  };
}

function construirFilas(cliente, vehiculos, contactos, correoJuzgado, fechaAsig, cuantiaLabel, numeroPagare = '', courtInfo = {}) {
  const { cedula, nombre, ciudad, empresa, nitEmpresa, financieros } = cliente;
  const f = financieros || {};

  // Usar TOTAL de Hoja2 si está disponible; de lo contrario calcularlo
  const totalCuantia = f.total || calcularCuantia(f.capital, f.interes);
  const fechaMora    = parseAnyDate(cliente.fechaMoraRaw);
  const fechaSuscr   = parseAnyDate(cliente.fechaDesembolsoRaw);

  const tipoJ = tipoJuzgado(cuantiaLabel, courtInfo.hasSmallClaims, courtInfo.hasPromiscuo);

  // OBLIGACIONES: todas separadas por coma, o la única obligación repetida
  const obligacionesStr = (f.obligaciones && f.obligaciones.length > 1)
    ? f.obligaciones.join(', ')
    : (f.obligacion || '');

  // Fila principal (vehículo 1 o sin vehículo)
  const v0   = vehiculos[0] || {};
  const fila1 = {
    'FECHA DE ASIGNACION':  fechaAsig,
    'TIPO DE JUZGADO':      tipoJ,
    'CIUDAD DE JUZGADO':    ciudad,
    'CUANTIA':              cuantiaLabel,
    'OBLIGACION':           f.obligacion || '',
    'OBLIGACIONES':         obligacionesStr,
    'NUMERO PAGARE':        numeroPagare,
    'IDENTIFICACION':       cedula,
    'NOMBRE':               nombre,
    'CAPITAL':              f.capital   || 0,
    'INTERES':              f.interes   || 0,
    'FECHA MORA':           fechaMora,
    'FECHA DE SUSCRIPCION': fechaSuscr,
    'VALOR CUANTIA':        totalCuantia || '',
    'DIRECCION DE RESIDENCIA':        contactos.direccion || '',
    'DIRECCION ELECTRONICA':          contactos.email     || '',
    'NIT EMPRESA TT':                 nitEmpresa,
    'NOMBRE EMPRESA TT':              empresa,
    'DIRECCION ELECTRONICA EMPLEADOR': '',      // sin fuente disponible
    ...vehiculoRow(v0),
    'STRIA MCPAL\nTTOyTTE':                   '',
    'DIRECCION ELECTRONICA DEL TRANSITO':      correoJuzgado,
  };

  // Vehículos adicionales (2º, 3º, …) → van a la segunda hoja de la plantilla,
  // no debajo de la fila principal. Incluyen IDENTIFICACION + NOMBRE + vehículo.
  const extras = [];
  for (let i = 1; i < vehiculos.length; i++) {
    const filaExtra = {};
    TEMPLATE_HEADERS.forEach(h => { filaExtra[h] = ''; });
    filaExtra['IDENTIFICACION'] = cedula;
    filaExtra['NOMBRE']         = nombre;
    Object.assign(filaExtra, vehiculoRow(vehiculos[i]));
    extras.push(filaExtra);
  }

  return { main: fila1, extras };
}

// ─── Llenar template XLSX ─────────────────────────────────────────────────────

// Escribe `filas` en una hoja a partir de `startRow` (0-based).
// Lee los encabezados de la primera fila de la hoja para mapear columnas.
// Devuelve la siguiente fila disponible.
function writeRowsToSheet(ws, filas, startRow) {
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');

  // Leer encabezados desde la hoja
  const headerRow = {};
  for (let c = range.s.c; c <= range.e.c; c++) {
    const cell = ws[XLSX.utils.encode_cell({ r: range.s.r, c })];
    if (cell && cell.v !== undefined) headerRow[String(cell.v).trim()] = c;
  }

  // Fallback: orden por defecto de TEMPLATE_HEADERS
  const colMap = Object.keys(headerRow).length >= 5
    ? headerRow
    : Object.fromEntries(TEMPLATE_HEADERS.map((h, i) => [h, i]));

  const maxCol = Math.max(...Object.values(colMap), range.e.c);
  let nextRow  = startRow;

  for (const fila of filas) {
    for (const [header, colIdx] of Object.entries(colMap)) {
      const val = fila[header];
      if (val === undefined || val === '') continue;
      const cellAddr = XLSX.utils.encode_cell({ r: nextRow, c: colIdx });
      ws[cellAddr] = { v: val, t: typeof val === 'number' ? 'n' : 's' };
    }
    nextRow++;
  }

  ws['!ref'] = XLSX.utils.encode_range({
    s: { r: range.s.r, c: range.s.c },
    e: { r: nextRow - 1, c: maxCol },
  });

  return nextRow;
}

// Busca la PRIMERA fila realmente vacía después del header (no usar !ref
// directo: puede incluir celdas formateadas vacías del template y desplazar
// los datos al final).
function primeraFilaVacia(ws) {
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
  let startRow = range.s.r + 1; // fila 2 (0-indexed) = después del header
  for (let r = range.s.r + 1; r <= range.e.r + 1; r++) {
    const testCell = ws[XLSX.utils.encode_cell({ r, c: range.s.c })]
                  || ws[XLSX.utils.encode_cell({ r, c: range.s.c + 5 })];
    if (!testCell || testCell.v === undefined || testCell.v === '') {
      startRow = r;
      break;
    }
    startRow = r + 1;
  }
  return startRow;
}

// filasExtras: filas de vehículos adicionales (vehículo 2, 3, …) que van a
// la segunda hoja de la plantilla en lugar de debajo de la fila principal.
function fillTemplate(filasTodas, plantillaPath, filasExtras = []) {
  // Cargar plantilla; si no existe crear un workbook vacío con encabezados
  let wb, ws1;

  if (fs.existsSync(plantillaPath)) {
    const plantBuf = fs.readFileSync(plantillaPath);
    wb  = XLSX.read(plantBuf, { type: 'buffer' });
    ws1 = wb.Sheets[wb.SheetNames[0]];
  } else {
    console.error(`[PLANTILLA] No encontrada en ${plantillaPath}. Creando nueva.`);
    wb  = XLSX.utils.book_new();
    ws1 = XLSX.utils.aoa_to_sheet([TEMPLATE_HEADERS]);
    XLSX.utils.book_append_sheet(wb, ws1, 'Hoja1');
  }

  // ── Asegurar que las columnas OBLIGACIONES y NUMERO PAGARE existen ────────
  // Se insertan después de OBLIGACION si no están presentes.
  {
    const ensureCol = (ws, headerLabel, afterLabel) => {
      const range0 = XLSX.utils.decode_range(ws['!ref'] || 'A1');
      let found    = false;
      let afterCol = -1;
      for (let c = range0.s.c; c <= range0.e.c; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r: range0.s.r, c })];
        if (!cell) continue;
        const v = String(cell.v || '').trim().toUpperCase().replace(/\s+/g, ' ');
        if (v === headerLabel.toUpperCase()) { found = true; break; }
        if (v === afterLabel.toUpperCase())  afterCol = c;
      }
      if (found) return;
      const insertAt = afterCol >= 0 ? afterCol + 1 : range0.e.c + 1;
      for (let r = range0.s.r; r <= range0.e.r; r++) {
        for (let c = range0.e.c; c >= insertAt; c--) {
          const from = XLSX.utils.encode_cell({ r, c });
          const to   = XLSX.utils.encode_cell({ r, c: c + 1 });
          if (ws[from]) { ws[to] = ws[from]; delete ws[from]; }
        }
      }
      ws[XLSX.utils.encode_cell({ r: range0.s.r, c: insertAt })] = { v: headerLabel, t: 's' };
      ws['!ref'] = XLSX.utils.encode_range({
        s: range0.s, e: { r: range0.e.r, c: range0.e.c + 1 }
      });
    };

    ensureCol(ws1, 'OBLIGACIONES', 'OBLIGACION');
    ensureCol(ws1, 'NUMERO PAGARE', 'OBLIGACIONES');
  }

  // ── Hoja 1: una fila por cliente (primer vehículo + todos los datos) ──────
  writeRowsToSheet(ws1, filasTodas, primeraFilaVacia(ws1));

  // ── Hoja 2: vehículos adicionales (vehículo 2, 3, … de cada cliente) ─────
  if (filasExtras.length > 0) {
    let ws2;
    if (wb.SheetNames.length >= 2) {
      // Usar segunda hoja existente en la plantilla
      ws2 = wb.Sheets[wb.SheetNames[1]];
    } else {
      // Crear segunda hoja con los mismos encabezados
      ws2 = XLSX.utils.aoa_to_sheet([TEMPLATE_HEADERS]);
      XLSX.utils.book_append_sheet(wb, ws2, 'Hoja2');
    }

    writeRowsToSheet(ws2, filasExtras, primeraFilaVacia(ws2));
    console.error(`[PLANTILLA] Hoja2: ${filasExtras.length} vehículo(s) adicional(es) escritos`);
  }

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { TEMPLATE_HEADERS, construirFilas, fillTemplate };
