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

// ─── Formulario de búsqueda avanzada ─────────────────────────────────────────
// La búsqueda rápida EN LÍNEA corre el reporte que tenga seleccionado, y esa
// selección vive en el perfil del navegador, no en la cuenta: en una sesión
// nueva (un servidor recién montado) arranca en otro reporte y devuelve, por
// ejemplo, un grid de contactos —con sus columnas de teléfonos— sin avisar.
//
// El botón de los tres puntos abre #applicationPopup, que es el formulario del
// reporte con el tipo VISIBLE en #reportTypes|input y el campo "# Solicitud"
// aparte. Buscar por ahí no depende del estado de la sesión.
//
// Los ids de AgentWeb llevan '|', que no es un selector CSS válido: hay que
// resolverlos con getElementById, no con page.$.
const REPORTE_SOLICITUD = 'Buscar Solicitud';

/**
 * Pulsa un elemento. El click de Puppeteer es un click de ratón real sobre unas
 * coordenadas, y falla ("Node is either not clickable…") si en ese instante algo
 * lo tapa o mide cero — pasaba en la segunda vuelta de un lote, con el portal
 * recién recargado. El click del DOM no depende de la geometría, así que sirve
 * de red: los botones de JET responden igual a los dos.
 */
async function pulsar(el) {
  try {
    await el.click();
  } catch (e) {
    await el.evaluate((n) => n.click());
  }
}

/** ElementHandle por id, válido aunque el id lleve caracteres raros. */
async function porId(page, id) {
  const h = await page.evaluateHandle((i) => document.getElementById(i), id);
  const el = h.asElement();
  if (!el) { await h.dispose(); return null; }
  return el;
}

/** Input del popup cuya etiqueta coincide con `re` (las etiquetas no cambian; los ids sí). */
async function campoPorEtiqueta(page, re) {
  const h = await page.evaluateHandle((patron) => {
    const pop = document.getElementById('applicationPopup');
    if (!pop) return null;
    const rex = new RegExp(patron, 'i');
    const etiqueta = (el) => {
      const lab = el.labels && el.labels[0];
      if (lab) return lab.innerText;
      const by = el.getAttribute('aria-labelledby');
      if (by) { const n = document.getElementById(by.split(' ')[0]); if (n) return n.innerText; }
      return el.getAttribute('aria-label') || '';
    };
    return [...pop.querySelectorAll('input[type="text"]')]
      .find((el) => el.offsetParent !== null && rex.test(etiqueta(el).trim())) || null;
  }, re.source || String(re));
  const el = h.asElement();
  if (!el) { await h.dispose(); return null; }
  return el;
}

/** Escribe en un campo JET y comprueba; si no cuaja, lo fuerza por JS. Lanza si tampoco. */
async function escribirYVerificar(page, el, valor, queEs) {
  try {
    await el.click({ clickCount: 3 });
  } catch {
    // Sin click real no hay selección previa: se vacía por JS antes de teclear.
    await el.evaluate((n) => { n.focus(); n.select && n.select(); });
  }
  await page.keyboard.press('Backspace').catch(() => {});
  await el.type(valor, { delay: 150 });
  await waitMs(600);

  const leer = () => el.evaluate((n) => n.value);
  if (await leer() !== valor) {
    await el.evaluate((n, v) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(n, v);
      n.dispatchEvent(new Event('input', { bubbles: true }));
      n.dispatchEvent(new Event('change', { bubbles: true }));
    }, valor);
    await waitMs(800);
  }
  const final = await leer();
  if (final !== valor) throw new Error(`No pude escribir ${queEs}: quedó "${final}" en vez de "${valor}".`);
}

/**
 * Deja el formulario de búsqueda listo en el reporte "Buscar Solicitud".
 * Devuelve false si el popup no se puede abrir (entonces se usa la vía en línea).
 */
