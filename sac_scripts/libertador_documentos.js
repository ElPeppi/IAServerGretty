/**
 * libertador_documentos.js
 * Descarga los documentos anexos de una solicitud de Libertador (contrato,
 * reconocimientos…) desde el portal de indemnizaciones de Seguros Bolívar.
 *
 * El portal busca por NIT de la inmobiliaria + nº de solicitud, y la asignación
 * solo trae la solicitud. Por eso el NIT se lee antes en el Huella (AgentWeb):
 * ficha del siniestro → campo Inmobiliaria → ⋮ → Abrir → "Número de
 * Identificación" (datosDeSolicitudes, en libertador_puppeteer.js).
 *
 * En el portal: login NetIQ (registro.segurosbolivar.com) → menú "Solicitar
 * documentos" → NIT + solicitud → BUSCAR → "Ver Anexos" → un "Descargar
 * Documento" por anexo (el modal pagina).
 *
 * Credenciales en sac_scripts/.env:
 *   BOLIVAR_DOCS_USER / BOLIVAR_DOCS_PASS       portal de documentos
 *   LIBERTADOR_SAC_USER / LIBERTADOR_SAC_PASS   Huella (para el NIT)
 *
 * CLI (deja los archivos en SAC_TEMP_DIR/documentos_<solicitud>/):
 *   node libertador_documentos.js <solicitud> [nit]     con nit se salta el Huella
 *   HEADLESS=false node libertador_documentos.js …      para ver el navegador
 *   LIBERTADOR_DOCS_EXPLORE=1 node libertador_documentos.js …   vuelca cada paso
 * Si un paso falla, SIEMPRE deja pantallazo + HTML en SAC_TEMP_DIR/bolivar_docs/.
 *
 * Salida stdout: JSON. Logs de progreso por stderr.
 */
'use strict';

const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

try { require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true }); } catch (_) {}

const { datosDeSolicitudes } = require('./libertador_puppeteer');

const LOGIN_URL = process.env.BOLIVAR_DOCS_URL
  || 'https://registro.segurosbolivar.com/nidp/idff/sso?id=620&sid=0&option=credential&sid=0&target=https://www.segurosbolivar.com/indemnizaciones-web/login.html';
const USER = process.env.BOLIVAR_DOCS_USER || '';
const PASS = process.env.BOLIVAR_DOCS_PASS || '';

const TEMP_DIR = process.env.SAC_TEMP_DIR || 'C:/temp/sac_temp';
const NAV_TIMEOUT = Number(process.env.LIBERTADOR_NAV_TIMEOUT_MS) || 120000;
const EXPLORE = process.env.LIBERTADOR_DOCS_EXPLORE === '1';
const DUMP_DIR = path.join(TEMP_DIR, 'bolivar_docs');

const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error('[BOLIVAR-DOCS]', ...a);

// ─── Diagnóstico ──────────────────────────────────────────────────────────────
// No hay forma de ver el portal sin sesión, así que los selectores se buscan por
// TEXTO visible y, cuando algo no aparece, se deja pantallazo + HTML de cada
// frame para ajustarlos con lo que de verdad hay.
async function volcar(page, etiqueta) {
  fs.mkdirSync(DUMP_DIR, { recursive: true });
  const base = path.join(DUMP_DIR, etiqueta);
  await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
  const frames = page.frames();
  for (let i = 0; i < frames.length; i++) {
    const html = await frames[i].content().catch(() => null);
    if (html) fs.writeFileSync(`${base}_frame${i}.html`, `<!-- ${frames[i].url()} -->\n${html}`);
  }
  log(`Volcado "${etiqueta}" en ${DUMP_DIR}`);
  return `${base}.png`;
}
const paso = (page, etiqueta) => (EXPLORE ? volcar(page, etiqueta) : null);

