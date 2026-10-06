/**
 * libertador_puppeteer.js
 * Login a El Libertador (Oracle Service Cloud / RightNow CX) vía AgentWeb
 * (agente en explorador). Cliente DISTINTO de Finandina — NO comparte portal
 * ni login con sac_puppeteer.js.
 *
 * El acceso automatizable es AgentWeb: al navegar a la URL se dispara el flujo
 * SSO propio de Oracle, que muestra un formulario clásico usuario/contraseña
 * (#loginform → #username / #password / #loginbutton). Corre en Chromium
 * headless, incluido el servidor Linux.
 *
 * Uso (local, credenciales desde sac_scripts/.env):
 *   node libertador_puppeteer.js
 * Uso (explícito):
 *   node libertador_puppeteer.js <agentWebUrl> <usuario> <password>
 * Ver el navegador (diagnóstico del login a mano):
 *   HEADLESS=false node libertador_puppeteer.js
 *
 * Salida stdout: JSON → { success, finalUrl, screenshot?, error? }
 * Logs de progreso van a stderr (no contaminan el JSON de stdout).
 */
'use strict';

const puppeteer = require('puppeteer');
const { construirMeses } = require('./src/services/libertador/estadoCuentaDesdePortal');
const { escribirPlantilla } = require('./src/services/libertador/plantillaXlsx');
const path = require('path');
const fs   = require('fs');

// Cargar .env (best-effort) para poder correr sin argumentos en local.
// quiet: true → dotenv v17 imprime un banner en stdout que contaminaría el JSON.
try { require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true }); } catch (_) {}

const AGENTWEB_URL = process.argv[2] || process.env.LIBERTADOR_SAC_URL || 'https://ellibertador.custhelp.com/AgentWeb/';
const USER = process.argv[3] || process.env.LIBERTADOR_SAC_USER || '';
const PASS = process.argv[4] || process.env.LIBERTADOR_SAC_PASS || '';

const TEMP_DIR = process.env.SAC_TEMP_DIR || 'C:/temp/sac_temp';
const NAV_TIMEOUT = Number(process.env.LIBERTADOR_NAV_TIMEOUT_MS) || 120000;

const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error('[LIBERTADOR]', ...a);

// Sale con un JSON limpio por stdout y termina el proceso.
function salir(obj, code = 0) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(code);
}

// ¿La página muestra todavía el formulario de login SSO?
// User-Agent que el portal acepta: ver nota en main(). Sobreescribible con
// LIBERTADOR_UA si Oracle actualiza su matriz de navegadores soportados.
const UA_PORTAL = process.env.LIBERTADOR_UA
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.102 Safari/537.36';

async function enLoginPage(page) {
  return page.evaluate(() => !!document.querySelector('#loginform #username, #loginform #password'));
}

// Mensaje de error de credenciales, si está visible.
async function errorCredenciales(page) {
  return page.evaluate(() => {
    const t = document.body ? document.body.innerText : '';
    const m = t.match(/no es correcto[^.\n]*|no es correcta[^.\n]*|is incorrect[^.\n]*/i);
    return m ? m[0].trim() : null;
  });
}

