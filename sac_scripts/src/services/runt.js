/**
 * services/runt.js — Consulta de vehículos por placa en el RUNT
 *
 * Portal: https://portalpublico.runt.gov.co (consulta ciudadana "Placa y Propietario").
 * El formulario pide placa + documento del propietario + un CAPTCHA de imagen.
 * El captcha es un PNG (fuente serif con ruido leve) que se resuelve con OCR
 * local (tesseract.js, modo PSM 7 + whitelist) — sin servicios de pago. Como
 * el captcha se puede refrescar, se reintenta varias veces hasta acertar.
 *
 * Devuelve los campos oficiales del vehículo (color, serie, motor, chasis,
 * tipo de carrocería, autoridad de tránsito) que no vienen en el Excel.
 * Sin caché: las placas no se repiten entre generaciones, se consulta cada vez.
 */

'use strict';

const RUNT_URL  = 'https://portalpublico.runt.gov.co/#/consulta-vehiculo/consulta/consulta-ciudadana';
const MAX_INTENTOS_CAPTCHA = 8;  // OCR del captcha es débil; más intentos + preprocesado
const MAX_FALLOS_SEGUIDOS  = 2;  // tras N placas que agotan intentos → RUNT limitando: desactivar

// Circuit breaker: si el RUNT empieza a rechazar todos los captchas (rate-limit
// por IP), se desactiva para el resto de la corrida.
let _fallosSeguidos   = 0;
let _runtDeshabilitado = false;

// ─── OCR (tesseract.js) — worker singleton ─────────────────────────────────────

let _worker = null;

async function getWorker() {
  if (_worker) return _worker;
  let Tesseract;
  try {
    Tesseract = require('tesseract.js');
  } catch (_) {
    console.error('[RUNT] tesseract.js no instalado — no se puede resolver el captcha (npm i tesseract.js)');
    return null;
  }
  _worker = await Tesseract.createWorker('eng');
  await _worker.setParameters({
    tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
    tessedit_pageseg_mode: '7', // tratar la imagen como una sola línea de texto
  });
  return _worker;
}

// ─── Página RUNT reutilizable (una sola, navegando con "Realizar otra consulta") ─

let _runtPage = null;

// Devuelve una página con el formulario de consulta listo. Reusa la existente
// si el formulario sigue disponible; si no, abre/recarga.
async function abrirRunt(browser) {
  if (_runtPage && !_runtPage.isClosed()) {
    const lista = await _runtPage.$('input[formcontrolname="placa"]').catch(() => null);
    if (lista) return _runtPage;
  }
  if (_runtPage && !_runtPage.isClosed()) { await _runtPage.close().catch(() => {}); _runtPage = null; }

  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
  );

  // El portal del RUNT es una SPA Angular: 'networkidle2' suele NO cumplirse
  // (la app mantiene conexiones abiertas) y deja la carga colgada hasta el
  // timeout. Mejor 'domcontentloaded' + esperar a que monte el campo de placa,
  // con un reintento de navegación si la primera carga no rinde el formulario.
  let lastErr = null;
  for (let intento = 1; intento <= 2; intento++) {
    try {
      await page.goto(RUNT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForSelector('input[formcontrolname="placa"]', { timeout: 45000, visible: true });
      await new Promise(r => setTimeout(r, 2500));
      // Verificar que el CAPTCHA REALMENTE cargó: a veces la página entra pero la
      // imagen del captcha no aparece; recargar lo soluciona (le pasó al usuario).
      await asegurarCaptcha(page);
      _runtPage = page;
      return page;
    } catch (e) {
      lastErr = e;
      console.error(`[RUNT] carga del formulario falló (intento ${intento}/2): ${e.message}`);
      if (intento < 2) await new Promise(r => setTimeout(r, 3000));
    }
  }
  try { await page.close(); } catch (_) {}
  throw new Error(`no cargó el formulario del RUNT tras 2 intentos: ${lastErr && lastErr.message}`);
}

// Vuelve al formulario desde la página de resultados con el botón
// "Realizar otra consulta" (trae captcha nuevo sin recargar todo).
async function volverAConsulta(page) {
  const clicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button, a')]
      .find(x => /realizar otra|otra consulta|nueva consulta/i.test(x.textContent || ''));
    if (b) { b.click(); return true; }
    return false;
  });
  if (clicked) {
    try {
      await page.waitForSelector('input[formcontrolname="placa"]', { timeout: 15000 });
      await new Promise(r => setTimeout(r, 1500));
      return true;
    } catch (_) {}
  }
  return recargarForm(page); // fallback
}

