/**
 * singular_processor.js — Procesador de Plantilla Singular
 *
 * Lee un Excel de entrada (Hoja1 + Hoja2), filtra clientes DECEVAL,
 * extrae datos de vehículos y financieros, busca correos de juzgados en
 * la Rama Judicial y llena PLANTILLA SINGULAR GRETTY.xlsx.
 *
 * Exporta: procesarSingular(excelBuffer, options?) → Promise<{ success, xlsxBuffer, clientes, errores }>
 *
 * options: {
 *   sacDocsDir?:    string  // ruta SAC_Documentos (default: SAC_OUT_DIR env o C:/SAC_Documentos)
 *   plantillaPath?: string  // ruta plantilla xlsx (default: PLANTILLA_SINGULAR env)
 *   fechaAsignacion?: string // DD/MM/YYYY, por defecto hoy
 * }
 */

'use strict';

const XLSX      = require('xlsx');
const AdmZip    = require('adm-zip');
const path      = require('path');
const fs        = require('fs');
const puppeteer = require('puppeteer');
const pdfParse  = require('pdf-parse');

// ─── Config ───────────────────────────────────────────────────────────────────

const DEFAULT_SAC_DOCS = process.env.SAC_OUT_DIR
  || '\\\\10.0.10.10\\compartida\\DOCUMENTOS ACTUALIZADOS 2019\\DEMANDAS\\FINANDINA\\EJECUTIVAS SINGULARES\\GARANTIAS';
const DEFAULT_PLANTILLA = process.env.PLANTILLA_SINGULAR
  || path.join(DEFAULT_SAC_DOCS, 'PLANTILLA SINGULAR GRETTY.xlsx');
const DEFAULT_DEMANDA_TEMPLATE = process.env.PLANTILLA_DEMANDA
  || '\\\\10.0.10.10\\compartida\\DOCUMENTOS ACTUALIZADOS 2019\\DEMANDAS\\FINANDINA\\EJECUTIVAS SINGULARES\\PLANTILLAS\\PLANTILLA DEMANDA SINGULAR AI.docx';

// Cuantía thresholds (usuario)
const CUANTIA_MINIMA_MAX = 70_036_200;
const CUANTIA_MENOR_MAX  = 262_635_750;

// Rama Judicial
const RAMA_URL   = 'https://www.ramajudicial.gov.co/es/directorio-cuentas-de-correo-electronico';
const CACHE_TTL  = 7 * 24 * 60 * 60 * 1000; // 7 días

// ─── Fechas ───────────────────────────────────────────────────────────────────

const MESES_ES = [
  'Enero','Febrero','Marzo','Abril','Mayo','Junio',
  'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre',
];

function excelSerialToDate(serial) {
  if (!serial || isNaN(Number(serial))) return null;
  const n = Math.floor(Number(serial));
  // Corrección del bug del 29-feb-1900 de Excel (serial 60)
  const days = n - (n > 59 ? 2 : 1);
  return new Date(Date.UTC(1900, 0, 1) + days * 86_400_000);
}

// Devuelve "14 de abril del 2026"
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

// ─── Cuantía ──────────────────────────────────────────────────────────────────

function toNum(val) {
  if (typeof val === 'number') return val;
  return parseFloat(String(val || '').replace(/[^0-9.]/g, '')) || 0;
}

function calcularCuantia(capital, interes) {
  return toNum(capital) + toNum(interes);
}

function tipoCuantia(total) {
  if (total <= CUANTIA_MINIMA_MAX) return 'MINIMA';
  if (total <= CUANTIA_MENOR_MAX)  return 'MENOR';
  return 'MAYOR';
}

// Determina el tipo de juzgado según la cuantía y los tipos disponibles en la ciudad.
// Reglas:
//   MAYOR           → JUZGADO CIVIL DEL CIRCUITO
//   MINIMA / MENOR  → Pequeñas Causas (si existe) → Promiscuo (si no hay civil) → Civil Municipal
function tipoJuzgado(cuantia, hasSmallClaims = false, hasPromiscuo = false) {
  if (cuantia === 'MAYOR') return 'JUZGADO CIVIL DEL CIRCUITO';
  // MINIMA o MENOR: elegir el juzgado disponible según especialidad de la ciudad
  if (hasSmallClaims) return 'JUZGADO CIVIL DE PEQUEÑAS CAUSAS';
  if (hasPromiscuo)   return 'JUZGADO PROMISCUO MUNICIPAL';
  return 'JUZGADO CIVIL MUNICIPAL';
}

// ─── Parseo de vehículos ──────────────────────────────────────────────────────

const VH_KW = ['MODELO', 'PLACA', 'SERVICIO', 'COLOR', 'SERIE', 'MOTOR', 'CHASIS',
               'CARROCERIA', 'TIPO'];

function getVhField(text, keyword, skipKws) {
  const allKw = VH_KW.filter(k => k !== keyword && !skipKws?.includes(k));
  const alt   = allKw.map(k => k.replace(/\s+/g, '\\s+')).join('|');
  const re    = new RegExp(
    `\\b${keyword.replace(/\s+/g, '\\s+')}\\s+(.+?)(?=\\s+(?:${alt})\\b|$)`, 'i'
  );
  const m = text.match(re);
  return m ? m[1].trim() : '';
}