// ─── Lo que corre DENTRO de la página ─────────────────────────────────────────
// Una sola función con todas las operaciones: `evaluate` no comparte el scope de
// Node, y armarla con eval chocaría con un CSP estricto. Las que "marcan" dejan un
// atributo en el elemento para que Node le haga clic con un selector simple.
function enPagina(op, a) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const texto = (el) => norm(el.innerText || el.value || el.textContent);
  const limpiar = (attr) => document.querySelectorAll(`[${attr}]`).forEach((e) => e.removeAttribute(attr));
  const masInterno = (els) => els.find((el) => !els.some((o) => o !== el && el.contains(o)));
  const BOTONES = 'a,button,input[type=submit],input[type=button],[role=button],span';
  const porTexto = (raiz, patron, sel) => {
    const re = new RegExp(patron, 'i');
    return masInterno([...raiz.querySelectorAll(sel || `${BOTONES},li,div,[role=menuitem]`)]
      .filter((el) => visible(el) && re.test(texto(el))));
  };
  const marcar = (el, attr) => { if (!el) return false; el.setAttribute(attr, '1'); return true; };
  // Solo filas del cuerpo, y el BOTÓN (no su <span>): el encabezado de la columna
  // también dice "Descargar Documento" dentro de un span, y se colaba como fila 0.
  const botonDescarga = (tr) => [...tr.querySelectorAll('button,input[type=submit],input[type=button],a,[role=button]')]
    .find((b) => visible(b) && /^descargar\s+documento$/i.test(texto(b)));
  const filasAnexos = (raiz) => [...raiz.querySelectorAll('tbody tr')]
    .filter((tr) => visible(tr) && botonDescarga(tr));

  switch (op) {
    case 'hayTexto':
      return new RegExp(a.patron, 'i').test(document.body ? document.body.innerText : '');

    case 'marcarPorTexto':
      limpiar(a.attr);
      return marcar(porTexto(document, a.patron, a.sel), a.attr);

    // Input que sigue a una etiqueta ("Ingrese el NIT de la inmobiliaria").
    case 'marcarInput': {
      limpiar(a.attr);
      const lab = porTexto(document, a.patron, 'label,td,th,span,div,p');
      if (!lab) return false;
      let input = lab.control || (lab.htmlFor && document.getElementById(lab.htmlFor));
      if (!input) {
        input = [...document.querySelectorAll('input:not([type]),input[type=text],input[type=number],input[type=search],input[type=tel]')]
          .filter(visible)
          .find((i) => lab.compareDocumentPosition(i) & Node.DOCUMENT_POSITION_FOLLOWING);
      }
      return marcar(input, a.attr);
    }

    // Tras BUSCAR: la fila de la solicitud con su "Ver Anexos", o un aviso de vacío.
    case 'resultadoBusqueda': {
      limpiar('data-bd-anexos');
      const filas = [...document.querySelectorAll('tr')]
        .filter((tr) => visible(tr) && [...tr.cells].some((td) => norm(td.innerText) === a.solicitud));
      for (const tr of filas) {
        if (marcar(porTexto(tr, '^ver\\s+anexos$', BOTONES), 'data-bd-anexos')) return { fila: true };
      }
      const t = document.body ? document.body.innerText : '';
      const m = t.match(/no (se )?(encontr|exist|hay|registra)[^.\n]{0,80}/i);
      return m ? { vacio: norm(m[0]) } : false;
    }

    // El modal "Documentos Anexos": filas (nombre) y una firma para notar el cambio de página.
    case 'modalAnexos': {
      limpiar('data-bd-modal');
      const titulo = porTexto(document, '^documentos\\s+anexos$', 'h1,h2,h3,h4,h5,h6,div,span,p,td,th,label');
      if (!titulo) return false;
      const modal = titulo.closest('[role=dialog],dialog,.ui-dialog,.modal-content,.modal,.ui-overlaypanel')
        || titulo.parentElement || document.body;
      modal.setAttribute('data-bd-modal', '1');
      const filas = filasAnexos(modal).map((tr, i) => ({ i, nombre: norm(tr.cells[0] ? tr.cells[0].innerText : '') }));
      const activa = modal.querySelector('.ui-paginator-page.ui-state-active, .active, [aria-current]');
      return { filas, firma: `${activa ? norm(activa.textContent) : ''}|${filas.map((f) => f.nombre).join('|')}` };
    }

    case 'marcarDescarga': {
      limpiar('data-bd-bajar');
      const modal = document.querySelector('[data-bd-modal]') || document;
      const tr = filasAnexos(modal)[a.i];
      return !!tr && marcar(botonDescarga(tr), 'data-bd-bajar');
    }

    case 'marcarSiguiente': {
      limpiar('data-bd-sig');
      const modal = document.querySelector('[data-bd-modal]');
      if (!modal) return false;
      const sig = [...modal.querySelectorAll('.ui-paginator-next,[aria-label*="next" i],[aria-label*="siguiente" i],[title*="next" i],[title*="siguiente" i]')]
        .filter(visible)[0];
      if (!sig || /disabled/i.test(sig.className) || sig.getAttribute('aria-disabled') === 'true' || sig.disabled) return false;
      return marcar(sig, 'data-bd-sig');
    }

    case 'marcarCerrar': {
      limpiar('data-bd-cerrar');
      const modal = document.querySelector('[data-bd-modal]');
      if (!modal) return false;
      return marcar(porTexto(modal, '^volver$', BOTONES)
        || [...modal.querySelectorAll('.ui-dialog-titlebar-close,.close,[aria-label*="close" i],[aria-label*="cerrar" i]')].filter(visible)[0],
      'data-bd-cerrar');
    }

    default:
      throw new Error(`operación desconocida: ${op}`);
  }
}