// Recarga el formulario (para obtener un captcha nuevo tras un fallo de OCR)
async function recargarForm(page) {
  try {
    await page.goto(RUNT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('input[formcontrolname="placa"]', { timeout: 30000, visible: true });
    await new Promise(r => setTimeout(r, 2000));
    return true;
  } catch (_) { return false; }
}

async function cerrarWorker() {
  if (_runtPage) { try { await _runtPage.close(); } catch (_) {} _runtPage = null; }
  if (_worker) { try { await _worker.terminate(); } catch (_) {} _worker = null; }
  // Reiniciar el circuit breaker para la próxima corrida
  _fallosSeguidos = 0;
  _runtDeshabilitado = false;
}

// ─── Helpers de página ─────────────────────────────────────────────────────────

// data:image/png;base64 del captcha (img grande embebida).
// Espera hasta 12s a que la imagen del captcha termine de renderizar.
async function grabCaptcha(page) {
  try {
    await page.waitForFunction(() => {
      const img = [...document.querySelectorAll('img')]
        .find(i => (i.src || '').startsWith('data:image') && i.width > 200 && i.height > 50);
      return !!img;
    }, { timeout: 12000 });
  } catch (_) {
    return null;
  }
  return page.evaluate(() => {
    const img = [...document.querySelectorAll('img')]
      .find(i => (i.src || '').startsWith('data:image') && i.width > 200 && i.height > 50);
    return img ? img.src : null;
  });
}

// Preprocesa el captcha para subir el acierto del OCR: lo reescala 3x y lo
// binariza (gris → blanco/negro por umbral). Devuelve un PNG dataURL nuevo.
async function preprocesarCaptcha(page, dataUrl) {
  try {
    return await page.evaluate(async (src) => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = src; });
      const scale = 3;
      const c = document.createElement('canvas');
      c.width = (img.width || 250) * scale;
      c.height = (img.height || 80) * scale;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(img, 0, 0, c.width, c.height);
      const d = ctx.getImageData(0, 0, c.width, c.height);
      const px = d.data;
      for (let i = 0; i < px.length; i += 4) {
        const g = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
        const v = g < 140 ? 0 : 255;   // umbral
        px[i] = px[i + 1] = px[i + 2] = v;
      }
      ctx.putImageData(d, 0, 0);
      return c.toDataURL('image/png');
    }, dataUrl);
  } catch (_) {
    return dataUrl; // si algo falla, OCR sobre el original
  }
}

// Garantiza que la imagen del captcha esté cargada en el formulario. Si no
// aparece, RECARGA la página y reintenta (hasta 3 veces). Esto cubre el caso en
// que el portal entra pero no muestra el captcha: una recarga lo hace aparecer.
async function asegurarCaptcha(page) {
  for (let i = 1; i <= 3; i++) {
    if (await grabCaptcha(page)) return true;
    console.error(`[RUNT] captcha no visible al cargar (intento ${i}/3) → recargando la página`);
    try {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForSelector('input[formcontrolname="placa"]', { timeout: 30000, visible: true });
      await new Promise(r => setTimeout(r, 2000));
    } catch (_) { /* siguiente intento */ }
  }
  console.error('[RUNT] captcha sigue sin aparecer tras 3 recargas; se intentará igual');
  return false;
}

// Etiqueta normalizada (sin tildes, mayúsculas, sin ":" final) → campo
const LABEL_A_CAMPO = {
  'MARCA': 'marca',
  'LINEA': 'linea',
  'MODELO': 'modelo',
  'COLOR': 'color',
  'NUMERO DE SERIE': 'serie',
  'NUMERO DE MOTOR': 'motor',
  'NUMERO DE CHASIS': 'chasis',
  'TIPO DE CARROCERIA': 'tipoCarroceria',
  'CLASE DE VEHICULO': 'clase',
  'CLASE': 'clase',
  'TIPO DE SERVICIO': 'servicio',
  'CILINDRAJE': 'cilindraje',
  'AUTORIDAD DE TRANSITO': 'autoridad',
};

