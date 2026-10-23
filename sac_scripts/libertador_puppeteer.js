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

// Los argumentos solo cuentan cuando este archivo ES el comando. Requerido desde
// otro CLI (libertador_documentos.js <solicitud>), argv[2] es la solicitud de ese
// otro comando y se tomaba como URL del portal.
const argv = require.main === module ? process.argv : [];
const AGENTWEB_URL = argv[2] || process.env.LIBERTADOR_SAC_URL || 'https://ellibertador.custhelp.com/AgentWeb/';
const USER = argv[3] || process.env.LIBERTADOR_SAC_USER || '';
const PASS = argv[4] || process.env.LIBERTADOR_SAC_PASS || '';

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
      poliza: campos.get('# Póliza') || '',
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

// `cualquiera`: para lo que no depende del estado (leer la inmobiliaria), si no
// hay Vigente ni Desocupado se abre igual el siniestro de mora más reciente.
async function abrirSiniestroVigente(page, opts = {}) {
  log(`Seleccionando la fila con Estado del Siniestro = ${ESTADOS_TEXTO}…`);
  await page.waitForSelector('.oj-datagrid-cell .recordCommandLink', { timeout: NAV_TIMEOUT })
    .catch(() => { throw new Error('No apareció el grid de resultados (recordCommandLink).'); });
  await waitMs(1200);

  const elegido = await page.evaluate((estadosValidos, cualquiera) => {
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
    let candidatas = filas.filter((f) => prioridad(f.estado) >= 0);
    if (!candidatas.length && cualquiera) candidatas = filas.filter((f) => f.abrirCol !== null);
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
  }, ESTADOS_CON_ESTADO_CUENTA, !!opts.cualquiera);

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

// ─── NIT de la inmobiliaria ───────────────────────────────────────────────────
// Lo pide el portal de documentos de Bolívar (busca por NIT + solicitud). En la
// ficha del siniestro, el campo "Inmobiliaria" tiene al lado un botón ⋮ cuyo
// menú trae "Abrir": abre la ficha de la inmobiliaria en una sub-pestaña, con el
// NIT en "Número de Identificación".
// Ojo: la ficha del siniestro tiene su propio "# Identificación", que es el del
// ARRENDATARIO. Por eso las etiquetas se comparan exactas y no por "contiene".

/** Vuelca el HTML que rodea un elemento marcado, para ajustar selectores sin adivinar. */
async function volcarAlrededor(page, marca, nombre) {
  const html = await page.evaluate((m) => {
    const el = document.querySelector(`[${m}]`);
    let c = el;
    for (let i = 0; i < 6 && c && c.parentElement; i++) c = c.parentElement;
    return c ? c.outerHTML : null;
  }, marca).catch(() => null);
  if (!html) return null;
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  const archivo = path.join(TEMP_DIR, nombre);
  fs.writeFileSync(archivo, html);
  await page.screenshot({ path: archivo.replace(/\.html$/, '.png') }).catch(() => {});
  return archivo;
}

async function leerNitInmobiliaria(page) {
  // 1) El botón ⋮ del campo "Inmobiliaria" de la ficha visible.
  const campo = await page.evaluate(() => {
    for (const m of ['data-inmob-campo', 'data-inmob-menu']) {
      for (const el of document.querySelectorAll(`[${m}]`)) el.removeAttribute(m);
    }
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const etiquetaDe = (el) => {
      const lab = el.labels && el.labels[0];
      if (lab) return norm(lab.innerText);
      const by = el.getAttribute('aria-labelledby');
      if (by) { const n = document.getElementById(by.split(' ')[0]); if (n) return norm(n.innerText); }
      return norm(el.getAttribute('aria-label'));
    };
    const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    const inputs = [...document.querySelectorAll('input')].filter((el) => visible(el) && /^inmobiliaria$/i.test(etiquetaDe(el)));
    const input = inputs[inputs.length - 1];   // la del workspace recién abierto
    if (!input) return { error: 'No encontré el campo "Inmobiliaria" en la ficha del siniestro.' };
    input.setAttribute('data-inmob-campo', '1');

    // Se sube por los contenedores hasta encontrar botones, sin pasarse a uno que
    // ya incluya OTRO campo con etiqueta (sería el botón de otro campo).
    const pista = (b) => norm(`${b.getAttribute('aria-label') || ''} ${b.getAttribute('title') || ''} ${b.className || ''} ${b.id || ''}`);
    let cont = input.parentElement;
    for (let i = 0; i < 8 && cont; i++, cont = cont.parentElement) {
      const ajenos = [...cont.querySelectorAll('input')].some((x) => x !== input && visible(x) && etiquetaDe(x) && !/^inmobiliaria$/i.test(etiquetaDe(x)));
      if (ajenos) break;
      const botones = [...cont.querySelectorAll('button,[role="button"],a,oj-button')].filter((b) => visible(b) && !b.contains(input));
      if (!botones.length) continue;
      const menu = botones.find((b) => /men[uú]|more|m[aá]s|acci[oó]n|context|kebab|ellipsis|overflow|dots|options|opciones/i.test(pista(b)))
        || botones.find((b) => !/arrow|flecha|open|desplegar|dropdown|clear|borrar|search|buscar/i.test(pista(b)));
      if (menu) {
        menu.setAttribute('data-inmob-menu', '1');
        return { nombre: norm(input.value), pista: pista(menu).slice(0, 120) };
      }
    }
    return { error: 'No encontré el botón ⋮ junto al campo "Inmobiliaria".' };
  });
  if (campo.error) {
    const dump = await volcarAlrededor(page, 'data-inmob-campo', 'libertador_inmobiliaria_campo.html');
    throw new Error(campo.error + (dump ? ` HTML del campo en ${dump}` : ''));
  }
  log(`Inmobiliaria "${campo.nombre}"; abriendo su menú (${campo.pista || 'sin pista'})…`);
  await pulsar(await page.$('[data-inmob-menu="1"]'));

  // 2) "Abrir" del menú. Se busca DENTRO de un menú: la ficha tiene otros "Abrir"
  //    a la vista (los enlaces de sus grids).
  const hayAbrir = await page.waitForFunction(() => {
    for (const el of document.querySelectorAll('[data-inmob-abrir]')) el.removeAttribute('data-inmob-abrir');
    const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    const items = [...document.querySelectorAll('[role="menuitem"], [role="menu"] *, .oj-menu *, oj-menu *')]
      .filter((el) => visible(el) && (el.textContent || '').replace(/\s+/g, ' ').trim() === 'Abrir');
    const it = items.find((el) => !items.some((o) => o !== el && el.contains(o)));   // el más interno
    if (!it) return false;
    it.setAttribute('data-inmob-abrir', '1');
    return true;
  }, { timeout: 15000 }).then(() => true).catch(() => false);
  if (!hayAbrir) {
    const dump = await volcarAlrededor(page, 'data-inmob-menu', 'libertador_inmobiliaria_menu.html');
    throw new Error('El botón ⋮ de "Inmobiliaria" no mostró la opción "Abrir".' + (dump ? ` HTML en ${dump}` : ''));
  }
  await pulsar(await page.$('[data-inmob-abrir="1"]'));

  // 3) La ficha de la inmobiliaria: "Número de Identificación" (y su "Nombre").
  const leer = () => page.evaluate(() => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const sinTildes = (s) => norm(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const etiquetaDe = (el) => {
      const lab = el.labels && el.labels[0];
      if (lab) return lab.innerText;
      const by = el.getAttribute('aria-labelledby');
      if (by) { const n = document.getElementById(by.split(' ')[0]); if (n) return n.innerText; }
      return el.getAttribute('aria-label') || '';
    };
    const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    const valor = (etq) => {
      const hits = [...document.querySelectorAll('input')].filter((el) => visible(el) && el.value && sinTildes(etiquetaDe(el)) === etq);
      return hits.length ? norm(hits[hits.length - 1].value) : '';
    };
    return { nit: valor('numero de identificacion'), nombre: valor('nombre') };
  });
  let datos = { nit: '', nombre: '' };
  const hasta = Date.now() + 45000;
  while (Date.now() < hasta) {
    datos = await leer().catch(() => datos);
    if (datos.nit) break;
    await waitMs(1000);
  }
  if (!datos.nit) {
    const shot = path.join(TEMP_DIR, 'libertador_inmobiliaria_ficha.png');
    await page.screenshot({ path: shot }).catch(() => {});
    throw new Error(`Abrí la inmobiliaria pero no apareció "Número de Identificación" (pantallazo en ${shot}).`);
  }
  // Si la ficha que quedó a la vista es de OTRA inmobiliaria (una pestaña vieja
  // restaurada, un clic que no abrió nada), su NIT traería documentos ajenos.
  if (datos.nombre && campo.nombre && datos.nombre.toUpperCase() !== campo.nombre.toUpperCase()) {
    throw new Error(`La ficha abierta es de "${datos.nombre}" y el siniestro dice "${campo.nombre}": no uso ese NIT.`);
  }
  // "900504995-1" → "900504995": el portal de documentos pide el NIT sin dígito de verificación.
  const nit = datos.nit.split('-')[0].replace(/\D/g, '');
  if (!nit) throw new Error(`"Número de Identificación" de la inmobiliaria no es un NIT: "${datos.nit}".`);
  return { nit, inmobiliaria: datos.nombre || campo.nombre };
}

/**
 * Marca (con `attr`) el ÚLTIMO elemento visible cuyo texto es exactamente `texto`.
 * El último porque AgentWeb deja en el DOM los workspaces anteriores, y el recién
 * abierto queda al final.
 */
async function marcarPorTextoExacto(page, texto, attr, selector = '[role="tab"],li,a,span,div,button') {
  return page.evaluate((t, a, sel) => {
    for (const el of document.querySelectorAll(`[${a}]`)) el.removeAttribute(a);
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    const hits = [...document.querySelectorAll(sel)].filter((el) => visible(el) && norm(el.textContent) === t);
    const internos = hits.filter((el) => !hits.some((o) => o !== el && el.contains(o)));
    const el = internos[internos.length - 1];
    if (!el) return false;
    el.setAttribute(a, '1');
    return true;
  }, texto, attr, selector);
}

// ─── Ciudad del arrendatario ──────────────────────────────────────────────────
// La pide el formulario de solicitud de documentos ("Ciudad del despacho"). En la
// ficha del siniestro: pestaña "Arrendatarios y Terceros" → grid Arrendatarios →
// "Abrir" de la PRIMERA fila → ficha de la persona → "Datos demográficos" →
// "Ciudad de Residencia". La primera fila es lo acordado por ahora; con varios
// arrendatarios o codeudores la oficina definirá cuál va.
async function leerCiudadArrendatario(page) {
  if (await marcarPorTextoExacto(page, 'Arrendatarios y Terceros', 'data-arr-tab')) {
    await pulsar(await page.$('[data-arr-tab="1"]'));
    await waitMs(1500);
  }

  // El grid de Arrendatarios es un datagrid de JET como el de la búsqueda; se
  // reconoce por sus columnas. La "primera" fila es la primera que pinta el DOM.
  const fila = await page.waitForFunction(() => {
    for (const el of document.querySelectorAll('[data-arr-abrir]')) el.removeAttribute('data-arr-abrir');
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const grids = [...document.querySelectorAll('.oj-datagrid')].filter((g) => g.offsetParent !== null);
    for (const g of grids.reverse()) {
      const headers = [...g.querySelectorAll('.oj-datagrid-header-cell-text')].map((h) => norm(h.textContent));
      const iNombre = headers.findIndex((h) => /^nombre completo$/i.test(h));
      const iTipo = headers.findIndex((h) => /^tipo de contacto$/i.test(h));
      if (iNombre < 0 || iTipo < 0) continue;
      const celdas = [...g.querySelectorAll('.oj-datagrid-cell[row-id][column-id]')];
      if (!celdas.length) continue;
      const rowId = celdas[0].getAttribute('row-id');
      const deLaFila = celdas.filter((c) => c.getAttribute('row-id') === rowId);
      const abrir = deLaFila.map((c) => c.querySelector('.recordCommandLink')).find(Boolean);
      if (!abrir) continue;
      abrir.setAttribute('data-arr-abrir', '1');
      const val = (i) => norm((deLaFila.find((c) => +c.getAttribute('column-id') === i) || {}).textContent);
      return { nombre: val(iNombre), tipo: val(iTipo) };
    }
    return false;
  }, { timeout: 30000 }).then((h) => h.jsonValue()).catch(() => null);
  if (!fila) {
    const shot = path.join(TEMP_DIR, 'libertador_arrendatarios.png');
    await page.screenshot({ path: shot }).catch(() => {});
    throw new Error(`No encontré el grid de Arrendatarios (columnas "Nombre completo" / "Tipo de Contacto"). Pantallazo en ${shot}`);
  }
  log(`Arrendatarios: abro la primera fila (${fila.nombre}, ${fila.tipo || 'sin tipo'})…`);
  await pulsar(await page.$('[data-arr-abrir="1"]'));

  // La pestaña "Datos demográficos" aparece cuando carga la ficha de la persona.
  const hayPestana = await page.waitForFunction(
    () => [...document.querySelectorAll('[role="tab"],li,a,span')].some((el) =>
      el.getClientRects().length > 0 && (el.textContent || '').replace(/\s+/g, ' ').trim() === 'Datos demográficos'),
    { timeout: 45000 },
  ).then(() => true).catch(() => false);
  if (!hayPestana || !await marcarPorTextoExacto(page, 'Datos demográficos', 'data-arr-demo')) {
    const shot = path.join(TEMP_DIR, 'libertador_persona.png');
    await page.screenshot({ path: shot }).catch(() => {});
    throw new Error(`Abrí a ${fila.nombre} pero no apareció la pestaña "Datos demográficos". Pantallazo en ${shot}`);
  }
  await pulsar(await page.$('[data-arr-demo="1"]'));

  let ciudad = '';
  const hasta = Date.now() + 30000;
  while (!ciudad && Date.now() < hasta) {
    await waitMs(1000);
    ciudad = await page.evaluate(() => {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const etiquetaDe = (el) => {
        const lab = el.labels && el.labels[0];
        if (lab) return norm(lab.innerText);
        const by = el.getAttribute('aria-labelledby');
        if (by) { const n = document.getElementById(by.split(' ')[0]); if (n) return norm(n.innerText); }
        return norm(el.getAttribute('aria-label'));
      };
      const hits = [...document.querySelectorAll('input')]
        .filter((el) => el.getClientRects().length > 0 && /^ciudad de residencia$/i.test(etiquetaDe(el)));
      const v = hits.length ? norm(hits[hits.length - 1].value) : '';
      return /^\[?sin valor\]?$/i.test(v) ? '' : v;
    }).catch(() => '');
  }
  if (!ciudad) {
    const shot = path.join(TEMP_DIR, 'libertador_persona.png');
    await page.screenshot({ path: shot }).catch(() => {});
    throw new Error(`${fila.nombre} no tiene "Ciudad de Residencia" en Datos demográficos (o no la encontré). Pantallazo en ${shot}`);
  }
  return { ciudad, arrendatario: fila.nombre };
}

/**
 * Vuelve a la sub-pestaña del siniestro después de abrir otra ficha (la de la
 * inmobiliaria). Su píldora dice "<solicitud>-<amparo>" ("11752770-AMPARO BASICO");
 * se busca por el prefijo, porque el amparo de la franja verde viene con tildes
 * y en otra caja. La pestaña grande de arriba dice lo mismo, así que se prueban
 * todas, de la última a la primera, hasta que la ficha del siniestro esté a la vista.
 * Devuelve false si no lo logra: el llamador recarga y busca de nuevo.
 */
async function volverAlSiniestro(page, num) {
  const marcar = (i) => page.evaluate((prefijo, idx) => {
    for (const el of document.querySelectorAll('[data-volver-sin]')) el.removeAttribute('data-volver-sin');
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    const hits = [...document.querySelectorAll('[role="tab"],li,a,span,div,button')]
      .filter((el) => visible(el) && norm(el.textContent).startsWith(prefijo) && norm(el.textContent).length < 80);
    const internos = hits.filter((el) => !hits.some((o) => o !== el && el.contains(o)));
    if (idx >= 0 && internos[idx]) internos[idx].setAttribute('data-volver-sin', '1');
    return internos.length;
  }, `${num}-`, i);

  const total = await marcar(-1);
  for (let i = total - 1; i >= 0; i--) {
    await marcar(i);
    const el = await page.$('[data-volver-sin="1"]');
    if (!el) continue;
    await pulsar(el);
    await waitMs(2500);
    // "# Solicitud" visible = la ficha del siniestro está al frente (la de la
    // inmobiliaria no tiene ese campo).
    const ficha = await leerFichaSiniestro(page).catch(() => null);
    if (ficha && ficha.solicitud === num) return true;
  }
  return false;
}

/** Busca la solicitud y deja abierta la ficha de un siniestro. Devuelve sus datos o { error }. */
async function abrirFichaSolicitud(page, num) {
  await buscarSolicitud(page, num);
  let ficha = await leerFichaSiniestro(page);
  if (ficha && ficha.solicitud === num) return { ficha };
  if (!await page.$('.oj-datagrid-cell .recordCommandLink')) return { error: 'la búsqueda no devolvió resultados en el portal' };
  const sel = await abrirSiniestroVigente(page, { cualquiera: true });
  if (sel.omitido) return { error: 'la solicitud no tiene siniestros que abrir' };
  ficha = await leerFichaSiniestro(page);
  if (!ficha || ficha.solicitud !== num) return { error: `abrí un siniestro pero la ficha a la vista no es la de ${num}` };
  return { ficha: { ...ficha, estado: ficha.estado || sel.estado } };
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

/**
 * Lo que la etapa de documentos necesita del Huella, por solicitud y con un solo
 * login:
 *  - NIT de la inmobiliaria: para bajar los anexos del portal de Bolívar.
 *  - póliza, estado del siniestro y ciudad del arrendatario: para el formulario
 *    de solicitud de documentos.
 * Cualquier siniestro sirve para la inmobiliaria (es la misma en todos); el estado
 * es el del siniestro que se abre (Vigente o Desocupado si los hay).
 *
 * `success` = se obtuvo el NIT. Lo que falle del formulario no lo tumba: va en
 * `errores` ({ ciudad }) para que los anexos se bajen igual. Nunca lanza por un caso.
 *
 * Devuelve [{ solicitud, success, nit?, inmobiliaria?, poliza?, estado?, ciudad?, errores?, error? }]
 */
async function datosDeSolicitudes(solicitudes, opts = {}) {
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
    log(`Sesión abierta; leyendo ${lista.length} solicitud(es) en el Huella.`);

    const recargar = async () => {   // workspace limpio, igual que en procesarSolicitudes
      await page.goto(AGENTWEB_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      await waitMs(3000);
    };

    let primera = true;
    for (const num of lista) {
      try {
        if (!primera) await recargar();
        primera = false;

        const abierta = await abrirFichaSolicitud(page, num);
        if (abierta.error) {
          resultados.push({ solicitud: num, success: false, error: abierta.error });
          continue;
        }
        const { poliza, estado } = abierta.ficha;
        const { nit, inmobiliaria } = await leerNitInmobiliaria(page);
        const r = { solicitud: num, success: true, nit, inmobiliaria, poliza, estado, errores: {} };
        log(`✓ ${num}: ${inmobiliaria} — NIT ${nit} | póliza ${poliza || '?'} | ${estado || 'sin estado'}`);

        // La ciudad está en otra ficha: hay que volver al siniestro (lo dejó atrás
        // la inmobiliaria). Si la píldora no responde, se recarga y se busca otra vez.
        try {
          if (!await volverAlSiniestro(page, num)) {
            log(`${num}: no pude volver a la ficha del siniestro; recargo y la abro de nuevo.`);
            await recargar();
            const otra = await abrirFichaSolicitud(page, num);
            if (otra.error) throw new Error(otra.error);
          }
          const { ciudad, arrendatario } = await leerCiudadArrendatario(page);
          r.ciudad = ciudad;
          log(`✓ ${num}: ciudad ${ciudad} (de ${arrendatario})`);
        } catch (e) {
          r.errores.ciudad = e.message;
          log(`⚠ ${num}: sin ciudad del arrendatario: ${e.message}`);
        }
        resultados.push(r);
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
module.exports = { procesarSolicitudes, datosDeSolicitudes, login, buscarSolicitud, UA_PORTAL };

// Solo se autoejecuta como CLI; al requerirlo desde el motor, no.
if (require.main === module) {
  main().catch((e) => salir({ success: false, error: e.message }, 1));
}