async function prepararFormularioSolicitud(page) {
  // En un lote, el formulario puede seguir abierto del caso anterior: volver a
  // pulsar el botón lo cerraría.
  const yaAbierto = await page.$eval('#applicationPopup', (el) => el.offsetParent !== null).catch(() => false);

  if (!yaAbierto) {
    // La cabecera de AgentWeb se monta después del login: buscarlo con page.$ nada
    // más entrar devuelve null aunque el botón acabe apareciendo un segundo después.
    const boton = await page.waitForSelector('#quickSearchContextMenuButton', { visible: true, timeout: 20000 })
      .catch(() => null);
    if (!boton) { log('No hay botón de búsqueda avanzada (#quickSearchContextMenuButton).'); return false; }
    await pulsar(boton);
    const ok = await page.waitForSelector('#applicationPopup', { visible: true, timeout: 15000 })
      .then(() => true).catch(() => false);
    if (!ok) { log('El botón de búsqueda avanzada no abrió el formulario (#applicationPopup).'); return false; }
  }
  await waitMs(1200);

  const tipo = await porId(page, 'reportTypes|input');
  if (!tipo) { log('El formulario no trae selector de reporte (#reportTypes|input).'); return false; }

  const actual = (await tipo.evaluate((n) => n.value) || '').trim();
  if (actual.toLowerCase() !== REPORTE_SOLICITUD.toLowerCase()) {
    log(`El formulario está en el reporte "${actual}"; lo cambio a "${REPORTE_SOLICITUD}".`);
    await escribirYVerificar(page, tipo, REPORTE_SOLICITUD, 'el tipo de reporte');
    await page.keyboard.press('Enter').catch(() => {});
    await waitMs(2000);
    const tras = (await tipo.evaluate((n) => n.value) || '').trim();
    if (tras.toLowerCase() !== REPORTE_SOLICITUD.toLowerCase()) {
      throw new Error(`No pude poner el formulario en "${REPORTE_SOLICITUD}" (quedó en "${tras}"). `
        + 'Ábrelo a mano una vez en este navegador y vuelve a intentarlo.');
    }
  }
  return true;
}

/**
 * Datos de la ficha de siniestro, si es que hay una abierta.
 *
 * Cuando la solicitud tiene UN solo siniestro, el portal no muestra el grid de
 * resultados: abre la ficha directamente. Y esa ficha trae sus propios grids
 * (p. ej. "Arrendatarios y Terceros"), con enlaces "Abrir" en la columna
 * Acciones — los mismos `recordCommandLink` por los que antes se decidía que
 * había resultados. Resultado: se intentaba elegir el siniestro "Vigente" entre
 * los arrendatarios y se leían teléfonos como estados.
 *
 * Por eso se mira la ficha PRIMERO, y se identifica por su propio "# Solicitud":
 * así se confirma además que es la que se pidió y no una que quedara abierta.
 */
async function leerFichaSiniestro(page) {
  return page.evaluate(() => {
    const etiquetaDe = (el) => {
      const lab = el.labels && el.labels[0];
      if (lab) return lab.innerText.trim();
      const by = el.getAttribute('aria-labelledby');
      if (by) { const n = document.getElementById(by.split(' ')[0]); if (n) return n.innerText.trim(); }
      return (el.getAttribute('aria-label') || '').trim();
    };
    const campos = new Map();
    for (const el of document.querySelectorAll('input')) {
      if (el.offsetParent === null || !el.value) continue;
      const et = etiquetaDe(el);
      if (et && !campos.has(et)) campos.set(et, String(el.value).trim());
    }
    const solicitud = campos.get('# Solicitud');
    if (!solicitud) return null;
    // Franja verde del encabezado: "Siniestro - Amparo Básico".
    const banda = [...document.querySelectorAll('div,span')]
      .map((e) => (e.innerText || '').replace(/\s+/g, ' ').trim())
      .find((t) => /^Siniestro\s*-\s*\S/.test(t) && t.length < 60);
    return {
      solicitud,
      estado: campos.get('Estado Siniestro') || '',
      fechaMora: campos.get('Fecha de Mora') || '',
      arrendatario: campos.get('Arrendatario') || '',
      amparo: banda ? banda.replace(/^Siniestro\s*-\s*/, '').trim() : '',
    };
  });
}