function norm(s) {
  return String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ').trim();
}

// Parsea los campos del vehículo. El RUNT muestra los datos como etiqueta y
// valor en líneas separadas; cuando un valor está vacío (p.ej. SERIE en motos)
// las etiquetas quedan contiguas. Regla robusta: cada línea-valor pertenece a
// la ÚLTIMA etiqueta vista (la etiqueta sin valor queda vacía). Funciona tanto
// para "SERIE:\nvalor\nMOTOR:\nvalor" como para "SERIE:\nMOTOR:\nvalor".
function parsearResultado(texto) {
  const out = {};
  let lastKey = null;
  const esBasura = v => !v || /^(NO\s+(REGISTRA|APLICA)|N\/?A|calendar_month|directions_car)$/i.test(v);

  for (const rawLine of texto.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    // ¿La línea es "ETIQUETA:" (posiblemente con valor en la misma línea)?
    const mLbl = line.match(/^([^:]{2,45}):\s*(.*)$/);
    if (mLbl) {
      const campo = LABEL_A_CAMPO[norm(mLbl[1])];
      if (campo) {
        const inline = mLbl[2].trim();
        if (inline && !esBasura(inline)) {
          if (out[campo] === undefined) out[campo] = inline.toUpperCase();
          lastKey = null;
        } else {
          lastKey = campo; // valor vendrá en una línea siguiente
        }
        continue;
      }
      // etiqueta no rastreada → cualquier valor pendiente se descarta
      lastKey = null;
      continue;
    }

    // Línea sin ":" → es un valor; se asigna a la última etiqueta pendiente
    if (lastKey && out[lastKey] === undefined && !esBasura(line)) {
      out[lastKey] = line.replace(/\s{2,}/g, ' ').toUpperCase();
    }
    lastKey = null;
  }

  return {
    marca:          out.marca          || '',
    linea:          out.linea          || '',
    modelo:         out.modelo         || '',
    color:          out.color          || '',
    serie:          out.serie          || '',
    motor:          out.motor          || '',
    chasis:         out.chasis         || '',
    tipoCarroceria: out.tipoCarroceria || '',
    autoridad:      out.autoridad      || '',
    clase:          out.clase          || '',
    servicio:       out.servicio       || '',
    cilindraje:     out.cilindraje     || '',
  };
}

// ─── Consulta principal ────────────────────────────────────────────────────────

/**
 * Consulta una placa en el RUNT. Devuelve campos del vehículo o null.
 * browser: instancia puppeteer abierta; cedula: documento del propietario.
 */