async function login(page) {
  log(`Navegando a AgentWeb: ${AGENTWEB_URL}`);
  try {
    await page.goto(AGENTWEB_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  } catch (e) {
    log(`Carga lenta (${e.message}); reintentando una vez…`);
    await page.goto(AGENTWEB_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  }

  // Esperar el formulario de login (el SSO puede tardar en pintarlo).
  await page.waitForSelector('#loginform #username', { visible: true, timeout: NAV_TIMEOUT })
    .catch(() => { throw new Error('No apareció el formulario de login (#loginform #username).'); });

  log('Formulario de login detectado; escribiendo credenciales…');
  await page.click('#username', { clickCount: 3 });
  await page.type('#username', USER, { delay: 30 });
  await page.click('#password', { clickCount: 3 });
  await page.type('#password', PASS, { delay: 30 });

  // Enviar y esperar a que salga de la página de login.
  await Promise.all([
    page.click('#loginbutton'),
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {}),
  ]);
  await waitMs(4000); // AgentWeb tarda en cargar tras autenticar

  // Verificar resultado.
  const errCred = await errorCredenciales(page);
  if (errCred) throw new Error(`Credenciales rechazadas: ${errCred}`);

  const sigueEnLogin = await enLoginPage(page);
  if (sigueEnLogin) throw new Error('Sigue en la página de login tras enviar (revisa usuario/contraseña o SSO).');

  return page.url();
}

// ─── Buscar una solicitud ─────────────────────────────────────────────────────
// AgentWeb tiene arriba un "Búsqueda rápida" (Oracle JET select-box) con
// placeholder "# Solicitud". Se escribe el número y se envía; el workspace
// (ficha "NNNN-BÁSICO") se monta en el documento principal.
//   input:  #select-box-input-quickSearch
//   botón:  #quickSearchSearchButton (title "Buscar")
/**
 * Escribe el nº de solicitud en la "Búsqueda rápida" y COMPRUEBA que quedó.
 *
 * El campo es un select-box de Oracle JET (autocomplete) que se repinta en cada
 * pulsación: escribiendo con delay corto se traga todos los caracteres menos el
 * último. Se buscaba "8" en vez de "6929878" y el grid salía vacío —sin error,
 * porque buscar algo que no existe es una búsqueda válida—. Por eso: se escribe
 * despacio, se verifica, y si aun así no cuaja se asigna el valor por JS
 * notificando a JET. Si tampoco, se lanza error en vez de buscar cualquier cosa.
 */
async function escribirQuickSearch(page, num) {
  const SEL = '#select-box-input-quickSearch';
  await page.waitForSelector(SEL, { visible: true, timeout: NAV_TIMEOUT });

  await page.click(SEL, { clickCount: 3 });
  await page.keyboard.press('Backspace').catch(() => {});
  await page.type(SEL, num, { delay: 150 });
  await waitMs(600);

  const leer = () => page.$eval(SEL, (el) => el.value);
  let valor = await leer();

  if (valor !== num) {
    log(`El buscador quedó en "${valor}" en vez de "${num}"; lo fuerzo por JS.`);
    await page.$eval(SEL, (el, v) => {
      // El setter nativo + eventos burbujeantes es lo que escuchan JET/Knockout.
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, v);
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, num);
    await waitMs(600);
    valor = await leer();
  }

  if (valor !== num) {
    throw new Error(`No pude escribir la solicitud en la búsqueda rápida (quedó "${valor}" en vez de "${num}").`);
  }
  log(`Búsqueda rápida con "${valor}".`);
}

async function buscarSolicitud(page, numero) {
  const num = String(numero).trim();
  log(`Buscando solicitud ${num}…`);
  await escribirQuickSearch(page, num);

  const btn = await page.$('#quickSearchSearchButton');
  if (btn) await btn.click();
  else await page.keyboard.press('Enter');

  // La búsqueda por # Solicitud NO abre la ficha directo: abre un reporte de
  // resultados (grid "Buscar Solicitud") con una fila por siniestro. Esperamos
  // a que aparezca el grid (recordCommandLink = enlace "Abrir") o, por si algún
  // caso abriera la ficha directo, los campos de la ficha Siniestro.
  await page.waitForFunction(
    (n) => {
      const t = document.body ? document.body.innerText : '';
      return !!document.querySelector('.oj-datagrid-cell .recordCommandLink')
        || /Estado de Cuenta/i.test(t)
        || (t.includes(n) && /Arrendatario|Valor Canon/i.test(t));
    },
    { timeout: NAV_TIMEOUT },
    num
  ).catch(() => log('No confirmé resultados ni ficha; explorando el estado actual de todas formas.'));
  await waitMs(1500);
  await esperarGridEstable(page);
  log('Resultados/ficha cargados; continúo.');
}

// ─── Abrir el siniestro "Vigente" del grid de resultados ──────────────────────
// Regla de negocio (definida por la oficina): de los N siniestros que devuelve
// una solicitud, se abre el que tiene Estado del Siniestro = "Vigente"; si hay
// varios, el de Fecha de Mora más reciente. El grid es un Oracle JET DataGrid
// (celdas div.oj-datagrid-cell[row-id][column-id]); el "Abrir" de cada fila es
// un span.recordCommandLink en la columna "Acciones".
/**
 * Lee la tabla de movimientos del Estado de Cuenta.
 *
 * Dos trampas, las dos silenciosas si no se tratan:
 *  - La tabla NO está en AgentWeb: vive en un iframe de segurosbolivar.com
 *    (módulo "Cartera Libertador"), y además es JSF/PrimeFaces, no Oracle JET.
 *    Buscarla en el documento principal no devuelve nada.
 *  - Pagina de 5 en 5. Leer lo visible daría un estado de cuenta incompleto sin
 *    que nadie lo note, así que se sube el tamaño de página al máximo del select
 *    y se comprueba contra el contador "(Registros: 1 - N de TOTAL)".
 *
 * Devuelve { headers, movimientos, totales, totalesSolicitud, registros }.
 */
async function leerEstadoDeCuenta(page) {
  const frame = page.frames().find((f) => /CarteraLibertadorRightNow/i.test(f.url()));
  if (!frame) throw new Error('No encontré el panel de Cartera Libertador (iframe de segurosbolivar.com).');

  const subio = await frame.evaluate(() => {
    const sel = document.querySelector('select.ui-paginator-rpp-options');
    if (!sel) return false;
    const max = [...sel.options].map((o) => Number(o.value)).filter(Number.isFinite).sort((a, b) => b - a)[0];
    if (!max || Number(sel.value) === max) return false;
    sel.value = String(max);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }).catch(() => false);
  if (subio) {
    log('Subiendo el tamaño de página de la tabla…');
    await waitMs(5000);
  }

  const datos = await frame.evaluate(() => {
    const limpio = (s) => String(s || '').replace(/\s+/g, ' ').trim();

    // La tabla buena es la que tiene la columna "Saldo Deuda".
    const tabla = [...document.querySelectorAll('table')].find((t) =>
      [...t.querySelectorAll('th')].some((th) => /saldo\s+deuda/i.test(th.textContent || '')));
    if (!tabla) return { error: 'No encontré la tabla de movimientos (sin columna "Saldo Deuda").' };

    const headers = [...tabla.querySelectorAll('thead th')].map((th) => limpio(th.textContent)).filter(Boolean);

    const movimientos = [];
    let totales = null, totalesSolicitud = null;
    for (const tr of tabla.querySelectorAll('tbody tr')) {
      const celdas = [...tr.querySelectorAll('td')].map((td) => limpio(td.textContent));
      if (!celdas.length) continue;
      const primera = celdas[0] || '';
      // Las filas de totales traen menos columnas y el rótulo en la primera.
      if (/^totales\s+solicitud/i.test(primera)) { totalesSolicitud = celdas; continue; }
      if (/^totales/i.test(primera)) { totales = celdas; continue; }
      if (celdas.length !== headers.length) continue;  // filas de relleno
      const fila = {};
      headers.forEach((h, i) => { fila[h] = celdas[i] ?? ''; });
      movimientos.push(fila);
    }

    const contador = limpio(document.querySelector('.ui-paginator-current')?.textContent || '');
    return { headers, movimientos, totales, totalesSolicitud, contador };
  });

  if (datos.error) throw new Error(datos.error);

  // "(Registros: 1 - 7 de 7)": si el total no coincide con lo leído, se avisa en
  // vez de devolver un estado de cuenta corto que parecería completo.
  const m = String(datos.contador || '').match(/de\s+(\d+)/i);
  const esperados = m ? Number(m[1]) : null;
  if (esperados !== null && datos.movimientos.length !== esperados) {
    throw new Error(`La tabla dice ${esperados} movimiento(s) y leí ${datos.movimientos.length} — quedó paginada.`);
  }
  log(`Estado de cuenta: ${datos.movimientos.length} movimiento(s) leídos.`);
  return { ...datos, registros: datos.movimientos.length };
}

/**
 * Espera a que el datagrid termine de pintarse.
 *
 * El JET DataGrid renderiza por lotes: justo tras la búsqueda ya hay celdas en el
 * DOM pero faltan filas. Leerlo ahí daba listas de estados vacías y —peor— podía
 * omitir un siniestro Vigente que todavía no se había pintado, en silencio.
 * Se espera a que el número de celdas se repita dos muestras seguidas.
 */
async function esperarGridEstable(page) {
  const contar = () => page.evaluate(() => {
    const visibles = [...document.querySelectorAll('.oj-datagrid')].filter((g) => g.offsetParent !== null);
    const grid = visibles[visibles.length - 1];
    return grid ? grid.querySelectorAll('.oj-datagrid-cell[row-id][column-id]').length : 0;
  }).catch(() => 0);

  let previo = -1, repeticiones = 0;
  for (let intento = 0; intento < 20; intento++) {
    const n = await contar();
    if (n > 0 && n === previo) {
      if (++repeticiones >= 2) { log(`Grid estable: ${n} celda(s).`); return n; }
    } else {
      repeticiones = 0;
    }
    previo = n;
    await waitMs(700);
  }
  log(`Grid no se estabilizó (última cuenta: ${previo}); sigo igual.`);
  return previo;
}

async function abrirSiniestroVigente(page) {
  log('Seleccionando la fila con Estado del Siniestro = "Vigente"…');
  await page.waitForSelector('.oj-datagrid-cell .recordCommandLink', { timeout: NAV_TIMEOUT })
    .catch(() => { throw new Error('No apareció el grid de resultados (recordCommandLink).'); });
  await waitMs(1200);

  const elegido = await page.evaluate(() => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    // AgentWeb acumula pestañas: tras recargar restaura la búsqueda anterior y en
    // el DOM conviven VARIOS datagrids. Consultar el documento entero mezclaba sus
    // celdas por row-id (se leían teléfonos como estados). Se acota al grid VISIBLE.
    const visibles = [...document.querySelectorAll('.oj-datagrid')].filter((g) => g.offsetParent !== null);
    const grid = visibles[visibles.length - 1] || document;

    const headers = [...grid.querySelectorAll('.oj-datagrid-header-cell-text')].map((h) => norm(h.textContent));
    const estadoIdx = headers.findIndex((h) => /estado del siniestro/i.test(h));
    const fechaIdx  = headers.findIndex((h) => /fecha de mora/i.test(h));
    const amparoIdx = headers.findIndex((h) => /^amparo$/i.test(h));

    // Si en la página hay MÁS de un datagrid (p. ej. quedó abierta la ficha del
    // caso anterior), los encabezados de los dos se mezclan y los índices caen en
    // columnas ajenas: se leían teléfonos como si fueran el estado del siniestro.
    // Sin las tres columnas del reporte "Buscar Solicitud" no se lee nada.
    if (estadoIdx < 0 || fechaIdx < 0 || amparoIdx < 0) {
      return { gridInesperado: true, headers };
    }

    const rows = {};
    grid.querySelectorAll('.oj-datagrid-cell[row-id][column-id]').forEach((c) => {
      const r = c.getAttribute('row-id');
      const col = +c.getAttribute('column-id');
      if (!rows[r]) rows[r] = { cells: {}, abrirCol: null };
      rows[r].cells[col] = norm(c.textContent);
      if (c.querySelector('.recordCommandLink')) rows[r].abrirCol = col;
    });

    const parseFecha = (s) => {
      const m = norm(s).match(/(\d{2})\/(\d{2})\/(\d{4})/);
      return m ? new Date(+m[3], +m[2] - 1, +m[1]).getTime() : 0;
    };

    const filas = Object.entries(rows).map(([id, r]) => ({
      id, estado: r.cells[estadoIdx] || '', fecha: r.cells[fechaIdx] || '',
      amparo: r.cells[amparoIdx] || '', abrirCol: r.abrirCol,
    }));
    const candidatas = filas.filter((f) => /vigente/i.test(f.estado));
    // Que un caso no tenga siniestro Vigente es NORMAL (se desistió, terminó o
    // pasó a cartera castigada): no es un fallo del scraping, así que se informa
    // como omisión y el lote sigue con los demás.
    if (!candidatas.length) return { sinVigente: true, filas };

    candidatas.sort((a, b) => (parseFecha(b.fecha) - parseFecha(a.fecha)) || (+b.id - +a.id));
    const sel = candidatas[0];

    const cell = grid.querySelector(`.oj-datagrid-cell[row-id="${sel.id}"][column-id="${sel.abrirCol}"] .recordCommandLink`)
              || grid.querySelector(`.oj-datagrid-cell[row-id="${sel.id}"] .recordCommandLink`);
    if (!cell) return { error: `No encontré el "Abrir" de la fila ${sel.id}`, filas };
    cell.setAttribute('data-abrir-target', '1');
    return { rowId: sel.id, amparo: sel.amparo, estado: sel.estado, fecha: sel.fecha, totalFilas: filas.length };
  });

  if (elegido.gridInesperado) {
    throw new Error('El grid en pantalla no es el reporte "Buscar Solicitud" '
      + `(encabezados: ${(elegido.headers || []).slice(0, 12).join(' | ')})`);
  }
  if (elegido.sinVigente) {
    const estados = [...new Set((elegido.filas || [])
      .map((f) => f.estado).filter((e) => e && e !== 'Sin valor'))];
    const motivo = `ningún siniestro con Estado = "Vigente"`
      + (estados.length ? ` (los que hay: ${estados.join(', ')})` : '');
    log(`⊘ Omitida: ${motivo}`);
    return { omitido: true, motivo, estados, filas: elegido.filas || [] };
  }
  if (elegido.error) {
    throw new Error(`${elegido.error}. Filas: ${JSON.stringify(elegido.filas || [])}`);
  }
  log(`Fila elegida → row ${elegido.rowId} | ${elegido.amparo} | ${elegido.estado} | mora ${elegido.fecha} (de ${elegido.totalFilas} filas). Abriendo…`);

  await page.click('[data-abrir-target="1"]');
  // Esperar a que abra la ficha del siniestro (pestaña Estado de Cuenta / campos).
  await page.waitForFunction(
    () => /Estado de Cuenta|Valor Canon|Arrendatario/i.test(document.body ? document.body.innerText : ''),
    { timeout: NAV_TIMEOUT }
  ).catch(() => log('No confirmé la carga de la ficha tras "Abrir"; sigo.'));
  await waitMs(4000);
  log('Ficha del siniestro abierta (o timeout).');
  return elegido;
}