/**
 * Corre DENTRO de la página. "Descargar Documento" es un submit normal de JSF
 * (PrimeFaces con ajax=false): el POST de su formulario devuelve el archivo. Se
 * repite ese mismo POST con fetch —ViewState incluido, más el nombre del botón,
 * que es lo que le dice a JSF cuál se pulsó— y se lee la respuesta. Así no se
 * depende de cómo trate el navegador la descarga: con HEADLESS=false el clic no
 * dejaba ningún archivo.
 */
async function postDelFormulario(attr) {
  // Lo marcado es el texto; en PrimeFaces va en un <span> DENTRO del <button>, y
  // el que pertenece al formulario (y lleva el name) es el botón.
  const marcado = document.querySelector(`[${attr}]`);
  const btn = marcado && (marcado.closest('button,input[type=submit],input[type=button]') || marcado);
  const form = btn && btn.form;
  if (!form) return { error: 'el botón no está dentro de un formulario' };
  const datos = new URLSearchParams(new FormData(form));
  if (btn.name) datos.append(btn.name, btn.value || '');
  const resp = await fetch(form.action, { method: 'POST', body: datos, credentials: 'include' });
  const tipo = resp.headers.get('content-type') || '';
  const disp = resp.headers.get('content-disposition') || '';
  const bytes = new Uint8Array(await resp.arrayBuffer());
  if (!resp.ok || (/text\/html/i.test(tipo) && !/filename/i.test(disp))) {
    return { error: `el portal respondió HTTP ${resp.status} ${tipo || ''} en vez del archivo`, html: new TextDecoder().decode(bytes.slice(0, 20000)) };
  }
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return { b64: btoa(bin), disp };
}

