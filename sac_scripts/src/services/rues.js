/**
 * services/rues.js — Cámara de Comercio del empleador por NIT (RUES)
 *
 * Para el punto 5 de "Pruebas y Anexos" de la demanda:
 *   "Certificado de existencia... del empleador X, expedido por la Cámara de
 *    Comercio de {CIUDAD}".
 * La ciudad de la Cámara de Comercio se obtiene del RUES (https://rues.org.co)
 * consultando el NIT de la empresa. El resultado vive en la ruta directa
 * /buscar/RM/{nit} (Registro Mercantil), de donde se lee "Cámara de Comercio".
 *
 * Sin caché: se consulta cada vez (los NIT rara vez se repiten entre corridas).
 */

'use strict';

const RUES_URL = nit => `https://www.rues.org.co/buscar/RM/${nit}`;

/**
 * Devuelve la ciudad de la Cámara de Comercio del NIT, o '' si no se encuentra.
 * browser: instancia puppeteer abierta.
 */
async function consultarCamaraRues(browser, nit) {
  const limpio = String(nit || '').replace(/\D/g, '').replace(/^(\d{6,11}).*$/, '$1');
  if (!limpio || limpio.length < 6) return '';
  if (!browser) return '';

  let page;
  try {
    console.error(`[RUES] Consultando NIT ${limpio}...`);
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
    );
    await page.goto(RUES_URL(limpio), { waitUntil: 'networkidle2', timeout: 60000 });

    // Esperar a que aparezca la ficha con "Cámara de Comercio"
    await page.waitForFunction(
      () => /C[aá]mara de Comercio/i.test(document.body.innerText || ''),
      { timeout: 25000 }
    ).catch(() => {});
    await new Promise(r => setTimeout(r, 1500));

    const ciudad = await page.evaluate(() => {
      const txt = (document.body.innerText || '').replace(/\r/g, '');
      // "Cámara de Comercio\n{CIUDAD}" — la ciudad es la línea siguiente
      const m = txt.match(/C[aá]mara de Comercio\s*\n\s*([^\n]{2,40})/i);
      return m ? m[1].trim() : '';
    });

    if (ciudad) {
      console.error(`[RUES] ✓ NIT ${limpio}: Cámara de Comercio de ${ciudad}`);
      return ciudad;
    }
    console.error(`[RUES] NIT ${limpio}: sin Cámara de Comercio en el resultado`);
    return '';
  } catch (e) {
    console.error(`[RUES] NIT ${limpio}: ${e.message}`);
    return '';
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

module.exports = { consultarCamaraRues };