function parsearVehiculo(raw) {
  const texto = (raw || '').trim().replace(/\s{2,}/g, ' ');
  if (!texto) return null;

  const tokens = texto.split(/\s+/);
  const clase  = tokens[0] || '';
  const marca  = tokens[1] || '';

  // LINEA: desde token 3 hasta "MODELO"
  const lineaM = texto.match(/^(?:\S+\s+){2}(.*?)\s+MODELO\b/i);
  const linea  = lineaM ? lineaM[1].trim() : tokens.slice(2).join(' ');

  const modelo  = getVhField(texto, 'MODELO',    []);
  // Placa: capturar el texto completo después de "PLACA" (código + "MATRICULADA EN...").
  // Ejemplo: "LAM20F MATRICULADA EN EL ORGAN TRANSI DE INST TTOYTTE DE CERETE"
  // Se detiene en el siguiente keyword de vehículo si lo hubiera, o al final del texto.
  const placaStartM = texto.match(/\bPLACA\s+([\s\S]+?)(?=\s+(?:SERVICIO|COLOR|SERIE|MOTOR|CHASIS|TIPO)\b|$)/i);
  const placa       = placaStartM ? placaStartM[1].trim() : '';
  const servicio = getVhField(texto, 'SERVICIO', []);
  const color   = getVhField(texto, 'COLOR',     []);
  const serie   = getVhField(texto, 'SERIE',     []);
  const motor   = getVhField(texto, 'MOTOR',     []);
  const chasis  = getVhField(texto, 'CHASIS',    []);

  // Tipo de carrocería (puede venir como "TIPO CARROCERIA" o "TIPO DE CARROCERIA")
  const tipoCarroceriaM = texto.match(
    /\bTIPO\s+(?:DE\s+)?CARROCERIA\s+(.+?)(?=\s+(?:CHASIS|MOTOR|SERIE|COLOR|SERVICIO|PLACA|MODELO)\b|$)/i
  );
  const tipoCarroceria = tipoCarroceriaM ? tipoCarroceriaM[1].trim() : '';

  return { clase, marca, linea, modelo, placa, servicio, color, serie, motor, chasis, tipoCarroceria };
}

function parsearVehiculos(descripcion) {
  if (!descripcion) return [];
  return descripcion
    .split(/\s*&\s*/)
    .map(v => parsearVehiculo(v))
    .filter(Boolean);
}

// ─── Ciudad ───────────────────────────────────────────────────────────────────

function extraerCiudad(ciudadStr) {
  const s = (ciudadStr || '').trim();
  // Formato habitual: "COTORRA (CORD)" → ciudad = COTORRA
  const m = s.match(/^([^(]+?)(?:\s*\([^)]*\))?$/);
  return (m ? m[1] : s).trim().toUpperCase();
}

// ─── Resolución de carpeta por cédula (lectura) ───────────────────────────────
// Busca primero {cedula}_{añoActual}, luego {cedula}.
// Si ninguna existe devuelve {cedula} (las funciones usan existsSync internamente).
function resolverCarpetaCedula(sacDocsDir, cedula) {
  const conAnio = path.join(sacDocsDir, `${cedula}_${new Date().getFullYear()}`);
  const normal  = path.join(sacDocsDir, String(cedula));
  return fs.existsSync(conAnio) ? conAnio : normal;
}

// ─── Contactos CSV ────────────────────────────────────────────────────────────

function leerContactos(cedula, sacDocsDir) {
  const result = { direccion: '', email: '', dirs: [], emails: [] };
  const p = path.join(resolverCarpetaCedula(sacDocsDir, cedula), `CONTACTOS_${cedula}.csv`);
  if (!fs.existsSync(p)) return result;

  try {
    const lines = fs.readFileSync(p, 'utf8')
      .replace(/^﻿/, '')   // BOM
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0);

    for (let i = 1; i < lines.length; i++) {
      // Formato: TIPO,"VALOR",FUENTE
      const m = lines[i].match(/^([^,]+),"([^"]*)"/);
      if (!m) continue;
      const tipo  = m[1].trim().toUpperCase();
      const valor = m[2].trim();
      if (!valor) continue;
      if (tipo === 'EMAIL') result.emails.push(valor);
      else                  result.dirs.push(valor);
    }
    result.direccion = result.dirs[0] || '';
    // Todos los correos separados por " - " para que aparezcan en la plantilla.
    result.email     = result.emails.join(' - ');
  } catch (e) {
    console.error(`[CONTACTOS] ${cedula}: ${e.message}`);
  }
  return result;
}

// ─── Rama Judicial scraping ───────────────────────────────────────────────────