async function buscarSolicitud(page, numero) {
  const num = String(numero).trim();
  log(`Buscando solicitud ${num}…`);

  // Vía preferida: el formulario, donde el reporte es explícito.
  let porFormulario = false;
  try {
    if (await prepararFormularioSolicitud(page)) {
      const campo = await campoPorEtiqueta(page, /#\s*Solicitud/);
      if (!campo) log('El formulario no trae campo "# Solicitud".');
      if (campo) {
        await escribirYVerificar(page, campo, num, 'el nº de solicitud');
        const buscar = await page.$('#quickSearchSearch');
        if (buscar) { await pulsar(buscar); porFormulario = true; }
      }
    }
  } catch (e) {
    // Un fallo aquí no debe dejar sin buscar: se avisa y se cae a la vía en línea,
    // que es la que venía funcionando cuando el reporte ya estaba bien elegido.
    log(`Formulario de búsqueda no utilizable (${e.message}); uso la búsqueda rápida en línea.`);
  }

  if (!porFormulario) {
    await escribirQuickSearch(page, num);
    const btn = await page.$('#quickSearchSearchButton');
    if (btn) await btn.click();
    else await page.keyboard.press('Enter');
  }

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

// ─── Abrir el siniestro "Vigente" o "Desocupado" del grid de resultados ───────
// Regla de negocio (definida por la oficina): de los N siniestros que devuelve
// una solicitud, se abre uno con Estado del Siniestro = "Vigente" o "Desocupado"
// (los dos tienen estado de cuenta). Si hay de los dos, gana el Vigente; dentro
// del mismo estado, el de Fecha de Mora más reciente. El grid es un Oracle JET DataGrid
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

// Estados del siniestro de los que se saca estado de cuenta, en orden de
// preferencia. Van como texto de regex porque también se usan dentro de
// page.evaluate, que no recibe RegExp.
const ESTADOS_CON_ESTADO_CUENTA = ['vigente', 'desocupad'];
const ESTADOS_TEXTO = '"Vigente" o "Desocupado"';
const tieneEstadoCuenta = (estado) =>
  ESTADOS_CON_ESTADO_CUENTA.some((re) => new RegExp(re, 'i').test(estado || ''));

async function abrirSiniestroVigente(page) {
  log(`Seleccionando la fila con Estado del Siniestro = ${ESTADOS_TEXTO}…`);
  await page.waitForSelector('.oj-datagrid-cell .recordCommandLink', { timeout: NAV_TIMEOUT })
    .catch(() => { throw new Error('No apareció el grid de resultados (recordCommandLink).'); });
  await waitMs(1200);

  const elegido = await page.evaluate((estadosValidos) => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    // Posición en la lista de estados válidos (menor = preferido); -1 = no sirve.
    const prioridad = (e) => estadosValidos.findIndex((re) => new RegExp(re, 'i').test(e));
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
    const candidatas = filas.filter((f) => prioridad(f.estado) >= 0);
    // Que un caso no tenga siniestro Vigente ni Desocupado es NORMAL (se desistió,
    // terminó o pasó a cartera castigada): no es un fallo del scraping, así que se
    // informa como omisión y el lote sigue con los demás.
    if (!candidatas.length) return { sinVigente: true, filas };

    candidatas.sort((a, b) => (prioridad(a.estado) - prioridad(b.estado))
      || (parseFecha(b.fecha) - parseFecha(a.fecha)) || (+b.id - +a.id));
    const sel = candidatas[0];

    const cell = grid.querySelector(`.oj-datagrid-cell[row-id="${sel.id}"][column-id="${sel.abrirCol}"] .recordCommandLink`)
              || grid.querySelector(`.oj-datagrid-cell[row-id="${sel.id}"] .recordCommandLink`);
    if (!cell) return { error: `No encontré el "Abrir" de la fila ${sel.id}`, filas };
    cell.setAttribute('data-abrir-target', '1');
    return { rowId: sel.id, amparo: sel.amparo, estado: sel.estado, fecha: sel.fecha, totalFilas: filas.length };
  }, ESTADOS_CON_ESTADO_CUENTA);

  if (elegido.gridInesperado) {
    throw new Error('El grid en pantalla no es el reporte "Buscar Solicitud" '
      + `(encabezados: ${(elegido.headers || []).slice(0, 12).join(' | ')})`);
  }
  if (elegido.sinVigente) {
    const estados = [...new Set((elegido.filas || [])
      .map((f) => f.estado).filter((e) => e && e !== 'Sin valor'))];
    const motivo = `ningún siniestro con Estado = ${ESTADOS_TEXTO}`
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
  // En un lote, la ficha del caso anterior sigue en el DOM aunque su workspace ya
  // no se vea, así que hay DOS pestañas "Estado de Cuenta": quedarse con la
  // primera marcaba la oculta, y clicarla fallaba con "Node is either not
  // clickable or not an Element". Se filtra por visibles y se toma la última, que
  // es la del workspace recién abierto.
  const ok = await page.evaluate(() => {
    for (const el of document.querySelectorAll('[data-eqc-target]')) el.removeAttribute('data-eqc-target');
    const candidatas = [...document.querySelectorAll('li.ws-tab-item')].filter((el) => {
      if (el.offsetParent === null) return false;
      const t = el.querySelector('.tab-title');
      return t && t.textContent.replace(/\s+/g, ' ').trim() === 'Estado de Cuenta';
    });
    const li = candidatas[candidatas.length - 1];
    if (!li) return false;
    li.setAttribute('data-eqc-target', '1');
    return true;
  });
  if (!ok) throw new Error('No encontré la pestaña "Estado de Cuenta" visible.');

  const pestana = await page.$('[data-eqc-target="1"]');
  await pulsar(pestana);
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
      // Igual que en el lote: la ficha primero, porque sus grids internos también
      // tienen enlaces "Abrir" y pasarían por resultados de búsqueda.
      const ficha = await leerFichaSiniestro(page);
      if (ficha && ficha.solicitud === String(solicitud).trim()) {
        log(`El portal abrió la ficha directa (estado: ${ficha.estado || 'desconocido'}).`);
        seleccion = tieneEstadoCuenta(ficha.estado)
          ? { amparo: ficha.amparo, estado: ficha.estado, fecha: ficha.fechaMora }
          : { omitido: true, motivo: `el único siniestro está "${ficha.estado}", no ${ESTADOS_TEXTO}`, estados: [ficha.estado] };
        if (!seleccion.omitido) await irAEstadoDeCuenta(page);
      } else if (await page.$('.oj-datagrid-cell .recordCommandLink')) {
        seleccion = await abrirSiniestroVigente(page);
        // Omitida = no hay ficha abierta: no tiene sentido buscar su Estado de Cuenta.
        if (!seleccion.omitido) await irAEstadoDeCuenta(page);
      } else {
        log('Ni ficha ni grid de resultados; intento ir a Estado de Cuenta de todas formas.');
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

        // La ficha se comprueba ANTES que el grid: si el portal la abrió directa,
        // sus propios grids tienen "Abrir" y parecerían resultados de búsqueda.
        const ficha = await leerFichaSiniestro(page);
        let sel;
        if (ficha && ficha.solicitud === num) {
          if (!tieneEstadoCuenta(ficha.estado)) {
            const motivo = `el único siniestro de la solicitud está "${ficha.estado || 'sin estado'}", no ${ESTADOS_TEXTO}`;
            resultados.push({ solicitud: num, success: false, omitido: true, motivo, estados: [ficha.estado] });
            log(`⊘ ${num}: ${motivo}.`);
            continue;
          }
          sel = { amparo: ficha.amparo, estado: ficha.estado, fecha: ficha.fechaMora };
          log(`${num}: el portal abrió la ficha directa (${ficha.estado}); no hay grid que recorrer.`);
        } else {
          const hayGrid = await page.$('.oj-datagrid-cell .recordCommandLink');
          if (!hayGrid) {
            resultados.push({ solicitud: num, success: false, motivo: 'la búsqueda no devolvió resultados en el portal' });
            log(`⊘ ${num}: sin resultados.`);
            continue;
          }

          sel = await abrirSiniestroVigente(page);
          if (sel.omitido) {
            resultados.push({ solicitud: num, success: false, omitido: true, motivo: sel.motivo, estados: sel.estados });
            continue;
          }
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

// `login` y `buscarSolicitud` se exportan para poder sondear el portal desde un
// script suelto cuando algo cambia de sitio: sin ellos, cada diagnóstico tendría
// que duplicar el login (y el User-Agent, que es lo que evita el 401).
module.exports = { procesarSolicitudes, login, buscarSolicitud, UA_PORTAL };

// Solo se autoejecuta como CLI; al requerirlo desde el motor, no.
if (require.main === module) {
  main().catch((e) => salir({ success: false, error: e.message }, 1));
}