async function consultarPlacaRunt(browser, placa, cedula = '', opts = {}) {
  const key = String(placa || '').trim().toUpperCase();
  if (!key) return null;
  if (!browser) return null;

  // Circuit breaker: el RUNT está limitando → no insistir esta corrida
  if (_runtDeshabilitado) {
    console.error(`[RUNT] ${key}: omitido (RUNT limitando por IP esta corrida)`);
    return null;
  }

  const worker = await getWorker();
  if (!worker) return null;

  try {
    console.error(`[RUNT] Consultando placa ${key} (propietario ${cedula || 's/d'})...`);
    // Página reutilizada entre todas las placas (form listo al entrar)
    const page = await abrirRunt(browser);

    let datos = null;
    for (let intento = 1; intento <= MAX_INTENTOS_CAPTCHA && !datos; intento++) {
      // Limpiar y llenar placa + documento (el captcha se vuelve a leer cada vez)
      await page.evaluate(() => {
        document.querySelectorAll('input[formcontrolname]').forEach(i => {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(i, '');
          i.dispatchEvent(new Event('input', { bubbles: true }));
        });
      });
      await page.type('input[formcontrolname="placa"]', key, { delay: 40 });
      await page.type('input[formcontrolname="documento"]', String(cedula), { delay: 40 });

      // OCR del captcha (con preprocesado: reescalado + binarizado)
      const dataUrl = await grabCaptcha(page);
      if (!dataUrl) { await recargarForm(page); continue; }
      const procUrl = await preprocesarCaptcha(page, dataUrl);
      const { data } = await worker.recognize(Buffer.from(procUrl.split(',')[1], 'base64'));
      const sol = (data.text || '').replace(/[^A-Za-z0-9]/g, '');
      if (sol.length !== 5) {            // los captchas RUNT son de 5 caracteres
        await recargarForm(page);        // sin botón de refresco → recargar
        continue;
      }
      await page.type('input[formcontrolname="captcha"]', sol, { delay: 40 });

      // Consultar
      await page.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find(x => /consultar/i.test(x.textContent || ''));
        if (b) b.click();
      });
      // Esperar a que la página responda: tabla de resultados o modal de captcha inválido.
      await page.waitForFunction(
        () => /N[UÚ]MERO DE MOTOR|Informaci[oó]n general del veh|captcha no es v[aá]lid/i.test(document.body.innerText || ''),
        { timeout: 15000 }
      ).catch(() => {});

      const estado = await page.evaluate(() => {
        const txt = document.body.innerText || '';
        return {
          hayTabla:    /N[UÚ]MERO DE MOTOR|Informaci[oó]n general del veh/i.test(txt),
          captchaMalo: /captcha no es v[aá]lid/i.test(txt),
          texto: txt,
        };
      });

      if (estado.hayTabla) {
        datos = parsearResultado(estado.texto);
        console.error(`[RUNT] ✓ ${key}: ${datos.marca} ${datos.linea} ${datos.modelo} (intento ${intento})`);
        // Guardar la consulta del RUNT como PDF (equivale al Ctrl+P del usuario) →
        // se anexa luego en el ANEXO del RUNT. Solo si el caller pidió pdfPath.
        if (opts.pdfPath) {
          try {
            await page.pdf({ path: opts.pdfPath, format: 'A4', printBackground: true });
            datos.pdfPath = opts.pdfPath;
            console.error(`[RUNT] ${key}: PDF de la consulta guardado → ${require('path').basename(opts.pdfPath)}`);
          } catch (e) {
            console.error(`[RUNT] ${key}: no se pudo guardar el PDF de la consulta: ${e.message}`);
          }
        }
      } else if (estado.captchaMalo) {
        // Captcha mal leído → recargar para un captcha nuevo y reintentar
        await recargarForm(page);
      } else {
        // Captcha aceptado pero sin tabla → la placa no corresponde al propietario.
        // Se devuelve {noMatch} (≠ null) para que el caller la EXCLUYA de la demanda
        // y los anexos (distinto de un fallo de consulta, en que no se sabe).
        console.error(`[RUNT] ${key}: la placa no corresponde al documento ${cedula} (no-match)`);
        _fallosSeguidos = 0;          // hubo respuesta del RUNT → no está limitando
        await volverAConsulta(page);  // dejar el form listo para la siguiente placa
        return { placa: key, noMatch: true };
      }
    }

    if (datos) {
      // Éxito → dejar el form listo para la siguiente placa
      _fallosSeguidos = 0;
      await volverAConsulta(page);
      return { placa: key, ...datos };
    }

    // Se agotaron los intentos de captcha → rate-limit / OCR. Cuenta para el freno.
    console.error(`[RUNT] ${key}: sin resultados tras ${MAX_INTENTOS_CAPTCHA} intentos`);
    _fallosSeguidos++;
    if (_fallosSeguidos >= MAX_FALLOS_SEGUIDOS) {
      _runtDeshabilitado = true;
      console.error(`[RUNT] RUNT desactivado por esta corrida: ${_fallosSeguidos} placa(s) seguidas sin respuesta (rate-limit).`);
    }
    return null;

  } catch (e) {
    console.error(`[RUNT] ${key}: ${e.message}`);
    // Si la página quedó en mal estado, descartarla para reabrir limpia
    if (_runtPage) { try { await _runtPage.close(); } catch (_) {} _runtPage = null; }
    // Un fallo de carga/navegación (portal caído o lento) también cuenta para el
    // freno: si el RUNT no rinde el formulario, no gastar 45s por cada placa el
    // resto de la corrida → se desactiva tras MAX_FALLOS_SEGUIDOS seguidos.
    _fallosSeguidos++;
    if (_fallosSeguidos >= MAX_FALLOS_SEGUIDOS) {
      _runtDeshabilitado = true;
      console.error(`[RUNT] RUNT desactivado por esta corrida: ${_fallosSeguidos} fallo(s) seguidos de carga/consulta (portal no disponible).`);
    }
    return null;
  }
}

module.exports = { consultarPlacaRunt, cerrarWorker };