function normText(s) {
  return (s || '').toUpperCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z0-9\s@.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Cache en memoria + fichero
const _ramaCache = {};
let   _ramaPageText = null; // texto completo de la página (se carga una vez)

function loadRamaCache(cacheFile) {
  if (Object.keys(_ramaCache).length > 0) return;
  try {
    if (fs.existsSync(cacheFile)) {
      const data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      Object.assign(_ramaCache, data);
    }
  } catch (_) {}
}

function saveRamaCache(cacheFile) {
  try {
    fs.writeFileSync(cacheFile, JSON.stringify(_ramaCache, null, 2), 'utf8');
  } catch (_) {}
}

async function cargarPaginaRama(browser) {
  if (_ramaPageText !== null) return _ramaPageText;

  console.error('[RAMA] Cargando directorio de correos...');
  const page = await browser.newPage();
  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
    );
    await page.goto(RAMA_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    // Intentar expandir acordeones si los hay
    await page.evaluate(() => {
      document.querySelectorAll(
        '.accordion-toggle, .panel-heading a, [data-toggle="collapse"], .collapse:not(.in)'
      ).forEach(el => { try { el.click(); } catch (_) {} });
    }).catch(() => {});
    await new Promise(r => setTimeout(r, 2000));

    _ramaPageText = await page.evaluate(() => document.body.innerText || document.body.textContent || '');
    console.error(`[RAMA] Página cargada (${(_ramaPageText || '').length} chars)`);
  } catch (e) {
    console.error(`[RAMA] Error: ${e.message}`);
    _ramaPageText = '';
  } finally {
    await page.close().catch(() => {});
  }
  return _ramaPageText;
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

function extraerCorreosPorCiudad(pageText, ciudadNorm) {
  const result = {
    municipal:      '',
    circuito:       '',
    hasSmallClaims: false,  // tiene Juzgado de Pequeñas Causas Civil
    hasPromiscuo:   false,  // solo tiene especialidad Promiscua (sin Civil)
  };
  if (!pageText || !ciudadNorm) return result;

  const lines = pageText.split('\n').map(l => l.trim()).filter(l => l);

  for (let i = 0; i < lines.length; i++) {
    const lineNorm = normText(lines[i]);
    // Coincidencia aproximada: la línea debe contener la ciudad
    if (!lineNorm.includes(ciudadNorm) && !ciudadNorm.startsWith(lineNorm.split(' ')[0])) continue;

    // Ventana de ±40 líneas alrededor de la ciudad
    const ventana = lines.slice(Math.max(0, i - 3), Math.min(lines.length, i + 40)).join('\n');
    const ventNorm = normText(ventana);
    const emails   = ventana.match(EMAIL_RE) || [];

    // Detectar tipos de juzgado presentes en la ventana de la ciudad
    if (ventNorm.includes('PEQUEN') || ventNorm.includes('PEQUEÑ')) result.hasSmallClaims = true;
    if (ventNorm.includes('PROMISCUO') && !ventNorm.includes('CIVIL MUNICIPAL')) result.hasPromiscuo = true;

    for (const email of emails) {
      const emailIdx = ventana.indexOf(email);
      const contexto = normText(ventana.substring(Math.max(0, emailIdx - 300), emailIdx + 50));

      const esCircuito    = contexto.includes('CIRCUITO');
      const esPequenas    = contexto.includes('PEQUEN') || contexto.includes('PEQUEÑ');
      const esMunicipal   = contexto.includes('MUNICIPAL') || esPequenas;
      const esPromiscuo   = contexto.includes('PROMISCUO');

      if (esCircuito  && !result.circuito)  result.circuito  = email.toLowerCase();
      if (esMunicipal && !result.municipal) result.municipal = email.toLowerCase();
      if (esPromiscuo && !result.municipal) result.municipal = email.toLowerCase();

      // Fallback: primer email encontrado
      if (!result.municipal && !result.circuito) result.municipal = email.toLowerCase();
    }

    if (result.municipal || result.circuito) break;
  }
  return result;
}

// Retorna { email, hasSmallClaims, hasPromiscuo }
async function buscarCorreoJuzgado(browser, ciudad, cuantia, cacheFile) {
  const ciudadNorm = normText(ciudad);
  if (!ciudadNorm) return { email: '', hasSmallClaims: false, hasPromiscuo: false };

  // Cache hit
  if (_ramaCache[ciudadNorm] && (Date.now() - (_ramaCache[ciudadNorm].ts || 0) < CACHE_TTL)) {
    const cached = _ramaCache[ciudadNorm];
    const tipo   = cuantia === 'MAYOR' ? 'circuito' : 'municipal';
    return {
      email:          cached[tipo] || cached.municipal || '',
      hasSmallClaims: cached.hasSmallClaims || false,
      hasPromiscuo:   cached.hasPromiscuo   || false,
    };
  }

  const pageText = await cargarPaginaRama(browser);
  const info     = extraerCorreosPorCiudad(pageText, ciudadNorm);

  _ramaCache[ciudadNorm] = { ...info, ts: Date.now() };
  saveRamaCache(cacheFile);

  const tipo = cuantia === 'MAYOR' ? 'circuito' : 'municipal';
  return {
    email:          info[tipo] || info.municipal || '',
    hasSmallClaims: info.hasSmallClaims,
    hasPromiscuo:   info.hasPromiscuo,
  };
}

// ─── Parseo de Excel de entrada ───────────────────────────────────────────────

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

// Devuelve null si no se encuentra la columna
function getCol(row, idx, ...names) {
  for (const name of names) {
    const n = normHeader(name);
    if (idx[n] !== undefined) return row[idx[n]];
  }
  return undefined;
}

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

// ─── Construcción de filas del template ──────────────────────────────────────

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
  // Buscar la PRIMERA fila realmente vacía (no usar !ref que puede incluir
  // celdas formateadas vacías del template y desplazar los datos al final).
  const range1 = XLSX.utils.decode_range(ws1['!ref'] || 'A1');
  let startRow1 = range1.s.r + 1; // fila 2 (0-indexed) = después del header
  // Avanzar mientras la fila tenga contenido en alguna de las primeras columnas
  for (let r = range1.s.r + 1; r <= range1.e.r + 1; r++) {
    const testCell = ws1[XLSX.utils.encode_cell({ r, c: range1.s.c })]
                  || ws1[XLSX.utils.encode_cell({ r, c: range1.s.c + 5 })];
    if (!testCell || testCell.v === undefined || testCell.v === '') {
      startRow1 = r;
      break;
    }
    startRow1 = r + 1;
  }
  writeRowsToSheet(ws1, filasTodas, startRow1);

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

    const range2 = XLSX.utils.decode_range(ws2['!ref'] || 'A1');
    let startRow2 = range2.s.r + 1;
    for (let r = range2.s.r + 1; r <= range2.e.r + 1; r++) {
      const testCell = ws2[XLSX.utils.encode_cell({ r, c: range2.s.c })]
                    || ws2[XLSX.utils.encode_cell({ r, c: range2.s.c + 5 })];
      if (!testCell || testCell.v === undefined || testCell.v === '') {
        startRow2 = r;
        break;
      }
      startRow2 = r + 1;
    }
    writeRowsToSheet(ws2, filasExtras, startRow2);
    console.error(`[PLANTILLA] Hoja2: ${filasExtras.length} vehículo(s) adicional(es) escritos`);
  }

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// ─── Parseo de PDFs SAC descargados ──────────────────────────────────────────
// Lee los PDFs SAC_*.pdf en C:/SAC_Documentos/{cedula}/ y extrae todos los
// campos posibles: nombre, ciudad juzgado, capital, intereses, fechas, etc.

