/**
 * services/singular/ramaJudicial.js — Especialidades y correos de juzgados por ciudad
 *
 * Fuente automática: el directorio oficial de cuentas de correo de la Rama
 * Judicial, publicado como reporte Power BI embebido en
 * https://www.ramajudicial.gov.co/es/directorio-cuentas-de-correo-electronico
 * (la página HTML quedó vacía tras la migración del portal; los datos viven
 * en el reporte). Se filtra el slicer CIUDAD y se lee la tabla de cuentas.
 *
 * Orden de fuentes:
 *   1. Config manual del despacho (juzgados_config.json) — override total.
 *   2. Cache (30 días) del Power BI.
 *   3. Consulta Power BI en vivo.
 *   4. Default: sin especialidades → CIVIL MUNICIPAL (en domain/cuantia).
 */

'use strict';

const fs = require('fs');

const { buscarEnConfig } = require('./juzgadosConfig');

const PBI_URL = 'https://app.powerbi.com/view?r=eyJrIjoiMjllZTNjNGYtNjYzMi00ZjUzLTgyMGYtNzE0OWNlZjM0YTY2IiwidCI6IjYyMmNiYTk4LTgwZjgtNDFmMy04ZGY1LThlYjk5OTAxNTk4YiIsImMiOjR9';
const CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 días — el directorio cambia poco

function normText(s) {
  return (s || '').toUpperCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z0-9\s@.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Cache en memoria + fichero ───────────────────────────────────────────────

const _ramaCache = {};

function loadRamaCache(cacheFile) {
  if (Object.keys(_ramaCache).length > 0) return;
  try {
    if (fs.existsSync(cacheFile)) {
      Object.assign(_ramaCache, JSON.parse(fs.readFileSync(cacheFile, 'utf8')));
    }
  } catch (_) {}
}

function saveRamaCache(cacheFile) {
  try {
    fs.writeFileSync(cacheFile, JSON.stringify(_ramaCache, null, 2), 'utf8');
  } catch (_) {}
}

// ─── Reporte Power BI (una página por proceso, reutilizada entre ciudades) ───

let _pbiPage = null;

async function abrirReportePBI(browser) {
  // Página cacheada solo si el slicer CIUDAD sigue presente (no quedó en mal estado)
  if (_pbiPage && !_pbiPage.isClosed() && await tieneSlicerCiudad(_pbiPage)) {
    return _pbiPage;
  }
  if (_pbiPage && !_pbiPage.isClosed()) { await _pbiPage.close().catch(() => {}); _pbiPage = null; }

  // Hasta 2 intentos de cargar el reporte y esperar a que pinte el slicer CIUDAD
  for (let intento = 1; intento <= 2; intento++) {
    console.error(`[RAMA-PBI] Cargando directorio Power BI de la Rama Judicial (intento ${intento})...`);
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 1000 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
    );
    try {
      await page.goto(PBI_URL, { waitUntil: 'networkidle2', timeout: 90000 });
      await page.waitForFunction(
        () => [...document.querySelectorAll('div.slicer-container')]
          .some(s => (s.textContent || '').trim().toUpperCase().startsWith('CIUDAD')),
        { timeout: 60000 }
      );
      await new Promise(r => setTimeout(r, 2000));
      _pbiPage = page;
      return page;
    } catch (e) {
      console.error(`[RAMA-PBI] El slicer CIUDAD no apareció (intento ${intento}): ${e.message}`);
      await page.close().catch(() => {});
    }
  }
  throw new Error('reporte Power BI no renderizó el slicer CIUDAD tras 2 intentos');
}

// ¿La página tiene el slicer CIUDAD listo?
async function tieneSlicerCiudad(page) {
  try {
    return await page.evaluate(() => [...document.querySelectorAll('div.slicer-container')]
      .some(s => (s.textContent || '').trim().toUpperCase().startsWith('CIUDAD')));
  } catch (_) { return false; }
}

