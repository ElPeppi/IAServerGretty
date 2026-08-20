#!/usr/bin/env node
/**
 * probe_ocr.js — Diagnóstico del OCR del pagaré escaneado (FINANDINA).
 *
 * Cuando la demanda avisa "el OCR no lee el número impreso del pagaré", esto
 * dice POR QUÉ: si el OCR no arranca, si arranca pero lee basura, o si lee bien
 * y lo que falla es el patrón que busca el número.
 *
 * Uso (en la carpeta sac_scripts del servidor):
 *   node probe_ocr.js "/docs/DEMANDAS/.../PAGARE.pdf"   ← lo normal en producción
 *   node probe_ocr.js https://jramosabogados.com/docs/...
 *   node probe_ocr.js /ruta/al/PAGARE.pdf
 *   node probe_ocr.js 1045231446    ← solo si el cliente está en disco
 *
 * En producción los documentos del cliente viven en DRIVE, no en el disco del
 * servidor: se bajan para generar y se limpian después. Por eso la vía buena es
 * la URL /docs/… (que el backend sirve leyendo de Drive), no la cédula.
 *
 * Deja el texto crudo del OCR en la carpeta temporal para poder leerlo entero.
 */

'use strict';

// El entorno lo carga src/config (con sus rutas de respaldo); no se usa
// dotenv aquí para que la sonda funcione desde cualquier carpeta, como el motor.

const fs   = require('fs');
const path = require('path');

const config = require('./src/config');
const { ocrPdf, extraerCamposPagare, cerrarOcr } = require('./src/services/ocr');
const { resolverCarpetaCedula } = require('./src/utils/carpetas');

const arg = process.argv[2];
if (!arg) {
  console.error('Falta el argumento: una ruta a un PDF o una cédula.');
  process.exit(1);
}

// El backend sirve /docs/… leyendo de Drive. Se le pide a él en vez de hablar
// con Drive desde aquí: el motor no tiene credenciales de Drive a propósito.
const BACKEND = process.env.PROBE_BACKEND_URL || 'http://localhost:3001';

/** Descarga la URL (o el relPath /docs/…) a la carpeta temporal. */
async function descargar(entrada) {
  const url = /^https?:\/\//i.test(entrada) ? entrada : BACKEND + entrada;
  console.log(`Descargando ${url}`);
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    console.error(`✗ No se pudo conectar: ${e.message}`);
    console.error(`  ¿Está arriba el backend en ${BACKEND}? (pm2 list)`);
    console.error('  Si corre en otro puerto: PROBE_BACKEND_URL=http://localhost:PUERTO node probe_ocr.js …');
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`✗ HTTP ${res.status} al bajar el PDF.`);
    if (res.status === 404) console.error('  Revisa la ruta; debe ser la misma que usa la web.');
    process.exit(1);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const destino = path.join(config.TEMP_DIR, `ocr-probe-${path.basename(decodeURIComponent(url.split('?')[0]))}`);
  fs.writeFileSync(destino, buf);
  return destino;
}