async function leerDatosDeSACPdfs(cedula, sacDocsDir) {
  const result = {
    nombre:           '',
    ciudadJuzgado:    '',
    tipoJuzgado:      '',
    capital:          0,
    interes:          0,
    total:            0,
    fechaMora:        '',   // fecha inicio mora MÁS ANTIGUA de todas las obligaciones
    fechaSuscripcion: '',
    nitEmpresa:       '',
    nombreEmpresa:    '',
  };

  const dir = resolverCarpetaCedula(sacDocsDir, cedula);
  if (!fs.existsSync(dir)) return result;

  const pdfs = fs.readdirSync(dir).filter(f =>
    f.startsWith('SAC_') && f.toLowerCase().endsWith('.pdf')
  );

  if (pdfs.length === 0) return result;

  // Acumulamos todas las fechas de mora para quedarnos con la más antigua
  const fechasMora = [];

  for (const pdfName of pdfs) {
    try {
      const buffer = fs.readFileSync(path.join(dir, pdfName));
      const parsed = await pdfParse(buffer, { max: 0 });
      // SAC PDFs a veces concatenan campo+valor sin separador ("FechaInicioMora14-03-2026")
      // Usamos el texto crudo (sin colapsar espacios) para preservar los saltos
      const texto  = (parsed.text || '').replace(/[ \t]{2,}/g, ' ');

      // ── Nombre del deudor ────────────────────────────────────────────────
      if (!result.nombre) {
        const patterns = [
          /(?:NOMBRE\s+(?:DEL?\s+)?(?:DEUDOR|CLIENTE|TITULAR))\s*[:\-]?\s*([A-ZÁÉÍÓÚÑÜ][A-ZÁÉÍÓÚÑÜ ]{5,70}?)(?=\s{2,}|\n|[0-9]|CÉDULA|NIT|OBLIGACI)/i,
          /(?:DEUDOR|CLIENTE|TITULAR)\s*[:\-]\s*([A-ZÁÉÍÓÚÑÜ][A-ZÁÉÍÓÚÑÜ ]{5,70}?)(?=\s{2,}|\n)/i,
          /(?:NOMBRES?\s+Y\s+APELLIDOS?)\s*[:\-]?\s*([A-ZÁÉÍÓÚÑÜ][A-ZÁÉÍÓÚÑÜ ]{5,70}?)(?=\s{2,}|\n)/i,
        ];
        for (const re of patterns) {
          const m = texto.match(re);
          if (m && m[1].trim().split(/\s+/).length >= 2) {
            result.nombre = m[1].trim();
            break;
          }
        }
      }

      // ── Ciudad del juzgado ───────────────────────────────────────────────
      if (!result.ciudadJuzgado) {
        const juzgadoM = texto.match(/JUZGADO\s+(CIVIL\s+(?:MUNICIPAL|DEL?\s+CIRCUITO|PROMISCUO\s+MUNICIPAL))\s+(?:DE\s+)?([A-ZÁÉÍÓÚÑÜ][A-ZÁÉÍÓÚÑÜ ]{2,30}?)(?=\s{2,}|\n|[0-9])/i);
        if (juzgadoM) {
          result.tipoJuzgado   = `JUZGADO ${juzgadoM[1].trim().toUpperCase()}`;
          result.ciudadJuzgado = juzgadoM[2].trim().toUpperCase();
        }
      }

      // ── Fecha Inicio Mora ────────────────────────────────────────────────
      // Formato SAC: "Fecha Inicio Mora23-01-2026" (sin espacio entre campo y valor)
      // Colectar todas; al final tomamos la más antigua.
      const moraM = texto.match(/Fecha\s+Inicio\s+Mora\s*(\d{2}[\/\-]\d{2}[\/\-]\d{4})/i);
      if (moraM) {
        const raw = moraM[1]; // "23-01-2026" → DD-MM-YYYY
        const parts = raw.split(/[\/\-]/);
        if (parts.length === 3) {
          const d = new Date(Date.UTC(+parts[2], +parts[1] - 1, +parts[0]));
          if (!isNaN(d)) fechasMora.push({ d, raw });
        }
      }

      // ── Empleador ────────────────────────────────────────────────────────
      if (!result.nombreEmpresa) {
        const empM = texto.match(/(?:EMPRESA|EMPLEADOR|VINCULO\s+LABORAL)\s*[:\-]\s*([A-ZÁÉÍÓÚÑÜ][A-ZÁÉÍÓÚÑÜ0-9 .,&-]{4,70}?)(?=\s{2,}|\n)/i);
        if (empM) result.nombreEmpresa = empM[1].trim();
      }
      if (!result.nitEmpresa) {
        const nitM = texto.match(/(?:NIT|CC\/NIT)\s+(?:EMPRESA|EMPLEADOR)\s*[:\-]?\s*([\d.,-]+)/i);
        if (nitM) result.nitEmpresa = nitM[1].trim();
      }

    } catch (e) {
      console.error(`[PDF-SAC] ${cedula}/${pdfName}: ${e.message}`);
    }
  }

  // Fecha mora más antigua (la que lleva más tiempo en mora)
  if (fechasMora.length > 0) {
    fechasMora.sort((a, b) => a.d - b.d);
    result.fechaMora = fechasMora[0].raw.replace(/-/g, '/'); // DD/MM/YYYY
    console.error(`[PDF-SAC] ${cedula}: ${fechasMora.length} fecha(s) mora → más antigua: ${result.fechaMora}`);
  }

  if (result.nombre) {
    console.error(`[PDF-SAC] ${cedula}: nombre="${result.nombre}" ciudad="${result.ciudadJuzgado}"`);
  }
  return result;
}

