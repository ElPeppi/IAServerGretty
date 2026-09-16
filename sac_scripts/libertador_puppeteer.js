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
async function buscarSolicitud(page, numero) {
  const num = String(numero).trim();
  log(`Buscando solicitud ${num}…`);
  await page.waitForSelector('#select-box-input-quickSearch', { visible: true, timeout: NAV_TIMEOUT });
  await page.click('#select-box-input-quickSearch', { clickCount: 3 });
  await page.type('#select-box-input-quickSearch', num, { delay: 40 });
  await waitMs(800); // dar chance al autocompletado del select-box

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
  await waitMs(2500);
  log('Resultados/ficha cargados (o timeout); continúo.');
}

// ─── Abrir el siniestro "Vigente" del grid de resultados ──────────────────────
// Regla de negocio (definida por la oficina): de los N siniestros que devuelve
// una solicitud, se abre el que tiene Estado del Siniestro = "Vigente"; si hay
// varios, el de Fecha de Mora más reciente. El grid es un Oracle JET DataGrid
// (celdas div.oj-datagrid-cell[row-id][column-id]); el "Abrir" de cada fila es
// un span.recordCommandLink en la columna "Acciones".
async function abrirSiniestroVigente(page) {
  log('Seleccionando la fila con Estado del Siniestro = "Vigente"…');
  await page.waitForSelector('.oj-datagrid-cell .recordCommandLink', { timeout: NAV_TIMEOUT })
    .catch(() => { throw new Error('No apareció el grid de resultados (recordCommandLink).'); });
  await waitMs(1200);

  const elegido = await page.evaluate(() => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const headers = [...document.querySelectorAll('.oj-datagrid-header-cell-text')].map((h) => norm(h.textContent));
    const estadoIdx = headers.findIndex((h) => /estado del siniestro/i.test(h));
    const fechaIdx  = headers.findIndex((h) => /fecha de mora/i.test(h));
    const amparoIdx = headers.findIndex((h) => /^amparo$/i.test(h));

    const rows = {};
    document.querySelectorAll('.oj-datagrid-cell[row-id][column-id]').forEach((c) => {
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
    if (!candidatas.length) return { error: 'Ninguna fila con Estado = Vigente', filas };

    candidatas.sort((a, b) => (parseFecha(b.fecha) - parseFecha(a.fecha)) || (+b.id - +a.id));
    const sel = candidatas[0];

    const cell = document.querySelector(`.oj-datagrid-cell[row-id="${sel.id}"][column-id="${sel.abrirCol}"] .recordCommandLink`)
              || document.querySelector(`.oj-datagrid-cell[row-id="${sel.id}"] .recordCommandLink`);
    if (!cell) return { error: `No encontré el "Abrir" de la fila ${sel.id}`, filas };
    cell.setAttribute('data-abrir-target', '1');
    return { rowId: sel.id, amparo: sel.amparo, estado: sel.estado, fecha: sel.fecha, totalFilas: filas.length };
  });

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
        await irAEstadoDeCuenta(page);
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
    salir({ success: true, finalUrl, solicitud: solicitud || null, seleccion, screenshot: shot, exploracion });
  } catch (e) {
    shot = path.join(TEMP_DIR, 'libertador_login_error.png');
    await page.screenshot({ path: shot, fullPage: false }).catch(() => { shot = null; });
    log(`❌ Login falló: ${e.message}`);
    await browser.close();
    salir({ success: false, error: e.message, finalUrl: page.url(), screenshot: shot }, 1);
  }
}

main().catch((e) => salir({ success: false, error: e.message }, 1));