/** Nombre que trae un Content-Disposition, si trae. */
function nombreDeDisposition(disp) {
  const m = String(disp || '').match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  if (!m) return '';
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

/** Baja el documento del botón marcado: el POST del formulario; si no se puede, el clic. */
async function bajarDocumento(fr, descargas) {
  const r = await fr.evaluate(postDelFormulario, 'data-bd-bajar').catch((e) => ({ error: e.message }));
  if (r && r.b64) return { nombre: nombreDeDisposition(r.disp), buffer: Buffer.from(r.b64, 'base64') };

  if (r && r.html) {
    fs.mkdirSync(DUMP_DIR, { recursive: true });
    fs.writeFileSync(path.join(DUMP_DIR, 'respuesta_post.html'), r.html);
  }
  log(`(el POST directo no sirvió: ${r && r.error}; pruebo con el clic)`);
  return descargas.capturar(() => clic(fr, 'data-bd-bajar'));
}

/** Corre `op` en cada frame y devuelve el primero que responda algo. */
async function enFrames(page, op, a = {}) {
  for (const fr of page.frames()) {
    try {
      const r = await fr.evaluate(enPagina, op, a);
      if (r) return { fr, r };
    } catch { /* frame navegando o desmontado: se prueba el siguiente */ }
  }
  return null;
}

/** Repite `enFrames` hasta que responda o se acabe el tiempo. */
async function esperar(page, op, a, ms) {
  const hasta = Date.now() + ms;
  while (Date.now() < hasta) {
    const r = await enFrames(page, op, a);
    if (r) return r;
    await waitMs(700);
  }
  return null;
}

/** Clic en el elemento marcado. Si el clic de ratón no puede, el del DOM. */
async function clic(fr, attr) {
  const el = await fr.$(`[${attr}="1"]`);
  if (!el) throw new Error(`desapareció el elemento a pulsar (${attr})`);
  try { await el.click(); } catch { await el.evaluate((n) => n.click()); }
}

/** Escribe en el input marcado y comprueba; si no cuaja, lo asigna por JS. */
async function escribir(fr, attr, valor, queEs) {
  const el = await fr.$(`[${attr}="1"]`);
  await el.click({ clickCount: 3 }).catch(() => el.evaluate((n) => { n.focus(); n.select && n.select(); }));
  await el.press('Backspace').catch(() => {});
  await el.type(valor, { delay: 60 });
  if (await el.evaluate((n) => n.value) !== valor) {
    await el.evaluate((n, v) => {
      n.value = v;
      n.dispatchEvent(new Event('input', { bubbles: true }));
      n.dispatchEvent(new Event('change', { bubbles: true }));
    }, valor);
  }
  const final = await el.evaluate((n) => n.value);
  if (final !== valor) throw new Error(`no pude escribir ${queEs}: quedó "${final}"`);
}

// ─── Descargas ────────────────────────────────────────────────────────────────
// No se sabe cómo entrega el portal cada archivo (enlace, POST de JSF, pestaña
// nueva con el PDF), así que se escucha al NAVEGADOR: cualquier descarga que
// empiece cae en `dir` con nombre GUID y se recoge al terminar. Si en vez de
// descargar abre una pestaña con el PDF (pasa con HEADLESS=false, que sí tiene
// visor), se baja lo que muestre esa pestaña.
class Descargas {
  constructor(browser, dir) {
    this.browser = browser;
    this.dir = dir;
    this.items = [];
  }

  async activar() {
    this.cdp = await this.browser.target().createCDPSession();
    await this.cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allowAndName', downloadPath: this.dir, eventsEnabled: true,
    });
    this.cdp.on('Browser.downloadWillBegin', (e) => {
      this.items.push({ guid: e.guid, nombre: e.suggestedFilename || '', estado: 'inProgress' });
    });
    this.cdp.on('Browser.downloadProgress', (e) => {
      const it = this.items.find((x) => x.guid === e.guid);
      if (it) it.estado = e.state;
    });
  }

  /** Ejecuta `accion` (el clic) y devuelve { nombre, buffer } del archivo que bajó. */
  async capturar(accion, { msInicio = 45000, msFin = 300000 } = {}) {
    const antes = this.items.length;
    const popups = [];
    const onTarget = (t) => { if (t.type() === 'page') popups.push(t); };
    this.browser.on('targetcreated', onTarget);
    try {
      await accion();
      let it = null;
      const t0 = Date.now();
      while (!it && Date.now() - t0 < msInicio) {
        it = this.items[antes] || null;
        if (!it && popups.length && Date.now() - t0 > 4000) {
          const r = await this.desdePopup(popups.shift(), antes);
          if (r) return r;
        }
        if (!it) await waitMs(300);
      }
      if (!it) throw new Error('el clic no inició ninguna descarga');

      const t1 = Date.now();
      while (it.estado === 'inProgress' && Date.now() - t1 < msFin) await waitMs(300);
      if (it.estado !== 'completed') throw new Error(`la descarga terminó como "${it.estado}"`);
      const ruta = path.join(this.dir, it.guid);
      const buffer = fs.readFileSync(ruta);
      fs.unlinkSync(ruta);
      return { nombre: it.nombre, buffer };
    } finally {
      this.browser.off('targetcreated', onTarget);
      // Las pestañas que abrió el clic no se reutilizan: se cierran para no acumularlas.
      for (const t of popups) { const p = await t.page().catch(() => null); if (p) await p.close().catch(() => {}); }
    }
  }

  async desdePopup(target, antes) {
    const p = await target.page().catch(() => null);
    if (!p) return null;
    // Si la pestaña ya disparó una descarga normal, esa es la buena: pedir la URL
    // otra vez duplicaría el archivo.
    if (this.items.length > antes) return null;
    const url = p.url();
    if (!/^(https?|blob):/.test(url)) { await p.close().catch(() => {}); return null; }
    const r = await p.evaluate(async () => {
      const resp = await fetch(location.href, { credentials: 'include' });
      const bytes = new Uint8Array(await resp.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return { b64: btoa(bin), disp: resp.headers.get('content-disposition') || '' };
    }).catch(() => null);
    await p.close().catch(() => {});
    if (!r) return null;
    const m = r.disp.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
    log(`(el documento abrió en otra pestaña; lo bajé de ${url.slice(0, 80)})`);
    return { nombre: m ? decodeURIComponent(m[1]) : '', buffer: Buffer.from(r.b64, 'base64') };
  }
}