// ─── Parseo de PDFs DECEVAL / PAGARÉ ─────────────────────────────────────────
// Lee el PDF del pagaré DECEVAL (o PAGARE) para extraer:
//   - numeroPagare   → "pagaré No. XXXXXXXX"
//   - fechaSuscripcion → fecha en que el cliente firmó el pagaré

const MESES_MAP = {
  enero:1, febrero:2, marzo:3, abril:4, mayo:5, junio:6,
  julio:7, agosto:8, septiembre:9, octubre:10, noviembre:11, diciembre:12,
};

function parseFechaSuscripcion(texto) {
  // 1) Formato ISO: "se firma el día 2021-10-06"
  let m = texto.match(/se\s+firma\s+el\s+d[ií]a\s+(\d{4})[\/\-](\d{2})[\/\-](\d{2})/i);
  if (m) {
    return `${m[3]}/${m[2]}/${m[1]}`; // DD/MM/YYYY
  }
  // 2) Formato electrónico: "Fecha: 06/10/2021" o "Fecha: 06-10-2021"
  m = texto.match(/\bFecha[:\s]+(\d{2})[\/\-](\d{2})[\/\-](\d{4})/i);
  if (m) {
    return `${m[1]}/${m[2]}/${m[3]}`; // DD/MM/YYYY (ya viene en ese orden)
  }
  // 3) Texto colombiano: "el día 24 del mes de enero del año 2024"
  //    o "a los (24) días del mes de enero del año 2024"
  m = texto.match(/(?:el\s+d[ií]a\s+(\d+)|a\s+los\s+\((\d+)\)\s+d[ií]as?)\s+del\s+mes\s+de\s+(\w+)\s+del\s+a[ñn]o\s+(\d{4})/i);
  if (m) {
    const dd  = String(m[1] || m[2]).padStart(2, '0');
    const mes = MESES_MAP[(m[3] || '').toLowerCase()];
    const yy  = m[4];
    if (mes) return `${dd}/${String(mes).padStart(2, '0')}/${yy}`;
  }
  return '';
}

