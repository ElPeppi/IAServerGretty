#!/usr/bin/env node
/**
 * probe_rama.js — Diagnóstico de la consulta de juzgados a la Rama Judicial.
 *
 * Sirve para separar tres causas que desde la web se ven IGUAL ("no se encontró
 * el correo del juzgado") pero se arreglan distinto:
 *
 *   A. El reporte Power BI no carga o no renderiza  → problema de Chrome/headless
 *      en el servidor. Se ve en la captura: página en blanco o sin slicers.
 *   B. Carga, pero la ciudad no está / no la encuentra el buscador del slicer.
 *   C. Encuentra filas pero ninguna sirve como correo de reparto.
 *
 * Uso (en la carpeta sac_scripts del servidor):
 *   node probe_rama.js LURUACO
 *   node probe_rama.js "SANTO TOMAS" MENOR
 *
 * NO usa la cache: siempre consulta en vivo, que es lo que se quiere medir.
 * Deja captura y HTML en la carpeta temporal para poder mirarlos después.
 */

'use strict';

// El entorno lo carga src/config (con sus rutas de respaldo); no se usa
// dotenv aquí para que la sonda funcione desde cualquier carpeta, como el motor.

const fs        = require('fs');
const path      = require('path');
const puppeteer = require('puppeteer');

const config = require('./src/config');
const {
  PBI_URL, consultarCiudadPBI, analizarCuentas, buscarCorreoJuzgado,
} = require('./src/services/singular/ramaJudicial');

const ciudad  = process.argv[2] || 'LURUACO';
const cuantia = (process.argv[3] || 'MINIMA').toUpperCase();
const salida  = (n) => path.join(config.TEMP_DIR, `rama-probe-${n}`);

const seg = (t0) => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

(async () => {
  console.log(`— Sonda RAMA —  ciudad="${ciudad}"  cuantía=${cuantia}`);
  console.log(`puppeteer ${require('puppeteer/package.json').version}`);

  let browser;
  const t0 = Date.now();
  try {
    browser = await puppeteer.launch({
      headless: 'new', // mismo modo que usa la generación (index.js)
      args: [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--window-size=1600,1000',
      ],
    });
  } catch (e) {
    console.log(`✗ CAUSA A — Puppeteer no arrancó: ${e.message}`);
    process.exit(1);
  }
  console.log(`✓ navegador arriba en ${seg(t0)} — ${await browser.version()}`);

  // ── 1. ¿Carga el reporte y aparecen los slicers? ────────────────────────────
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  const t1 = Date.now();
  try {
    await page.goto(PBI_URL, { waitUntil: 'networkidle2', timeout: 90000 });
    console.log(`✓ reporte cargado en ${seg(t1)}`);
  } catch (e) {
    console.log(`✗ CAUSA A — el reporte no cargó (${seg(t1)}): ${e.message}`);
  }

  // El Power BI pinta los slicers bastante después del networkidle.
  await new Promise((r) => setTimeout(r, 10000));
  const slicers = await page.evaluate(() =>
    [...document.querySelectorAll('div.slicer-container')]
      .map((s) => (s.textContent || '').trim().slice(0, 30)));

  try {
    await page.screenshot({ path: salida('reporte.png') });
    fs.writeFileSync(salida('reporte.html'), await page.content());
    console.log(`  captura: ${salida('reporte.png')}`);
  } catch (e) { console.log(`  (no se pudo guardar la captura: ${e.message})`); }

  if (slicers.length === 0) {
    console.log('✗ CAUSA A — el reporte cargó pero NO hay slicers.');
    console.log('  Es el fallo conocido de headless: Chrome no renderiza el Power BI.');
    console.log('  Mira la captura para confirmar si la página salió en blanco.');
    await browser.close();
    process.exit(2);
  }
  console.log(`✓ ${slicers.length} slicer(s): ${JSON.stringify(slicers)}`);
  await page.close();

  // ── 2. La consulta REAL, la misma que corre al generar ──────────────────────
  const t2 = Date.now();
  let res;
  try {
    res = await consultarCiudadPBI(browser, ciudad);
  } catch (e) {
    console.log(`✗ CAUSA B — la consulta falló (${seg(t2)}): ${e.message}`);
    await browser.close();
    process.exit(3);
  }

  if (!res.encontrado) {
    console.log(`✗ CAUSA B — el slicer no encontró "${ciudad}" (${seg(t2)}), 0 filas.`);
    console.log('  Prueba a escribir la ciudad en el buscador del reporte a mano:');
    console.log(`  ${PBI_URL}`);
    await browser.close();
    process.exit(4);
  }

  console.log(`✓ ${res.filas.length} fila(s) en ${seg(t2)}`);
  for (const f of res.filas.slice(0, 25)) {
    console.log(`   · ${f.corporacion} | ${f.especialidad} | ${f.nombre} | ${f.email}`);
  }
  if (res.filas.length > 25) console.log(`   … y ${res.filas.length - 25} más`);

  // ── 3. Qué saca de esas filas ───────────────────────────────────────────────
  const info = analizarCuentas(res.filas);
  console.log('\nAnálisis:', JSON.stringify(info, null, 1));

  const final = await buscarCorreoJuzgado(browser, ciudad, cuantia, salida('cache.json'));
  console.log('Resultado que usaría la demanda:', JSON.stringify(final));

  if (!final.email) {
    console.log('\n✗ CAUSA C — hay filas pero ninguna sirve de correo.');
    console.log('  Arreglo: añadir la ciudad a juzgados_config.json (override manual).');
  } else {
    console.log(`\n✓ TODO BIEN — correo: ${final.email}`);
    console.log('  Si la demanda igual salió sin juzgado, el fallo fue puntual');
    console.log('  (timeout por carga del servidor): repite la generación.');
  }

  await browser.close();
})().catch((e) => { console.error('sonda rota:', e); process.exit(1); });