// Devuelve el buscador del slicer CIUDAD.
//
// OJO con el IDIOMA: Power BI se renderiza en el idioma del navegador, y el
// servidor (locale en_US) lo pinta en INGLÉS — el input dice "Search", no
// "Buscar". Buscarlo por ese texto funcionaba en un equipo en español y fallaba
// en producción con "slicer CIUDAD no disponible": la ciudad no se consultaba y
// TODAS las demandas caían al juzgado CIVIL MUNICIPAL por defecto, sin error
// visible. Por eso ahora no se filtra por texto: el slicer solo tiene un input
// y es su buscador.
async function inputSlicerCiudad(page) {
  const handle = await page.evaluateHandle(() => {
    const s = [...document.querySelectorAll('div.slicer-container')]
      .find(s => (s.textContent || '').trim().toUpperCase().startsWith('CIUDAD'));
    return s ? s.querySelector('input') : null;
  });
  return (await page.evaluate(el => !!el, handle)) ? handle.asElement() : null;
}

// Lee las filas visibles de la tabla de cuentas y las estructura.
// Las celdas se anclan en la que contiene '@' (email).
function leerFilasVisibles() {
  const rows = [...document.querySelectorAll('[role="row"]')];
  const out = [];
  for (const r of rows) {
    const cells = [...r.querySelectorAll('[role="gridcell"]')].map(c => c.textContent.trim());
    const iEmail = cells.findIndex(c => c.includes('@'));
    if (iEmail < 0) continue;
    out.push({
      email:        cells[iEmail]     || '',
      nombre:       cells[iEmail + 1] || '',
      depto:        cells[iEmail + 2] || '',
      ciudad:       cells[iEmail + 3] || '',
      corporacion:  cells[iEmail + 4] || '',
      especialidad: cells[iEmail + 5] || '',
      tipo:         cells[iEmail + 6] || '',
      codigo:       cells[iEmail + 7] || '',
    });
  }
  return out;
}

// Recolecta las filas de la tabla haciendo scroll del visual (scroll virtual de
// Power BI). Corta cuando no aparecen filas nuevas o al llegar al tope.
async function recolectarFilas(page, maxFilas = 400) {
  const vistas = new Map();

  const agregar = filas => {
    for (const f of filas) {
      const k = f.email + '|' + f.codigo;
      if (!vistas.has(k)) vistas.set(k, f);
    }
  };

  agregar(await page.evaluate(leerFilasVisibles));

  // Punto de scroll: centro del visual de tabla (el grid con role="grid")
  const box = await page.evaluate(() => {
    const g = document.querySelector('[role="grid"]');
    if (!g) return null;
    const r = g.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });

  if (box) {
    let sinNuevas = 0;
    for (let i = 0; i < 30 && vistas.size < maxFilas && sinNuevas < 3; i++) {
      const antes = vistas.size;
      await page.mouse.move(box.x, box.y);
      await page.mouse.wheel({ deltaY: 600 });
      await new Promise(r => setTimeout(r, 700));
      agregar(await page.evaluate(leerFilasVisibles));
      sinNuevas = vistas.size === antes ? sinNuevas + 1 : 0;
    }
  }
  return [...vistas.values()];
}

