/**
 * services/libertador/estadoCuenta.js — Estado de cuenta de El Libertador
 *
 * Llena la plantilla `ESTADO DE CUENTA.xls` (Investigaciones y Cobranzas El
 * Libertador) que vive en el Drive de la oficina:
 *   DEMANDAS/LIBERTADOR/PLANTILLAS/ESTADO DE CUENTA.xls
 *
 * Es un estado de cuenta de COBRANZA DE ARRENDAMIENTO (canon), no un crédito
 * bancario. La hoja "Formato" tiene:
 *   - Encabezado (fila 6-7): Elaboró, Fecha, OCUPADO, POL, SOLICITUD → el VALOR
 *     va ANEXADO al rótulo en la misma celda ("SOLICITUD: 6487745").
 *   - Tabla mensual (fila 11 en adelante): una fila por MES en mora.
 *       DEUDA   → A:Mes(fecha)  B:Canon  C:Adm  D:RecCanon  E:RecAdmon
 *                 F:RecIvaComercial  G:RecPorSP  H:AmparoIntegral
 *       ABONOS  → I:Canon  J:Adm  K:RecCanon  L:RecAdm  M:RecIvaComercial
 *                 N:RecPorSP  O:AmparoIntegral  P:Honorarios
 *       SALDO   → Q:=B-I  R:=C-J  (y RECUPERACIONES S:W)  ← fórmulas del template
 *   - Liquidación (fila 19-25): Capital, Indemnización(manual), Trámite de
 *     Conciliación(250000 fijo), IVA Conciliación(19%), Honorarios(25%),
 *     IVA Honorarios(19%), TOTAL DEUDA=SUM. Casi todo fórmulas del template.
 *
 * NOTA sobre formato: la librería `xlsx` (SheetJS community) conserva fórmulas y
 * valores, pero NO reescribe estilos ni recalcula fórmulas. El archivo abre bien
 * en Excel/LibreOffice (ahí recalcula). Para conservar 100% el formato del .xls
 * original conviene, en producción, rellenar con LibreOffice headless o plantilla
 * .xlsx con estilos. Ver docs/LIBERTADOR-PLAN.md.
 *
 * Contrato de datos (todo lo demás lo calcula el template):
 *   {
 *     elaboro, fechaElaboracion(Date), ocupado, pol, solicitud,
 *     meses: [ { mes:Date, deuda:{canon,adm,recCanon,recAdmon,recIvaComercial,
 *                 recPorSP,amparoIntegral}, abono:{canon,adm,recCanon,recAdm,
 *                 recIvaComercial,recPorSP,amparoIntegral,honorarios} } ],
 *     indemnizacion?, tramiteConciliacion?=250000
 *   }
 */
'use strict';

const XLSX = require('xlsx');
const fs   = require('fs');

// Primera fila de datos (0-based → fila 11 de Excel) y columnas por nombre.
const FILA_DATOS_0 = 10; // Excel row 11
const COL = {
  mes: 'A',
  deuda:  { canon:'B', adm:'C', recCanon:'D', recAdmon:'E', recIvaComercial:'F', recPorSP:'G', amparoIntegral:'H' },
  abono:  { canon:'I', adm:'J', recCanon:'K', recAdm:'L', recIvaComercial:'M', recPorSP:'N', amparoIntegral:'O', honorarios:'P' },
};

function excelSerialFromDate(d) {
  // Serial de Excel (1900 date system): días desde 1899-12-30.
  const ms = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const epoch = Date.UTC(1899, 11, 30);
  return Math.round((ms - epoch) / 86400000);
}

function setNum(ws, addr, v) {
  if (v === undefined || v === null || v === '') return;
  ws[addr] = { v: Number(v), t: 'n' };
}
function setStr(ws, addr, v) {
  if (v === undefined || v === null) return;
  ws[addr] = { v: String(v), t: 's' };
}

/**
 * Rellena la plantilla y devuelve un Buffer .xlsx.
 * @param {object} datos  ver contrato arriba
 * @param {string} plantillaPath  ruta a ESTADO DE CUENTA.xls (blanca)
 */
function generarEstadoCuenta(datos, plantillaPath) {
  if (!fs.existsSync(plantillaPath)) {
    throw new Error(`Plantilla no encontrada: ${plantillaPath}`);
  }
  const wb = XLSX.read(fs.readFileSync(plantillaPath), { type: 'buffer', cellFormula: true, cellNF: true });
  const ws = wb.Sheets['Formato'] || wb.Sheets[wb.SheetNames[0]];

  // ── Encabezado: el valor se ANEXA al rótulo en la misma celda ──────────────
  if (datos.elaboro)  setStr(ws, 'A6', `Elaboro : ${datos.elaboro}`);
  if (datos.fechaElaboracion) {
    const f = datos.fechaElaboracion;
    const txt = `${String(f.getDate()).padStart(2,'0')}/${String(f.getMonth()+1).padStart(2,'0')}/${f.getFullYear()}`;
    setStr(ws, 'D6', `Fecha de elaboración: ${txt}`);
  }
  if (datos.ocupado)   setStr(ws, 'I6', `OCUPADO: ${datos.ocupado}`);
  if (datos.pol)       setStr(ws, 'A7', `POL: ${datos.pol}`);
  if (datos.solicitud) setStr(ws, 'B7', `SOLICITUD: ${datos.solicitud}`);

  // ── Tabla mensual: una fila por mes desde la fila 11 ───────────────────────
  const meses = datos.meses || [];
  meses.forEach((m, i) => {
    const rowExcel = FILA_DATOS_0 + 1 + i; // 11, 12, ...
    const r0 = rowExcel - 1;               // 0-based para fórmulas de saldo
    // Mes (fecha serial)
    if (m.mes instanceof Date) setNum(ws, `${COL.mes}${rowExcel}`, excelSerialFromDate(m.mes));
    else if (m.mes)            setStr(ws, `${COL.mes}${rowExcel}`, m.mes);
    // DEUDA
    for (const [k, col] of Object.entries(COL.deuda)) setNum(ws, `${col}${rowExcel}`, (m.deuda || {})[k]);
    // ABONOS
    for (const [k, col] of Object.entries(COL.abono)) setNum(ws, `${col}${rowExcel}`, (m.abono || {})[k]);
    // SALDO (fórmulas) — sólo si el template no las trae ya en esta fila
    if (!ws[`Q${rowExcel}`]) ws[`Q${rowExcel}`] = { t: 'n', f: `B${rowExcel}-I${rowExcel}` };
    if (!ws[`R${rowExcel}`]) ws[`R${rowExcel}`] = { t: 'n', f: `C${rowExcel}-J${rowExcel}` };
  });

  // ── Liquidación: sólo los campos que se digitan (el resto son fórmulas) ────
  if (datos.indemnizacion !== undefined)      setNum(ws, 'B20', datos.indemnizacion);
  if (datos.tramiteConciliacion !== undefined) setNum(ws, 'B21', datos.tramiteConciliacion);

  // Ajustar el rango para incluir todas las filas escritas
  const range = XLSX.utils.decode_range(ws['!ref']);
  const lastRow = Math.max(range.e.r, FILA_DATOS_0 + meses.length);
  ws['!ref'] = XLSX.utils.encode_range({ s: range.s, e: { r: lastRow, c: range.e.c } });

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { generarEstadoCuenta, COL, FILA_DATOS_0, excelSerialFromDate };
