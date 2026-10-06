/**
 * plantillaXlsx.js — Escribe el estado de cuenta sobre la plantilla de la oficina.
 *
 * Por qué no se usa SheetJS aquí, como en el resto del proyecto: su versión libre
 * NO escribe estilos. Al guardar se perdían el logo, los colores, los bordes y
 * los formatos de número (las fechas salían como 46143 y los montos sin separador),
 * y encima ignora `fullCalcOnLoad`, así que los totales quedaban en el valor
 * cacheado —cero— aunque las fórmulas estuvieran bien. Comprobado renderizando el
 * resultado: la hoja salía en blanco y negro y con el TOTAL en "$ -".
 *
 * ExcelJS sí conserva estilos, imágenes y combinaciones, y sabe insertar filas
 * copiando el formato de la de encima.
 *
 * La plantilla de la oficina es .xls (BIFF), que ExcelJS no lee: se convierte a
 * .xlsx con LibreOffice, que la respeta entera. El servidor ya lo tiene.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const ExcelJS = require('exceljs');

// ─── Disposición de la plantilla ──────────────────────────────────────────────
const FILA_MES_INI = 11;   // primer mes
const FILA_MES_FIN = 16;   // último mes que trae de fábrica (6 filas)
const FILA_TOTAL = 17;     // fila "TOTAL"
const ULT_COL = 23;        // W

const COL = {
  mes: 1,                  // A
  deuda: { canon: 2, adm: 3 },    // B, C
  abono: { canon: 9, adm: 10 },   // I, J
  saldo: { canon: 17, adm: 18 },  // Q, R
};

/** Serial de Excel (sistema 1900): días desde el 1899-12-30. */
function serialExcel(d) {
  return Math.round((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
    - Date.UTC(1899, 11, 30)) / 86400000);
}

const letra = (c) => {
  let s = '';
  let n = c;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
};

// ─── LibreOffice ──────────────────────────────────────────────────────────────

function rutaSoffice() {
  const candidatos = [
    process.env.SOFFICE_PATH,
    'C:/Program Files/LibreOffice/program/soffice.exe',
    'C:/Program Files (x86)/LibreOffice/program/soffice.exe',
    '/usr/bin/soffice',
    '/usr/bin/libreoffice',
    '/opt/libreoffice/program/soffice',
  ].filter(Boolean);
  for (const c of candidatos) { if (fs.existsSync(c)) return c; }
  return null;
}