// ─── Ir a la pestaña "Estado de Cuenta" de la ficha ───────────────────────────
// Las pestañas de la ficha son <li class="ws-tab-item"> con un <span class="tab-title">.
// El id lleva el id interno del siniestro (dinámico), así que seleccionamos por
// el TEXTO exacto "Estado de Cuenta" (evita "Estado de Cuenta Póliza" y
// "Novedades Estado de Cuenta").
async function irAEstadoDeCuenta(page) {
  log('Abriendo la pestaña "Estado de Cuenta"…');
  const ok = await page.evaluate(() => {
    const lis = [...document.querySelectorAll('li.ws-tab-item')];
    const li = lis.find((el) => {
      const t = el.querySelector('.tab-title');
      return t && t.textContent.replace(/\s+/g, ' ').trim() === 'Estado de Cuenta';
    });
    if (!li) return false;
    li.setAttribute('data-eqc-target', '1');
    return true;
  });
  if (!ok) throw new Error('No encontré la pestaña "Estado de Cuenta".');

  await page.click('[data-eqc-target="1"]');
  await waitMs(5000); // el contenido del estado de cuenta puede tardar en pintar
  log('Pestaña Estado de Cuenta abierta (o timeout).');
}

// ─── Modo exploración ─────────────────────────────────────────────────────────
// Tras el login, AgentWeb es un SPA con el workspace dentro de iframes. Para NO
// adivinar selectores, volcamos a disco el árbol de frames + inputs/botones/
// pestañas reales de cada frame y su HTML. Se dispara con LIBERTADOR_EXPLORE=1.
async function explorar(page, dir) {
  log('Modo exploración: esperando a que AgentWeb termine de cargar…');
  // Señal de "cargado": aparece el buscador superior (placeholder "Solicitud")
  // o simplemente damos un margen generoso al SPA.
  await page.waitForFunction(
    () => /Solicitud/i.test(document.body ? document.body.innerText : ''),
    { timeout: 60000 }
  ).catch(() => log('No detecté el texto "Solicitud"; sigo igualmente.'));
  await waitMs(6000);

  const pick = (el) => ({
    tag: el.tagName, type: el.type || '', id: el.id || '', name: el.name || '',
    cls: (el.className || '').toString().slice(0, 90),
    aria: el.getAttribute('aria-label') || '', title: el.getAttribute('title') || '',
    ph: el.getAttribute('placeholder') || '',
    text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 50),
    vis: !!el.offsetParent,
  });

  const frames = page.frames();
  log(`${frames.length} frame(s) detectados.`);
  const reporte = [];
  for (let i = 0; i < frames.length; i++) {
    const fr = frames[i];
    const info = { idx: i, url: fr.url(), name: fr.name() };
    try {
      info.elements = await fr.evaluate((pickStr) => {
        const pick = eval('(' + pickStr + ')');
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const q = (sel) => [...document.querySelectorAll(sel)];
        // Datagrids Oracle JET → filas estructuradas (headers + celdas por row-id/column-id).
        const datagrids = q('.oj-datagrid').map((g, gi) => {
          const headers = [...g.querySelectorAll('.oj-datagrid-header-cell-text')].map((h) => norm(h.textContent));
          const rowsMap = {};
          g.querySelectorAll('.oj-datagrid-cell[row-id][column-id]').forEach((c) => {
            const r = c.getAttribute('row-id');
            const col = +c.getAttribute('column-id');
            if (!rowsMap[r]) rowsMap[r] = {};
            rowsMap[r][col] = norm(c.textContent);
          });
          const rows = Object.entries(rowsMap).map(([id, cells]) => ({ id, cells }));
          return { gi, headers, filas: rows.length, rows: rows.slice(0, 60) };
        }).filter((g) => g.headers.length || g.filas);
        return {
          inputs: q('input,textarea,select').map(pick),
          buttons: q('button,[role=button],input[type=submit],input[type=button]').map(pick).filter(e => e.vis).slice(0, 100),
          tabs: q('[role=tab],[role=tablist] *,.tab,li').map(pick).filter(e => e.text && e.vis).slice(0, 150),
          links: q('a').map(pick).filter(e => e.text && e.vis).slice(0, 150),
          datagrids,
        };
      }, pick.toString());
      const html = await fr.content();
      fs.writeFileSync(path.join(dir, `frame_${i}.html`), html);
    } catch (e) {
      info.error = e.message;
    }
    reporte.push(info);
  }

  const reportePath = path.join(dir, 'libertador_explore.json');
  fs.writeFileSync(reportePath, JSON.stringify(reporte, null, 2));
  const shot = path.join(dir, 'libertador_agentweb.png');
  await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
  log(`Exploración volcada: ${reportePath} (+ frame_*.html) y ${shot}`);
  return { reporte: reportePath, screenshot: shot, frames: frames.length };
}