/** Ruta del pagaré: URL, ruta local, o el PDF de pagaré del cliente en disco. */
async function resolverPdf(entrada) {
  if (/^https?:\/\//i.test(entrada) || entrada.startsWith('/docs/')) return descargar(entrada);
  if (fs.existsSync(entrada) && fs.statSync(entrada).isFile()) return entrada;

  // La carpeta se busca bajo OUT_DIR, con la convención del motor
  // ({cedula} / {cedula}_{año} / {cedula}_{MM}_{año}).
  const dir = resolverCarpetaCedula(config.OUT_DIR, entrada);
  if (!dir || !fs.existsSync(dir)) {
    console.error(`No hay carpeta para la cédula ${entrada}.`);
    console.error(`Se buscó en: ${config.OUT_DIR}`);
    console.error('En producción esto es NORMAL: los documentos están en Drive y el');
    console.error('disco solo se usa durante la generación. Pasa la URL /docs/… del');
    console.error('pagaré, que es lo que ve la web.');
    // Listar lo que empiece por la cédula ayuda cuando el nombre lleva sufijo.
    try {
      const cerca = fs.readdirSync(config.OUT_DIR).filter((f) => f.startsWith(String(entrada)));
      console.error(cerca.length
        ? `Carpetas que empiezan por esa cédula: ${cerca.join(', ')}`
        : 'No hay ninguna carpeta que empiece por esa cédula.');
    } catch (e) {
      console.error(`No se pudo listar OUT_DIR: ${e.message}`);
    }
    console.error('También puedes pasar la ruta del PDF directamente.');
    process.exit(1);
  }
  const pdfs = fs.readdirSync(dir)
    .filter((f) => /\.pdf$/i.test(f) && /PAGARE|DECEVAL/i.test(f) && !f.startsWith('~$'));
  if (!pdfs.length) {
    console.error(`En ${dir} no hay ningún PDF de pagaré. Contiene:`);
    for (const f of fs.readdirSync(dir)) console.error(`   · ${f}`);
    process.exit(1);
  }
  if (pdfs.length > 1) console.log(`(hay ${pdfs.length} candidatos, se usa el primero)`);
  return path.join(dir, pdfs[0]);
}

(async () => {
  const pdf = await resolverPdf(arg);
  const buf = fs.readFileSync(pdf);
  console.log(`— Sonda OCR —  ${pdf}  (${Math.round(buf.length / 1024)} KB)`);

  const t0 = Date.now();
  let r;
  try {
    // Mismos parámetros que usa la generación en carpetaCliente.js.
    r = await ocrPdf(buf, { scale: 3, maxPages: 2 });
  } catch (e) {
    console.log(`✗ el OCR no llegó a correr: ${e.message}`);
    console.log('  Suele ser que falta el binario de rasterizado o los .traineddata.');
    await cerrarOcr().catch(() => {});
    process.exit(2);
  }
  console.log(`✓ OCR terminado en ${((Date.now() - t0) / 1000).toFixed(1)}s — ${r.numPages} página(s)`);
  for (const p of r.pages) {
    console.log(`   · página ${p.page}: confianza ${p.confidence}%, ${p.text.length} caracteres`);
  }

  const destino = path.join(config.TEMP_DIR, `ocr-probe-${path.basename(pdf)}.txt`);
  fs.writeFileSync(destino, r.text, 'utf8');
  console.log(`   texto crudo → ${destino}`);

  const c = extraerCamposPagare(r.text);
  console.log('\nCampos extraídos:', JSON.stringify(c, null, 1));

  console.log('\nDiagnóstico:');
  if (r.text.trim().length < 200) {
    console.log('  ✗ El OCR devolvió casi nada. El PDF puede venir en blanco, muy');
    console.log('    borroso o al revés. Ábrelo y míralo antes de tocar código.');
  } else if (!c.numeroPagare) {
    // Se busca a mano para saber si el número ESTÁ y el patrón no lo pilla.
    const sueltos = [...r.text.matchAll(/\b\d[\d.\s]{6,}\d\b/g)].map((m) => m[0].trim()).slice(0, 10);
    console.log('  ✗ No se encontró "PAGARÉ No. <número>" en el texto.');
    console.log(`    Números largos que SÍ leyó: ${sueltos.length ? sueltos.join(' | ') : '(ninguno)'}`);
    console.log('    Si el número correcto está en esa lista, el fallo es del patrón');
    console.log('    de búsqueda. Si no está, el pagaré no lo trae impreso o el OCR');
    console.log('    no lo lee, y hay que capturarlo a mano desde la web.');
  } else {
    console.log(`  ✓ Número leído: ${c.numeroPagare}`);
    console.log(`    diligenciado=${c.diligenciado}. Si la demanda igual usó la`);
    console.log('    OBLIGACION del Excel, el problema no es el OCR.');
  }

  await cerrarOcr().catch(() => {});
})().catch(async (e) => {
  console.error('sonda rota:', e);
  await cerrarOcr().catch(() => {});
  process.exit(1);
});