// Consulta el directorio por ciudad: filtra el slicer y analiza las cuentas.
async function consultarCiudadPBI(browser, ciudad) {
  const page = await abrirReportePBI(browser);
  const ciudadNorm = normText(ciudad);

  const input = await inputSlicerCiudad(page);
  if (!input) throw new Error('slicer CIUDAD no disponible');

  // La búsqueda del slicer es sensible a tildes y el Excel llega sin ellas
  // ("CERETE" no encuentra "Cereté"). Se busca con prefijos decrecientes hasta
  // que aparezcan opciones, y se elige la que coincida normalizada.
  let seleccion = null;
  for (let len = ciudad.length; len >= 4 && !seleccion; len--) {
    const consulta = ciudad.substring(0, len).toLowerCase();
    await input.click({ clickCount: 3 });
    await page.keyboard.press('Backspace');
    await input.type(consulta, { delay: 80 });
    await new Promise(r => setTimeout(r, 3000));

    seleccion = await page.evaluate((cn) => {
      const norm = s => (s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
      const s = [...document.querySelectorAll('div.slicer-container')]
        .find(s => (s.textContent || '').trim().toUpperCase().startsWith('CIUDAD'));
      if (!s) return null;
      const items = [...s.querySelectorAll('.slicerItemContainer')];
      if (items.length === 0) return null;
      // Coincidencia exacta normalizada; con prefijos cortos pueden salir
      // varias ciudades y solo aceptamos la exacta.
      const item = items.find(i => norm(i.textContent) === cn);
      if (item) { item.click(); return norm(item.textContent); }
      // Si la consulta fue la ciudad completa y solo hay una opción, aceptarla
      return null;
    }, ciudadNorm);
  }

  if (!seleccion) {
    await input.click({ clickCount: 3 });
    await page.keyboard.press('Backspace');
    return { encontrado: false, filas: [] };
  }
  await new Promise(r => setTimeout(r, 6000));

  const filas = await recolectarFilas(page);

  // Quitar el filtro para la siguiente ciudad: toggle de la opción + limpiar buscador
  await page.evaluate((cn) => {
    const norm = s => (s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
    const s = [...document.querySelectorAll('div.slicer-container')]
      .find(s => (s.textContent || '').trim().toUpperCase().startsWith('CIUDAD'));
    const item = s && [...s.querySelectorAll('.slicerItemContainer')].find(i => norm(i.textContent) === cn);
    if (item) item.click();
  }, seleccion).catch(() => {});
  await input.click({ clickCount: 3 }).catch(() => {});
  await page.keyboard.press('Backspace').catch(() => {});
  await new Promise(r => setTimeout(r, 1500));

  return { encontrado: filas.length > 0, filas };
}

// ─── Análisis de cuentas → especialidades + correos ──────────────────────────

function analizarCuentas(filas) {
  const up = s => normText(s);
  const esMpal = f => up(f.corporacion).includes('MUNICIPAL');
  const esCto  = f => up(f.corporacion).includes('CIRCUITO');
  const texto  = f => up(f.nombre + ' ' + f.especialidad);

  const pequenas  = filas.filter(f => /PEQUENAS CAUSAS/.test(texto(f)));
  const civilMpal = filas.filter(f => esMpal(f) && up(f.especialidad).includes('CIVIL') && !/PEQUENAS/.test(texto(f)));
  const promMpal  = filas.filter(f => esMpal(f) && up(f.especialidad).includes('PROMISCUO'));
  const civilCto  = filas.filter(f => esCto(f) && up(f.especialidad).includes('CIVIL'));
  const repartos  = filas.filter(f => /REPARTO/.test(texto(f)) || /REPARTO/.test(up(f.email)));

  const hasSmallClaims = pequenas.length > 0;
  // Promiscuo solo aplica cuando la ciudad NO tiene juzgado civil municipal ni pequeñas causas
  const hasPromiscuo = promMpal.length > 0 && civilMpal.length === 0 && !hasSmallClaims;

  const ordenado = arr => [...arr].sort((a, b) => a.email.localeCompare(b.email));

  // Repartos que NO sirven para demandas civiles (penal, laboral, ejecución…)
  const MALOS = /SPOA|PENAL|LABORAL|FAMILIA|ADMINISTRATIV|EJECUCION|ACUSACION|GARANTIAS|TUTELA/;
  const repartosCiviles = repartos.filter(f => !MALOS.test(texto(f)) && !MALOS.test(up(f.email)));
  const repartoDe = re => repartosCiviles.find(f => re.test(texto(f)));

  // Correo municipal: reparto de la especialidad que aplica → reparto general
  // de juzgados (municipios pequeños) → juzgado 001 de la especialidad.
  const repartoMunicipal =
    (hasSmallClaims && repartoDe(/PEQUENAS/)) ||
    (civilMpal.length > 0 && repartoDe(/CIVIL.*MUNICIPAL|MUNICIPAL.*CIVIL/)) ||
    (promMpal.length > 0 && repartoDe(/PROMISCUO/)) ||
    repartoDe(/PROCESOS JUZGADOS/) ||
    repartosCiviles.find(f => esMpal(f));

  const municipal =
    (repartoMunicipal   && repartoMunicipal.email)       ||
    (hasSmallClaims     && ordenado(pequenas)[0].email)  ||
    (civilMpal.length   && ordenado(civilMpal)[0].email) ||
    (promMpal.length    && ordenado(promMpal)[0].email)  || '';

  // Correo circuito: reparto civil de circuito → reparto general → juzgado 001
  const repartoCircuito =
    repartosCiviles.find(f => esCto(f) && /CIVIL/.test(up(f.especialidad))) ||
    repartoDe(/PROCESOS JUZGADOS/);

  const circuito =
    (repartoCircuito && repartoCircuito.email) ||
    (civilCto.length && ordenado(civilCto)[0].email) || '';

  return {
    municipal:      (municipal || '').toLowerCase(),
    circuito:       (circuito  || '').toLowerCase(),
    hasSmallClaims,
    hasPromiscuo,
    cuentas: filas.length,
  };
}

// ─── API principal ────────────────────────────────────────────────────────────

// ¿La ciudad requiere una consulta EN VIVO al Power BI? false si ya está resuelta
// por config manual confirmada o por cache fresca (< 30 días). Sirve para NO lanzar
// Puppeteer cuando la Rama ya está cacheada. Requiere loadRamaCache() previo.
function necesitaConsultaRama(ciudad, cuantia) {
  const ciudadNorm = normText(ciudad);
  if (!ciudadNorm) return false; // sin ciudad no hay nada que consultar
  const cfg = buscarEnConfig(ciudad, cuantia);
  if (cfg.encontrado && cfg.confirmado) return false; // override manual
  const hit = _ramaCache[ciudadNorm];
  if (hit && Date.now() - (hit.ts || 0) < CACHE_TTL && hit.cuentas > 0) return false; // cache fresca
  return true;
}

// Retorna { email, hasSmallClaims, hasPromiscuo }
async function buscarCorreoJuzgado(browser, ciudad, cuantia, cacheFile) {
  const ciudadNorm = normText(ciudad);
  if (!ciudadNorm) return { email: '', hasSmallClaims: false, hasPromiscuo: false };

  // 1. Config manual del despacho (override total cuando está confirmada)
  const cfg = buscarEnConfig(ciudad, cuantia);
  if (cfg.encontrado && cfg.confirmado) {
    console.error(`[JUZGADOS] ${ciudadNorm}: especialidades desde config manual${cfg.email ? ' + correo' : ''}`);
    return { email: cfg.email, hasSmallClaims: cfg.hasSmallClaims, hasPromiscuo: cfg.hasPromiscuo };
  }

  // 2. Cache del Power BI
  let info = null;
  const hit = _ramaCache[ciudadNorm];
  if (hit && Date.now() - (hit.ts || 0) < CACHE_TTL && hit.cuentas > 0) {
    info = hit;
  } else if (browser) {
    // 3. Consulta Power BI en vivo
    try {
      const res = await consultarCiudadPBI(browser, ciudad);
      if (res.encontrado) {
        info = analizarCuentas(res.filas);
        _ramaCache[ciudadNorm] = { ...info, ts: Date.now() };
        saveRamaCache(cacheFile);
        console.error(`[RAMA-PBI] ${ciudadNorm}: ${info.cuentas} cuenta(s) — peq:${info.hasSmallClaims} prom:${info.hasPromiscuo} mpal:${info.municipal || '(no)'}`);
      } else {
        console.error(`[RAMA-PBI] ${ciudadNorm}: sin resultados en el directorio`);
      }
    } catch (e) {
      console.error(`[RAMA-PBI] ${ciudadNorm}: ${e.message}`);
    }
  }

  if (!info) info = { municipal: '', circuito: '', hasSmallClaims: false, hasPromiscuo: false };

  const tipo = cuantia === 'MAYOR' ? 'circuito' : 'municipal';
  return {
    // El correo del config manual (aunque la ciudad no esté confirmada) manda
    email:          cfg.email || info[tipo] || info.municipal || '',
    hasSmallClaims: (cfg.encontrado && cfg.hasSmallClaims) || info.hasSmallClaims || false,
    hasPromiscuo:   (cfg.encontrado && cfg.hasPromiscuo)   || info.hasPromiscuo   || false,
  };
}

// consultarCiudadPBI / analizarCuentas / PBI_URL se exportan para la sonda de
// diagnóstico (probe_rama.js); la generación solo usa buscarCorreoJuzgado.
module.exports = {
  loadRamaCache, buscarCorreoJuzgado, necesitaConsultaRama,
  consultarCiudadPBI, analizarCuentas, PBI_URL,
};