async function main() {
  if (!USER || !PASS) {
    salir({
      success: false,
      error: 'Faltan credenciales. Pega LIBERTADOR_SAC_USER y LIBERTADOR_SAC_PASS en sac_scripts/.env, o pásalas por argumentos.',
    }, 1);
  }

  fs.mkdirSync(TEMP_DIR, { recursive: true });

  const browser = await puppeteer.launch({
    headless: process.env.HEADLESS === 'false' ? false : 'shell',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1920,1080',
      '--ignore-certificate-errors',
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  // El portal responde 401 {"code":"401"} —sin pintar nunca el login— a todo
  // User-Agent que declare Chrome 99 o superior. Comprobado por bisección contra
  // el IdP: Chrome/98 → 200, Chrome/99 → 401, y lo mismo para 100+. Es el tope de
  // la matriz de navegadores soportados de Oracle, que quedó congelada en Chrome 98.
  // Puppeteer es Chrome 1xx, así que sin esto el worker no pasa de la puerta.
  // Solo cambia la cadena: el motor del navegador sigue siendo el real.
  await page.setUserAgent(UA_PORTAL);
  page.setDefaultTimeout(NAV_TIMEOUT);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT);

  let shot = null;
  try {
    const finalUrl = await login(page);
    shot = path.join(TEMP_DIR, 'libertador_login_ok.png');
    await page.screenshot({ path: shot, fullPage: false }).catch(() => { shot = null; });
    log(`✅ Login OK. URL final: ${finalUrl}`);

    // Solicitud a abrir: argv[5] o LIBERTADOR_SOLICITUD (opcional).
    const solicitud = process.argv[5] || process.env.LIBERTADOR_SOLICITUD || '';
    let seleccion = null;
    if (solicitud) {
      await buscarSolicitud(page, solicitud);
      // Si salió el grid de resultados, abrir el siniestro "Vigente".
      const hayGrid = await page.$('.oj-datagrid-cell .recordCommandLink');
      if (hayGrid) {
        seleccion = await abrirSiniestroVigente(page);
        // Omitida = no hay ficha abierta: no tiene sentido buscar su Estado de Cuenta.
        if (!seleccion.omitido) await irAEstadoDeCuenta(page);
      } else {
        log('No hubo grid de resultados (¿abrió la ficha directo?); intento ir a Estado de Cuenta.');
        await irAEstadoDeCuenta(page).catch((e) => log(e.message));
      }
    }

    let exploracion = null;
    if (process.env.LIBERTADOR_EXPLORE === '1') {
      exploracion = await explorar(page, TEMP_DIR);
    }

    await browser.close();
    // `omitido` viaja aparte para que el backend lo convierta en notificación sin
    // tener que escarbar en `seleccion`.
    salir({
      success: true, finalUrl, solicitud: solicitud || null, seleccion,
      omitido: seleccion && seleccion.omitido ? { solicitud, motivo: seleccion.motivo } : null,
      screenshot: shot, exploracion,
    });
  } catch (e) {
    shot = path.join(TEMP_DIR, 'libertador_login_error.png');
    await page.screenshot({ path: shot, fullPage: false }).catch(() => { shot = null; });
    // Este catch cubre TODO el recorrido (login, búsqueda, grid, ficha), no solo
    // el login: decir "Login falló" mandaba a revisar credenciales que estaban bien.
    log(`❌ Falló: ${e.message}`);
    await browser.close();
    salir({ success: false, error: e.message, finalUrl: page.url(), screenshot: shot }, 1);
  }
}

/**
 * Entrada reutilizable para el motor: procesa VARIAS solicitudes con un solo
 * login (AgentWeb tarda bastante en autenticar; repetirlo por caso no tiene
 * sentido). Nunca lanza por un caso suelto: cada uno devuelve su propio
 * resultado para que el lote siga y el backend pueda notificar uno a uno.
 *
 * Devuelve [{ solicitud, success, omitido?, motivo?, estados?, siniestro?, datos?, error? }]
 */
async function procesarSolicitudes(solicitudes, opts = {}) {
  // Plantilla del estado de cuenta ("ESTADO DE CUENTA IA.xls"). La manda el
  // backend, que es quien habla con Drive; sin ella se devuelven los datos pero
  // no se arma el archivo.
  const plantillaPath = opts.plantillaPath || null;
  if (!USER || !PASS) {
    throw new Error('Faltan credenciales: LIBERTADOR_SAC_USER / LIBERTADOR_SAC_PASS en sac_scripts/.env');
  }
  const lista = (Array.isArray(solicitudes) ? solicitudes : [solicitudes])
    .map((x) => String(x || '').trim()).filter(Boolean);
  if (!lista.length) return [];

  fs.mkdirSync(TEMP_DIR, { recursive: true });
  const browser = await puppeteer.launch({
    headless: opts.headless === false || process.env.HEADLESS === 'false' ? false : 'shell',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--window-size=1920,1080', '--ignore-certificate-errors',
    ],
  });

  const resultados = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent(UA_PORTAL);   // sin esto el portal responde 401 (ver nota en main)
    page.setDefaultTimeout(NAV_TIMEOUT);
    page.setDefaultNavigationTimeout(NAV_TIMEOUT);

    await login(page);
    log(`Sesión abierta; procesando ${lista.length} solicitud(es).`);

    let primera = true;
    for (const num of lista) {
      try {
        // La ficha del caso anterior se queda abierta en su pestaña y su datagrid
        // contamina la lectura del siguiente. Recargar AgentWeb deja el workspace
        // limpio y NO re-autentica: la sesión viaja en cookies.
        if (!primera) {
          await page.goto(AGENTWEB_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
          await waitMs(3000);
        }
        primera = false;

        await buscarSolicitud(page, num);

        const hayGrid = await page.$('.oj-datagrid-cell .recordCommandLink');
        if (!hayGrid) {
          resultados.push({ solicitud: num, success: false, motivo: 'la búsqueda no devolvió resultados en el portal' });
          log(`⊘ ${num}: sin resultados.`);
          continue;
        }

        const sel = await abrirSiniestroVigente(page);
        if (sel.omitido) {
          resultados.push({ solicitud: num, success: false, omitido: true, motivo: sel.motivo, estados: sel.estados });
          continue;
        }

        await irAEstadoDeCuenta(page);
        const estado = await leerEstadoDeCuenta(page);

        // Movimientos del portal → meses de la plantilla. Se calcula siempre
        // (sirve de traza aunque no haya plantilla con la que armar el archivo).
        const cuadro = construirMeses(estado.movimientos);
        for (const aviso of cuadro.avisos) log(`⚠ ${num}: ${aviso}`);

        let archivoBase64 = null;
        if (plantillaPath) {
          try {
            const buf = await escribirPlantilla(cuadro, plantillaPath, {
              solicitud: num,
              elaboro: opts.elaboro || '',
              fechaElaboracion: new Date().toLocaleDateString('es-CO'),
            });
            archivoBase64 = buf.toString('base64');
          } catch (e) {
            // Que falle el Excel no invalida lo leído del portal: se devuelven
            // los meses igual y el motivo queda en el resultado.
            log(`✗ ${num}: no se pudo armar el Excel: ${e.message}`);
            cuadro.avisos.push(`No se pudo armar el Excel: ${e.message}`);
          }
        }

        resultados.push({
          solicitud: num,
          success: true,
          siniestro: { amparo: sel.amparo, estado: sel.estado, fechaMora: sel.fecha },
          datos: estado,
          cuadro: {
            meses: cuadro.meses.map((m) => ({
              mes: m.fecha.toISOString().slice(0, 10),
              deuda: m.deuda, abono: m.abono, saldo: m.saldo,
            })),
            totales: cuadro.totales,
            avisos: cuadro.avisos,
          },
          archivoBase64,
          nombreArchivo: `ESTADO DE CUENTA ${num}.xlsx`,
        });
        log(`✓ ${num}: ${estado.registros} movimiento(s) → ${cuadro.meses.length} mes(es)` + (archivoBase64 ? ' + Excel' : ''));
      } catch (e) {
        resultados.push({ solicitud: num, success: false, error: e.message });
        log(`✗ ${num}: ${e.message}`);
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return resultados;
}

module.exports = { procesarSolicitudes };

// Solo se autoejecuta como CLI; al requerirlo desde el motor, no.
if (require.main === module) {
  main().catch((e) => salir({ success: false, error: e.message }, 1));
}