function ejecutar(cmd, args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${path.basename(cmd)}: ${err.message} ${stderr || ''}`.trim()));
      else resolve(String(stdout || ''));
    });
  });
}

/**
 * Devuelve la plantilla como .xlsx. Si ya lo es, tal cual; si es .xls, la
 * convierte con LibreOffice y CACHEA el resultado al lado, porque convertir
 * tarda segundos y la plantilla es la misma para todo el lote.
 */
async function asegurarXlsx(plantillaPath) {
  if (/\.xlsx$/i.test(plantillaPath)) return plantillaPath;

  const cache = plantillaPath.replace(/\.xls$/i, '.convertida.xlsx');
  if (fs.existsSync(cache) && fs.statSync(cache).mtimeMs >= fs.statSync(plantillaPath).mtimeMs) return cache;

  const soffice = rutaSoffice();
  if (!soffice) {
    throw new Error('La plantilla viene en .xls y no hay LibreOffice para convertirla. '
      + 'Instálalo o indica su ruta en SOFFICE_PATH.');
  }

  const salida = fs.mkdtempSync(path.join(os.tmpdir(), 'plantilla-'));
  await ejecutar(soffice, ['--headless', '--norestore', '--convert-to', 'xlsx', '--outdir', salida, plantillaPath]);
  const generado = fs.readdirSync(salida).find((f) => /\.xlsx$/i.test(f));
  if (!generado) throw new Error('LibreOffice no produjo el .xlsx de la plantilla.');

  fs.copyFileSync(path.join(salida, generado), cache);
  try { fs.rmSync(salida, { recursive: true, force: true }); } catch { /* da igual */ }
  return cache;
}

// ─── Escritura ────────────────────────────────────────────────────────────────

/** Reescribe las referencias de fila >= `desde` de una fórmula, sumándoles `n`. */
function correrReferencias(formula, desde, n) {
  if (!formula || n <= 0) return formula;
  return formula.replace(/(\$?)([A-Z]{1,2})(\$?)(\d{1,5})/g, (todo, d1, col, d2, fila) => {
    const f = Number(fila);
    return f >= desde ? `${d1}${col}${d2}${f + n}` : todo;
  });
}

/**
 * Llena la plantilla y devuelve el .xlsx en Buffer.
 *
 * Si el caso tiene más meses de los que trae la plantilla, se AMPLÍA: se insertan
 * filas copiando el formato de la última de fábrica, y el TOTAL, la liquidación y
 * el detalle de pagos bajan con sus fórmulas corregidas.
 *
 * @param {object} resultado  lo que devuelve construirMeses()
 * @param {string} plantillaPath  "ESTADO DE CUENTA IA.xls" (o .xlsx) en blanco
 * @param {object} datos  { solicitud, elaboro?, fechaElaboracion?, ocupado? }
 */
async function escribirPlantilla(resultado, plantillaPath, datos = {}) {
  if (!fs.existsSync(plantillaPath)) throw new Error(`Plantilla no encontrada: ${plantillaPath}`);
  const meses = resultado.meses || [];
  if (!meses.length) throw new Error('No hay meses que escribir: el estado de cuenta vendría vacío.');

  const xlsx = await asegurarXlsx(plantillaPath);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsx);
  const ws = wb.getWorksheet('Formato') || wb.worksheets[0];

  const ultimaFilaMes = FILA_MES_INI + meses.length - 1;
  const extra = Math.max(0, ultimaFilaMes - FILA_MES_FIN);

  // 1. Hacer sitio. duplicateRow copia el formato de la fila de encima, así que
  //    los meses añadidos salen con los mismos bordes y colores que los de fábrica.
  if (extra > 0) {
    ws.duplicateRow(FILA_MES_FIN, extra, true);
    // ExcelJS no reajusta las fórmulas de lo que empujó hacia abajo. Se recorre la
    // hoja ENTERA, no solo lo que bajó: el "TOTAL DEUDA" del encabezado (K7) vive
    // arriba pero suma el bloque de liquidación, que sí se movió. `correrReferencias`
    // solo toca referencias de la fila 17 en adelante, así que pasar por las filas
    // de mes es inofensivo.
    ws.eachRow({ includeEmpty: false }, (fila) => {
      fila.eachCell({ includeEmpty: false }, (celda) => {
        if (!celda.formula) return;
        // `result` en undefined hace que ExcelJS DESCARTE la celda: la fórmula
        // desaparecía de la hoja (Capital y Honorarios salían en blanco).
        const previo = typeof celda.result === 'number' ? celda.result : 0;
        celda.value = { formula: correrReferencias(celda.formula, FILA_TOTAL, extra), result: previo };
      });
    });
  }
  const filaTotal = FILA_TOTAL + extra;

  // 2. Encabezado. El rótulo y el valor comparten celda, como se diligencia a mano.
  const texto = (addr, v) => { if (v) ws.getCell(addr).value = v; };
  texto('B7', datos.solicitud ? `SOLICITUD: ${datos.solicitud}` : null);
  texto('A6', datos.elaboro ? `Elaboro : ${datos.elaboro}` : null);
  texto('D6', datos.fechaElaboracion ? `Fecha de elaboración: ${datos.fechaElaboracion}` : null);
  texto('I6', datos.ocupado ? `OCUPADO: ${datos.ocupado}` : null);

  // 3. Meses.
  meses.forEach((m, i) => {
    const f = FILA_MES_INI + i;
    const fila = ws.getRow(f);
    fila.getCell(COL.mes).value = serialExcel(m.fecha);
    fila.getCell(COL.deuda.canon).value = m.deuda.canon;
    fila.getCell(COL.deuda.adm).value = m.deuda.adm;
    fila.getCell(COL.abono.canon).value = m.abono.canon;
    fila.getCell(COL.abono.adm).value = m.abono.adm;
    // El saldo es fórmula de la plantilla; en las filas duplicadas apunta a la
    // fila original, así que se reescribe siempre.
    fila.getCell(COL.saldo.canon).value = { formula: `B${f}-I${f}`, result: m.saldo.canon };
    fila.getCell(COL.saldo.adm).value = { formula: `C${f}-J${f}`, result: m.saldo.adm };
    fila.commit();
  });

  // 4. Limpiar las filas de fábrica que sobren (caso con menos de 6 meses): si no,
  //    quedarían contando en el total.
  for (let f = FILA_MES_INI + meses.length; f <= FILA_MES_FIN; f++) {
    const fila = ws.getRow(f);
    for (const c of [COL.mes, COL.deuda.canon, COL.deuda.adm, COL.abono.canon, COL.abono.adm]) {
      fila.getCell(c).value = null;
    }
    fila.getCell(COL.saldo.canon).value = { formula: `B${f}-I${f}`, result: 0 };
    fila.getCell(COL.saldo.adm).value = { formula: `C${f}-J${f}`, result: 0 };
    fila.commit();
  }

  // 5. Los TOTALES se rehacen enteros. La plantilla trae 18 de sus 22 sumando solo
  //    hasta la fila 15 aunque los meses llegan a la 16 —incluidos los abonos—, así
  //    que un mes extra quedaba fuera del total sin que se notara.
  // Cada total lleva su valor ya calculado además de la fórmula: dejarlo en
  // `undefined` hacía que ExcelJS descartara la celda entera (el TOTAL
  // desaparecía de la hoja), y un valor correcto hace que el archivo se lea bien
  // aunque quien lo abra no recalcule.
  const t = resultado.totales || { deuda: {}, abono: {}, saldo: {} };
  const totalDe = {
    [COL.deuda.canon]: t.deuda.canon || 0,
    [COL.deuda.adm]: t.deuda.adm || 0,
    [COL.abono.canon]: t.abono.canon || 0,
    [COL.abono.adm]: t.abono.adm || 0,
    [COL.saldo.canon]: t.saldo.canon || 0,
    [COL.saldo.adm]: t.saldo.adm || 0,
  };
  for (let c = 2; c <= ULT_COL; c++) {
    const celda = ws.getRow(filaTotal).getCell(c);
    if (!celda.formula) continue;
    const L = letra(c);
    // Las columnas que no alimentamos (recuperaciones, amparo integral…) van a
    // cero: la plantilla las tiene, pero el portal no da esos conceptos todavía.
    celda.value = { formula: `SUM(${L}${FILA_MES_INI}:${L}${ultimaFilaMes})`, result: totalDe[c] || 0 };
  }
  ws.getRow(filaTotal).commit();

  // 6. La LIQUIDACIÓN también lleva su valor calculado.
  //
  //    Se marca `fullCalcOnLoad`, pero no se puede depender de eso: LibreOffice no
  //    lo honra al exportar, y un estado de cuenta que se radica no puede salir con
  //    "Capital $0" porque quien lo abrió no recalculó. Los valores van cacheados y
  //    las fórmulas se conservan, así que el archivo se lee bien siempre y sigue
  //    siendo editable.
  const deudaTotal = (t.deuda.canon || 0) + (t.deuda.adm || 0);
  const saldoTotal = (t.saldo.canon || 0) + (t.saldo.adm || 0);

  // Se localizan por su rótulo en la columna A, no por desplazamiento fijo: si la
  // oficina reordena el bloque, esto sigue encontrándolo o no toca nada.
  const etiquetas = {};
  for (let f = filaTotal + 1; f <= filaTotal + 15; f++) {
    const rotulo = String(ws.getRow(f).getCell(1).value ?? '').trim().toLowerCase();
    if (rotulo) etiquetas[rotulo] = f;
  }
  const filaDe = (clave) => etiquetas[clave] ?? null;
  const valorB = (f) => {
    if (!f) return 0;
    const v = ws.getRow(f).getCell(2).value;
    if (typeof v === 'number') return v;
    if (v && typeof v === 'object' && typeof v.result === 'number') return v.result;
    return 0;
  };

  const fIndem = filaDe('indemnización') ?? filaDe('indemnizacion');
  const fTramite = filaDe('tramite de conciliación') ?? filaDe('tramite de conciliacion');
  const indemnizacion = valorB(fIndem);
  const tramite = valorB(fTramite);

  const calculado = {
    capital: saldoTotal,
    'iva conciliación': tramite * 0.19,
    'honorarios antes de iva': (deudaTotal + indemnizacion) * 0.25,
  };
  calculado['iva honorarios'] = calculado['honorarios antes de iva'] * 0.19;
  calculado['total deuda'] = calculado.capital + indemnizacion + tramite
    + calculado['iva conciliación'] + calculado['honorarios antes de iva'] + calculado['iva honorarios'];

  const ponerResultado = (clave, valor) => {
    const f = filaDe(clave);
    if (!f) return;
    const celda = ws.getRow(f).getCell(2);
    if (celda.formula) celda.value = { formula: celda.formula, result: valor };
  };
  ponerResultado('capital', calculado.capital);
  ponerResultado('iva conciliación', calculado['iva conciliación']);
  ponerResultado('iva conciliacion', calculado['iva conciliación']);
  ponerResultado('honorarios antes de iva', calculado['honorarios antes de iva']);
  ponerResultado('iva honorarios', calculado['iva honorarios']);
  ponerResultado('total deuda', calculado['total deuda']);

  // El "TOTAL DEUDA" del encabezado repite esa suma.
  const k7 = ws.getCell('K7');
  if (k7.formula) k7.value = { formula: k7.formula, result: calculado['total deuda'] };

  wb.calcProperties = { ...(wb.calcProperties || {}), fullCalcOnLoad: true };

  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { escribirPlantilla, asegurarXlsx, rutaSoffice, serialExcel };
