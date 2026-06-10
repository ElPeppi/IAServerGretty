/**
 * utils/fechas.js — Conversión de fechas a texto legal en español
 *
 * Formato de salida estándar del proyecto: "14 de Abril del 2026"
 * Acepta seriales de Excel, objetos Date, DD/MM/YYYY y texto ya formateado.
 */

'use strict';

const MESES_ES = [
  'Enero','Febrero','Marzo','Abril','Mayo','Junio',
  'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre',
];

// Para parsear fechas escritas: "24 del mes de enero del año 2024"
const MESES_MAP = {
  enero:1, febrero:2, marzo:3, abril:4, mayo:5, junio:6,
  julio:7, agosto:8, septiembre:9, octubre:10, noviembre:11, diciembre:12,
};

function excelSerialToDate(serial) {
  if (!serial || isNaN(Number(serial))) return null;
  const n = Math.floor(Number(serial));
  // Corrección del bug del 29-feb-1900 de Excel (serial 60)
  const days = n - (n > 59 ? 2 : 1);
  return new Date(Date.UTC(1900, 0, 1) + days * 86_400_000);
}

// Devuelve "14 de Abril del 2026"
function formatDate(d) {
  if (!d || !(d instanceof Date) || isNaN(d)) return '';
  const dd  = d.getUTCDate();
  const mes = MESES_ES[d.getUTCMonth()];
  const yy  = d.getUTCFullYear();
  return `${dd} de ${mes} del ${yy}`;
}

function parseAnyDate(val) {
  if (val === null || val === undefined || val === '') return '';
  if (typeof val === 'number') return formatDate(excelSerialToDate(val));
  if (val instanceof Date)     return formatDate(val);
  const s = String(val).trim();
  // Ya está en formato texto "14 de abril del 2026"
  if (/\d+\s+de\s+\w+\s+del?\s+\d{4}/i.test(s)) return s;
  // DD/MM/YYYY o DD-MM-YYYY (formato colombiano)
  const dmyM = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmyM) {
    const d = new Date(Date.UTC(parseInt(dmyM[3]), parseInt(dmyM[2]) - 1, parseInt(dmyM[1])));
    return isNaN(d) ? s : formatDate(d);
  }
  // Cualquier otro formato
  const d = new Date(s);
  return isNaN(d) ? s : formatDate(d);
}

function todayString() {
  return formatDate(new Date());
}

module.exports = {
  MESES_ES,
  MESES_MAP,
  excelSerialToDate,
  formatDate,
  parseAnyDate,
  todayString,
};