async function leerDatosDeDeceval(cedula, sacDocsDir) {
  const result = { numeroPagare: '', fechaSuscripcion: '' };
  const dir = resolverCarpetaCedula(sacDocsDir, cedula);
  if (!fs.existsSync(dir)) return result;

  // PDFs de pagaré: DECEVAL.pdf, PAGARE.pdf, PAGARE 001.pdf, etc.
  // Excluir: DATACREDITO.pdf, FOR EJE.pdf, FOR INI.pdf, PRENDA.pdf, TESTIGO.pdf, SAC_*.pdf
  const EXCLUIR_RE = /(?:DATACREDITO|FOR\s+(?:EJE|INI)|PRENDA|TESTIGO)/i;
  const pdfs = fs.readdirSync(dir).filter(f => {
    const up = f.toUpperCase();
    return f.toLowerCase().endsWith('.pdf')
      && !f.startsWith('SAC_')
      && !EXCLUIR_RE.test(f)
      && (up.includes('DECEVAL') || up.includes('PAGARE'));
  });

  for (const pdfName of pdfs) {
    try {
      const buffer = fs.readFileSync(path.join(dir, pdfName));
      const parsed = await pdfParse(buffer, { max: 0 });
      const texto  = parsed.text || '';

      // ── Número de pagaré ──────────────────────────────────────────────
      if (!result.numeroPagare) {
        // Buscar "pagaré No. 14077915" (dígitos reales, no guiones/blancos)
        const pagM = texto.match(/pagar[eé]\s+No\.?\s*(\d{4,})/i);
        if (pagM) {
          result.numeroPagare = pagM[1].trim();
          console.error(`[PDF-DECEVAL] ${cedula}/${pdfName}: pagaré #${result.numeroPagare}`);
        }
      }

      // ── Fecha de suscripción (cuando firmó el cliente) ────────────────
      if (!result.fechaSuscripcion) {
        const fecha = parseFechaSuscripcion(texto);
        if (fecha) {
          result.fechaSuscripcion = fecha;
          console.error(`[PDF-DECEVAL] ${cedula}/${pdfName}: suscripción=${fecha}`);
        }
      }

    } catch (e) {
      console.error(`[PDF-DECEVAL] ${cedula}/${pdfName}: ${e.message}`);
    }
  }
  return result;
}

// ─── Generación de Demandas Word (mail merge manual) ─────────────────────────

function fmtCOP(val) {
  const n = typeof val === 'number' ? val : parseFloat(String(val || '').replace(/[^0-9.]/g, '')) || 0;
  return n.toLocaleString('es-CO', { maximumFractionDigits: 0 });
}

function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildFieldMap(fila) {
  return {
    TIPO_DE_JUZGADO:                    fila['TIPO DE JUZGADO']                    || '',
    CIUDAD_DE_JUZGADO:                  fila['CIUDAD DE JUZGADO']                  || '',
    CUANTIA:                            fila['CUANTIA']                             || '',
    OBLIGACION:                         fila['OBLIGACION']                          || '',
    OBLIGACIONES:                       fila['OBLIGACIONES']                        || fila['OBLIGACION'] || '',
    IDENTIFICACION:                     String(fila['IDENTIFICACION']               || ''),
    NOMBRE:                             fila['NOMBRE']                              || '',
    CAPITAL:                            fmtCOP(fila['CAPITAL']),
    INTERES:                            fmtCOP(fila['INTERES']),
    FECHA_MORA:                         fila['FECHA MORA']                          || '',
    FECHA_DE_ASIGNACION:                fila['FECHA DE ASIGNACION']                 || '',
    FECHA_DE_SUSCRIPCION:               fila['FECHA DE SUSCRIPCION']                || '',
    VALOR_CUANTIA:                      fmtCOP(fila['VALOR CUANTIA']),
    DIRECCION_DE_RESIDENCIA:            fila['DIRECCION DE RESIDENCIA']             || '',
    DIRECCION_ELECTRONICA:              fila['DIRECCION ELECTRONICA']               || '',
    NIT_EMPRESA_TT:                     String(fila['NIT EMPRESA TT']               || ''),
    NOMBRE_EMPRESA_TT:                  fila['NOMBRE EMPRESA TT']                   || '',
    DIRECCION_ELECTRONICA_EMPLEADOR:    fila['DIRECCION ELECTRONICA EMPLEADOR']     || '',
    PLACA:                              fila['PLACA']                               || '',
    SERVICIO:                           fila['SERVICIO']                            || '',
    CLASE:                              fila['CLASE']                               || '',
    MARCA:                              fila['MARCA']                               || '',
    LINEA:                              fila['LINEA']                               || '',
    MODELO:                             fila['MODELO']                              || '',
    COLOR:                              fila['COLOR']                               || '',
    SERIE:                              fila['SERIE']                               || '',
    MOTOR:                              fila['MOTOR']                               || '',
    CHASIS:                             fila['CHASIS']                              || '',
    TIPO_DE_CARROCERIA:                 fila['TIPO DE CARROCERIA']                  || '',
    STRIA_MCPAL_TTOyTTE:                fila['STRIA MCPAL\nTTOyTTE']               || '',
    DIRECCION_ELECTRONICA_DEL_TRANSITO: fila['DIRECCION ELECTRONICA DEL TRANSITO']  || '',
  };
}

