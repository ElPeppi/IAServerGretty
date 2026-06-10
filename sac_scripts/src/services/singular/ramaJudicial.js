/**
 * services/singular/ramaJudicial.js — Directorio de correos de la Rama Judicial
 *
 * Scrapea https://www.ramajudicial.gov.co (una sola carga por proceso) para
 * encontrar el correo del juzgado de cada ciudad y detectar qué tipos de
 * juzgado existen allí (Pequeñas Causas / Promiscuo).
 * Cache en memoria + archivo JSON con TTL de 7 días.
 */

'use strict';

const fs = require('fs');

const RAMA_URL  = 'https://www.ramajudicial.gov.co/es/directorio-cuentas-de-correo-electronico';
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 días

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

module.exports = { loadRamaCache, buscarCorreoJuzgado };