// ─── Pasos en el portal ───────────────────────────────────────────────────────
async function loginBolivar(page) {
  log('Abriendo el login del portal de documentos…');
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  const doc = await page.waitForSelector('#Num_Documento', { visible: true, timeout: 60000 }).catch(() => null);
  if (!doc) {
    await volcar(page, 'login_sin_formulario');
    throw new Error('No apareció el formulario de login de Bolívar (#Num_Documento).');
  }
  await doc.click({ clickCount: 3 });
  await doc.type(USER, { delay: 40 });          // su onkeyup copia el número a Ecom_User_ID
  const pass = await page.$('input[name="Ecom_Password"]');
  await pass.click({ clickCount: 3 });
  await pass.type(PASS, { delay: 40 });
  // El formulario envía Ecom_User_ID (oculto), no Num_Documento: se asegura por si
  // el onkeyup no corrió.
  await page.evaluate((u) => { const h = document.getElementById('Ecom_User_ID'); if (h) h.value = u; }, USER);

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {}),
    page.click('input[type="submit"]'),
  ]);
  // Después del login hay varias redirecciones SSO hasta indemnizaciones-web.
  const salio = await page.waitForFunction(() => location.host === 'www.segurosbolivar.com', { timeout: 60000 })
    .then(() => true).catch(() => false);
  if (!salio) {
    const dice = await page.evaluate(() => (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').slice(0, 250))
      .catch(() => '');
    await volcar(page, 'login_fallido');
    throw new Error(`El login de Bolívar no pasó (sigue en ${page.url().split('?')[0]}). La página dice: "${dice}"`);
  }
  log(`✅ Login OK: ${page.url()}`);
  await paso(page, '01_tras_login');
}

async function irASolicitarDocumentos(page) {
  const menu = await esperar(page, 'marcarPorTexto', { attr: 'data-bd-menu', patron: '^solicitar\\s+documentos?$' }, 60000);
  if (!menu) {
    await volcar(page, 'sin_menu_solicitar');
    throw new Error('No encontré "Solicitar documentos" en el menú del portal.');
  }
  await clic(menu.fr, 'data-bd-menu');
  const form = await esperar(page, 'hayTexto', { patron: 'nit de la inmobiliaria' }, 60000);
  if (!form) {
    await volcar(page, 'sin_formulario_documentos');
    throw new Error('Pulsé "Solicitar documentos" pero no apareció el formulario (NIT de la inmobiliaria).');
  }
  await waitMs(1000);
  await paso(page, '02_solicitar_documentos');
  return form.fr;
}

/** NIT + solicitud → BUSCAR. Devuelve el frame de resultados, o { vacio } si el portal no trae nada. */
async function buscarEnPortal(page, fr, nit, solicitud) {
  const okNit = await fr.evaluate(enPagina, 'marcarInput', { attr: 'data-bd-nit', patron: 'nit de la inmobiliaria' });
  const okSol = await fr.evaluate(enPagina, 'marcarInput', { attr: 'data-bd-sol', patron: 'n[uú]mero de solicitud' });
  if (!okNit || !okSol) {
    await volcar(page, 'sin_campos_busqueda');
    throw new Error('No encontré los campos "NIT de la inmobiliaria" / "número de solicitud".');
  }
  await escribir(fr, 'data-bd-nit', nit, 'el NIT');
  await escribir(fr, 'data-bd-sol', solicitud, 'la solicitud');

  const okBuscar = await fr.evaluate(enPagina, 'marcarPorTexto', {
    attr: 'data-bd-buscar', patron: '^buscar$', sel: 'a,button,input[type=submit],input[type=button],[role=button]',
  });
  if (!okBuscar) { await volcar(page, 'sin_boton_buscar'); throw new Error('No encontré el botón BUSCAR.'); }
  await clic(fr, 'data-bd-buscar');

  // Un "no se encontraron registros" puede estar en pantalla ANTES de que llegue la
  // respuesta: solo se cree pasados unos segundos sin que aparezca la fila.
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    await waitMs(1000);
    const r = await enFrames(page, 'resultadoBusqueda', { solicitud });
    if (r && r.r.fila) { await paso(page, '03_resultados'); return { fr: r.fr }; }
    if (r && r.r.vacio && Date.now() - t0 > 8000) return { vacio: r.r.vacio };
  }
  await volcar(page, 'sin_resultados');
  throw new Error(`BUSCAR no devolvió la fila de la solicitud ${solicitud} con "Ver Anexos".`);
}