function fillDocxTemplate(templateBuffer, fieldMap) {
  const zip = new AdmZip(templateBuffer);
  let xml = zip.readAsText('word/document.xml');
  for (const [field, value] of Object.entries(fieldMap)) {
    xml = xml.split(`«${field}»`).join(xmlEscape(value));
  }
  zip.updateFile('word/document.xml', Buffer.from(xml, 'utf8'));
  return zip.toBuffer();
}

async function generarDemandasWord(filas, sacDocsDir, templateDocxPath) {
  if (!fs.existsSync(templateDocxPath)) {
    throw new Error(`Plantilla DOCX no encontrada: ${templateDocxPath}`);
  }
  const templateBuf = fs.readFileSync(templateDocxPath);
  const generados   = [];

  for (const fila of filas) {
    const cedula = String(fila['IDENTIFICACION'] || '').trim();
    if (!cedula) continue;
    try {
      const fieldMap  = buildFieldMap(fila);
      const docxBuf   = fillDocxTemplate(templateBuf, fieldMap);
      const clientDir = resolverCarpetaCedula(sacDocsDir, cedula);
      if (!fs.existsSync(clientDir)) fs.mkdirSync(clientDir, { recursive: true });
      const nombre  = (fila['NOMBRE'] || cedula).trim().replace(/[<>:"/\\|?*]/g, '_');
      const outFile = path.join(clientDir, `DEMANDA EJECUTIVA SINGULAR ${nombre} - ${cedula}.docx`);
      fs.writeFileSync(outFile, docxBuf);
      generados.push({ cedula, path: outFile });
      console.error(`[DEMANDA] ✓ ${cedula} → ${path.basename(outFile)}`);
    } catch (e) {
      console.error(`[DEMANDA] ✗ ${cedula}: ${e.message}`);
    }
  }
  return generados;
}

// ─── Función principal exportada ──────────────────────────────────────────────

async function procesarSingular(excelBuffer, options = {}) {
  const sacDocsDir      = options.sacDocsDir      || DEFAULT_SAC_DOCS;
  const plantillaPath   = options.plantillaPath   || DEFAULT_PLANTILLA;
  const demandaTemplate = options.demandaTemplate || DEFAULT_DEMANDA_TEMPLATE;
  // Convertir fecha de asignación al formato texto "12 de Mayo del 2026"
  const fechaAsig       = parseAnyDate(options.fechaAsignacion) || todayString();
  const cacheFile       = path.join(sacDocsDir, 'rama_judicial_cache.json');

  loadRamaCache(cacheFile);

  // 1. Parsear Excel de entrada
  let clientes;
  try {
    clientes = parsearExcelEntrada(excelBuffer);
  } catch (e) {
    return { success: false, error: `Error leyendo Excel: ${e.message}`, clientes: [], errores: [] };
  }

  if (clientes.length === 0) {
    return { success: false, error: 'No se encontraron clientes con APLICATIVO = DECEVAL', clientes: [], errores: [] };
  }

  console.error(`[SINGULAR] ${clientes.length} cliente(s) DECEVAL encontrados`);

  // 2. Lanzar Puppeteer para Rama Judicial
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', '--disable-gpu',
        '--window-size=1280,900',
      ],
    });
  } catch (e) {
    console.error(`[RAMA] Puppeteer no disponible: ${e.message}. Se omitirán correos de juzgado.`);
    browser = null;
  }

  const filasTodas  = [];   // una fila principal por cliente (→ Hoja1)
  const filasExtras = [];   // vehículos adicionales de cada cliente (→ Hoja2)
  const clientesSalida = [];
  const errores = [];

  try {
    for (const cliente of clientes) {
      try {
        const { cedula } = cliente;

        // 2a. Leer PDFs SAC ya descargados (fecha mora más antigua)
        const sacPdf = await leerDatosDeSACPdfs(cedula, sacDocsDir);

        // 2b. Leer PDF DECEVAL / PAGARÉ (número de pagaré + fecha suscripción)
        const decevalPdf = await leerDatosDeDeceval(cedula, sacDocsDir);

        // ── Enriquecer nombre y empresa desde SAC PDF ──────────────────
        if (!cliente.nombre && sacPdf.nombre)           cliente.nombre     = sacPdf.nombre;
        if (!cliente.empresa && sacPdf.nombreEmpresa)   cliente.empresa    = sacPdf.nombreEmpresa;
        if (!cliente.nitEmpresa && sacPdf.nitEmpresa)   cliente.nitEmpresa = sacPdf.nitEmpresa;

        // ── FECHA MORA: siempre del SAC PDF (fecha inicio mora más antigua).
        //    Solo usar Excel como último recurso.
        if (sacPdf.fechaMora) {
          cliente.fechaMoraRaw = sacPdf.fechaMora; // SAC PDF tiene prioridad
        }
        // Sin fecha mora del SAC (cliente sin mora aún) → dejar la del Excel

        // ── FECHA SUSCRIPCION: del PDF DECEVAL/PAGARÉ (cuando firmó el cliente).
        //    Prioridad: DECEVAL PDF > Excel FECHA_DESEMBOLSO
        if (decevalPdf.fechaSuscripcion) {
          cliente.fechaDesembolsoRaw = decevalPdf.fechaSuscripcion;
        }

        // ── Financieros (fallback desde SAC PDF si Excel no los tiene) ──
        const f = cliente.financieros || { capital: 0, interes: 0, total: 0, obligacion: '' };
        if (!f.capital && sacPdf.capital) f.capital = sacPdf.capital;
        if (!f.interes && sacPdf.interes) f.interes = sacPdf.interes;
        if (!f.total   && sacPdf.total)   f.total   = sacPdf.total;

        // Ciudad del juzgado: preferir PDF SAC (más precisa) sobre Excel
        const ciudad = sacPdf.ciudadJuzgado || cliente.ciudad;

        // 2c. Datos financieros consolidados
        const totalCuant = f.total || calcularCuantia(f.capital, f.interes);
        const cuantiaLbl = tipoCuantia(totalCuant);

        // 2d. Parsear vehículos
        const vehiculos = parsearVehiculos(cliente.descrVehiculos);
        // Sin descripción → un objeto vacío para rellenar la fila principal
        if (vehiculos.length === 0) vehiculos.push({});

        // 2e. Leer CONTACTOS CSV
        const contactos = leerContactos(cedula, sacDocsDir);

        // 2f. Correo juzgado (Rama Judicial) + tipo de juzgado disponible en la ciudad
        let correoJuzgado = '';
        let courtInfo     = { hasSmallClaims: false, hasPromiscuo: false };
        if (browser) {
          try {
            const ramaResult = await buscarCorreoJuzgado(browser, ciudad, cuantiaLbl, cacheFile);
            correoJuzgado    = ramaResult.email;
            courtInfo        = { hasSmallClaims: ramaResult.hasSmallClaims, hasPromiscuo: ramaResult.hasPromiscuo };
          } catch (e) {
            console.error(`[RAMA] ${cedula} (${ciudad}): ${e.message}`);
          }
        }

        // 2g. Construir fila principal + extras (vehículos adicionales → Hoja2)
        const clienteConsolidado = { ...cliente, ciudad, financieros: f };
        const { main, extras } = construirFilas(
          clienteConsolidado, vehiculos, contactos, correoJuzgado,
          fechaAsig, cuantiaLbl, decevalPdf.numeroPagare, courtInfo
        );
        filasTodas.push(main);
        filasExtras.push(...extras);

        clientesSalida.push({
          cedula,
          nombre:         clienteConsolidado.nombre,
          ciudad,
          cuantia:        cuantiaLbl,
          valorCuantia:   totalCuant,
          obligacion:     f.obligacion,
          numeroPagare:   decevalPdf.numeroPagare,
          tipoJuzgadoFinal: main['TIPO DE JUZGADO'],
          vehiculos:      vehiculos.length,
          tieneContactos: !!(contactos.direccion || contactos.email),
          correoJuzgado,
          filas:          1 + extras.length,
        });

        console.error(`[SINGULAR] ✓ ${cedula} — ${clienteConsolidado.nombre || '(sin nombre)'} — ${cuantiaLbl} — ${main['TIPO DE JUZGADO']} — ${vehiculos.length} veh.${extras.length ? ` (${extras.length} en Hoja2)` : ''}`);

      } catch (clienteErr) {
        console.error(`[SINGULAR] ✗ ${cliente.cedula}: ${clienteErr.message}`);
        errores.push({ cedula: cliente.cedula, error: clienteErr.message });
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  if (filasTodas.length === 0) {
    return {
      success: false,
      error:   'No se generaron filas de salida (revise los datos de entrada)',
      clientes: clientesSalida,
      errores,
    };
  }

  // 3. Llenar plantilla Excel y devolver buffer XLSX
  let xlsxBuffer;
  try {
    xlsxBuffer = fillTemplate(filasTodas, plantillaPath, filasExtras);
  } catch (e) {
    return {
      success: false,
      error:   `Error generando Excel: ${e.message}`,
      clientes: clientesSalida,
      errores,
    };
  }

  // 4. Generar un DOCX de demanda por cliente (guarda en {SAC_OUT_DIR}/{cedula}/)
  let demandasGeneradas = [];
  if (fs.existsSync(demandaTemplate)) {
    try {
      demandasGeneradas = await generarDemandasWord(filasTodas, sacDocsDir, demandaTemplate);
      console.error(`[DEMANDA] ${demandasGeneradas.length} documento(s) Word generado(s)`);
    } catch (e) {
      console.error(`[DEMANDA] Error generando documentos Word: ${e.message}`);
    }
  } else {
    console.error(`[DEMANDA] Plantilla DOCX no encontrada, se omite: ${demandaTemplate}`);
  }

  return {
    success:          true,
    xlsxBuffer,
    totalFilas:       filasTodas.length,
    totalExtras:      filasExtras.length,
    clientes:         clientesSalida,
    demandas:         demandasGeneradas,
    errores:          errores.length ? errores : undefined,
  };
}

module.exports = { procesarSingular, generarDemandasWord };