/** Nombre del archivo: el de la tabla del portal, con la extensión real si no la trae. */
function nombreArchivo(deLaTabla, arch, i) {
  const limpio = (s) => String(s || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  let nombre = limpio(deLaTabla) || limpio(arch.nombre) || `DOCUMENTO ${i + 1}`;
  if (!path.extname(nombre)) {
    nombre += path.extname(limpio(arch.nombre)) || (arch.buffer.subarray(0, 4).toString() === '%PDF' ? '.pdf' : '');
  }
  return nombre;
}

/**
 * El portal a veces tiene el MISMO archivo cargado dos veces (solicitud 11752770:
 * dos filas, mismos bytes). Esos se descartan; uno distinto con el mismo nombre
 * se conserva y lo renombra `nombresUnicos`.
 */
function sinDuplicados(archivos, solicitud) {
  const vistos = new Map();
  return archivos.filter((a) => {
    const h = crypto.createHash('sha256').update(a.buffer).digest('hex');
    if (vistos.has(h)) {
      log(`= ${solicitud}: "${a.nombre}" es idéntico a "${vistos.get(h)}"; no se guarda dos veces.`);
      return false;
    }
    vistos.set(h, a.nombre);
    return true;
  });
}

/** El portal repite nombres (dos "MANUEL FERNANDO QUINTERO.pdf"): el segundo pasa a "… (2).pdf". */
function nombresUnicos(archivos) {
  const usados = new Map();
  return archivos.map((a) => {
    const k = a.nombre.toLowerCase();
    const n = (usados.get(k) || 0) + 1;
    usados.set(k, n);
    if (n === 1) return a;
    const ext = path.extname(a.nombre);
    return { ...a, nombre: `${a.nombre.slice(0, a.nombre.length - ext.length)} (${n})${ext}` };
  });
}

async function anexosDeSolicitud(page, descargas, nit, solicitud) {
  const fr = await irASolicitarDocumentos(page);
  const busqueda = await buscarEnPortal(page, fr, nit, solicitud);
  if (busqueda.vacio) {
    log(`⊘ ${solicitud}: el portal dice "${busqueda.vacio}".`);
    return [];
  }

  await clic(busqueda.fr, 'data-bd-anexos');
  const archivos = [];
  let firmaPrevia = null;
  for (let pagina = 1; pagina <= 30; pagina++) {
    const modal = await esperar(page, 'modalAnexos', {}, 30000);
    if (!modal) { await volcar(page, 'sin_modal_anexos'); throw new Error('"Ver Anexos" no abrió el modal "Documentos Anexos".'); }
    await waitMs(1500);   // las filas pueden llegar después que el título
    const { fr: frModal, r } = await enFrames(page, 'modalAnexos', {}) || modal;
    if (r.firma === firmaPrevia) break;   // "siguiente" no cambió nada: se acabaron las páginas
    firmaPrevia = r.firma;
    if (pagina === 1) await paso(page, '04_modal_anexos');

    for (const fila of r.filas) {
      if (!await frModal.evaluate(enPagina, 'marcarDescarga', { i: fila.i })) {
        throw new Error(`no encontré el botón "Descargar Documento" de "${fila.nombre}"`);
      }
      const arch = await bajarDocumento(frModal, descargas);
      const nombre = nombreArchivo(fila.nombre, arch, archivos.length);
      archivos.push({ nombre, buffer: arch.buffer });
      log(`↓ ${solicitud}: ${nombre} (${Math.round(arch.buffer.length / 1024)} kB)`);
    }

    if (!await frModal.evaluate(enPagina, 'marcarSiguiente', {})) break;
    await clic(frModal, 'data-bd-sig');
    await waitMs(2000);
  }

  // Cerrar el modal: si se queda abierto tapa el menú del siguiente caso.
  const cerrar = await enFrames(page, 'marcarCerrar', {});
  if (cerrar) await clic(cerrar.fr, 'data-bd-cerrar').catch(() => {});
  else await page.keyboard.press('Escape').catch(() => {});
  await waitMs(1000);

  return nombresUnicos(sinDuplicados(archivos, solicitud));
}

/**
 * Baja los anexos de varias solicitudes con un login en cada portal.
 * `casos`: [{ solicitud, nit? }] — sin nit, se lee del Huella.
 * Nunca lanza por un caso suelto.
 *
 * Devuelve [{ solicitud, success, nit?, inmobiliaria?, archivos?: [{ nombre, buffer }], motivo?, error? }]
 */
async function descargarDocumentos(casos, opts = {}) {
  if (!USER || !PASS) {
    throw new Error('Faltan credenciales del portal de documentos: BOLIVAR_DOCS_USER / BOLIVAR_DOCS_PASS en sac_scripts/.env');
  }
  const porSolicitud = new Map();
  for (const c of casos || []) {
    const solicitud = String(typeof c === 'string' ? c : (c && c.solicitud) || '').trim();
    const nit = String((c && c.nit) || '').split('-')[0].replace(/\D/g, '');
    if (solicitud) porSolicitud.set(solicitud, { solicitud, nit, inmobiliaria: '' });
  }
  if (!porSolicitud.size) return [];
  const resultados = new Map();

  // 1) Huella, para los que no traen NIT: el NIT y, de paso, lo que pide el
  //    formulario de solicitud de documentos (póliza, estado, ciudad).
  const sinNit = [...porSolicitud.values()].filter((c) => !c.nit).map((c) => c.solicitud);
  if (sinNit.length) {
    for (const r of await datosDeSolicitudes(sinNit, opts)) {
      const c = porSolicitud.get(r.solicitud);
      if (r.success) {
        c.nit = r.nit;
        c.inmobiliaria = r.inmobiliaria;
        c.huella = { poliza: r.poliza || '', estado: r.estado || '', ciudad: r.ciudad || '', errores: r.errores || {} };
      } else {
        resultados.set(r.solicitud, { solicitud: r.solicitud, success: false, error: `Huella: ${r.error}` });
      }
    }
  }
  const conNit = [...porSolicitud.values()].filter((c) => c.nit);

  // 2) Portal de documentos de Bolívar.
  if (conNit.length) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    const dir = fs.mkdtempSync(path.join(TEMP_DIR, 'descargas_'));
    const browser = await puppeteer.launch({
      headless: opts.headless === false || process.env.HEADLESS === 'false' ? false : 'shell',
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-gpu', '--window-size=1920,1080',
      ],
    });
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1920, height: 1080 });
      // El User-Agent de headless dice "HeadlessChrome", que es justo lo que filtran
      // los cortafuegos de bots (el login pasa por Cloudflare).
      await page.setUserAgent((await browser.userAgent()).replace('HeadlessChrome', 'Chrome'));
      page.setDefaultTimeout(NAV_TIMEOUT);
      page.setDefaultNavigationTimeout(NAV_TIMEOUT);

      const descargas = new Descargas(browser, dir);
      await descargas.activar();
      await loginBolivar(page);

      for (const c of conNit) {
        try {
          const archivos = await anexosDeSolicitud(page, descargas, c.nit, c.solicitud);
          resultados.set(c.solicitud, {
            solicitud: c.solicitud, success: true, nit: c.nit, inmobiliaria: c.inmobiliaria, archivos,
            ...(archivos.length ? {} : { motivo: 'el portal no tiene anexos para esta solicitud' }),
          });
          log(`✓ ${c.solicitud}: ${archivos.length} documento(s).`);
        } catch (e) {
          const shot = await volcar(page, `error_${c.solicitud}`).catch(() => null);
          resultados.set(c.solicitud, {
            solicitud: c.solicitud, success: false, nit: c.nit, inmobiliaria: c.inmobiliaria,
            error: e.message + (shot ? ` (pantallazo en ${shot})` : ''),
          });
          log(`✗ ${c.solicitud}: ${e.message}`);
        }
      }
    } catch (e) {
      // Falla general (el login): ningún caso pendiente se pudo intentar.
      for (const c of conNit) {
        if (!resultados.has(c.solicitud)) {
          resultados.set(c.solicitud, { solicitud: c.solicitud, success: false, nit: c.nit, inmobiliaria: c.inmobiliaria, error: e.message });
        }
      }
      log(`✗ Portal de documentos: ${e.message}`);
    } finally {
      await browser.close().catch(() => {});
      // En Windows Chrome tarda en soltar la carpeta tras cerrar: se reintenta.
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    }
  }

  // Los datos del Huella viajan aunque los anexos fallen: el formulario no depende de ellos.
  return [...porSolicitud.values()].map((c) => ({ ...resultados.get(c.solicitud), huella: c.huella || null }));
}

module.exports = { descargarDocumentos };

// ─── CLI ──────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const salir = (obj, code) => { process.stdout.write(JSON.stringify(obj, null, 2)); process.exit(code); };
  const solicitud = String(process.argv[2] || '').trim();
  if (!solicitud) salir({ success: false, error: 'Uso: node libertador_documentos.js <solicitud> [nit]' }, 1);

  descargarDocumentos([{ solicitud, nit: process.argv[3] || '' }])
    .then(([r]) => {
      if (r.archivos) {
        const dir = path.join(TEMP_DIR, `documentos_${solicitud}`);
        fs.mkdirSync(dir, { recursive: true });
        for (const a of r.archivos) fs.writeFileSync(path.join(dir, a.nombre), a.buffer);
        r.carpeta = dir;
        r.archivos = r.archivos.map((a) => ({ nombre: a.nombre, bytes: a.buffer.length }));
      }
      salir(r, r.success ? 0 : 1);
    })
    .catch((e) => salir({ success: false, error: e.message }, 1));
}
