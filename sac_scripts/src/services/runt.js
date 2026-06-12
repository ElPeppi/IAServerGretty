/**
 * services/runt.js — Consulta de vehículos por placa en el RUNT (best-effort)
 *
 * Cuando el Excel solo trae la placa (sin DESCRP_VS_NO_PRENDADOS), se intenta
 * completar los datos del vehículo desde la consulta ciudadana del RUNT.
 *
 * LIMITACIÓN CONOCIDA: el portal del RUNT exige captcha. Si el captcha está
 * presente (lo normal), la consulta se aborta y el vehículo queda solo con la
 * placa — el resto de campos se completan manualmente. El resultado (incluso
 * el fallo) se cachea para no reintentar la misma placa en cada corrida.
 */

'use strict';

const path = require('path');
const fs   = require('fs');

const config = require('../config');

const RUNT_URL  = 'https://www.runt.com.co/consultaCiudadana/#/consultaVehiculo';
const CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 días: los datos del vehículo no cambian

let _cache = null;

function cacheFile() {
  return path.join(config.OUT_DIR, 'runt_cache.json');
}

function loadCache() {
  if (_cache) return _cache;
  _cache = {};
  try {
    if (fs.existsSync(cacheFile())) {
      _cache = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
    }
  } catch (_) {}
  return _cache;
}

function saveCache() {
  try {
    fs.writeFileSync(cacheFile(), JSON.stringify(_cache, null, 2), 'utf8');
  } catch (_) {}
}

// Parsea pares "Etiqueta: valor" del texto de la página de resultados RUNT
function parsearCamposRunt(texto) {
  const get = (...labels) => {
    for (const label of labels) {
      const re = new RegExp(label + String.raw`\s*:?\s*\n?\s*([A-ZÁÉÍÓÚÑÜ0-9][A-ZÁÉÍÓÚÑÜ0-9 .\-\/]{0,40})`, 'i');
      const m = texto.match(re);
      if (m && m[1].trim() && !/^NO\s+(?:REGISTRA|APLICA)/i.test(m[1])) return m[1].trim().toUpperCase();
    }
    return '';
  };

  return {
    marca:          get('Marca'),
    linea:          get('L[ií]nea'),
    modelo:         get('Modelo'),
    color:          get('Color'),
    clase:          get('Clase de veh[ií]culo', 'Clase'),
    servicio:       get('Tipo de servicio', 'Servicio'),
    motor:          get('N[uú]mero de motor'),
    serie:          get('N[uú]mero de serie', 'VIN'),
    chasis:         get('N[uú]mero de chasis'),
    tipoCarroceria: get('Tipo de carrocer[ií]a'),
  };
}

/**
 * Consulta una placa en el RUNT. Devuelve un objeto vehículo parcial
 * { placa, marca, linea, modelo, ... } o null si la consulta no fue posible.
 *
 * browser: instancia puppeteer ya abierta (se reusa la del proceso singular).
 */
async function consultarPlacaRunt(browser, placa, cedula = '') {
  const key   = String(placa || '').trim().toUpperCase();
  if (!key) return null;

  const cache = loadCache();
  const hit   = cache[key];
  if (hit && Date.now() - (hit.ts || 0) < CACHE_TTL) {
    return hit.ok ? { placa: key, ...hit.datos } : null;
  }

  if (!browser) return null;

  let page;
  try {
    console.error(`[RUNT] Consultando placa ${key}...`);
    page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
    );
    await page.goto(RUNT_URL, { waitUntil: 'networkidle2', timeout: 45000 });
    await new Promise(r => setTimeout(r, 2500));

    // ¿Hay captcha visible? → no se puede automatizar la consulta
    const hayCaptcha = await page.evaluate(() => {
      const txt = (document.body.innerText || '').toLowerCase();
      return !!document.querySelector('iframe[src*="recaptcha"], .g-recaptcha, #captcha, img[src*="captcha" i]')
          || txt.includes('captcha');
    });
    if (hayCaptcha) {
      console.error(`[RUNT] ${key}: el portal exige captcha — consulta omitida (completar manualmente)`);
      cache[key] = { ok: false, motivo: 'captcha', ts: Date.now() };
      saveCache();
      return null;
    }

    // Llenar formulario (selectores tolerantes a cambios del portal)
    const placaInput = await page.$('#noPlaca, input[name="noPlaca"], input[placeholder*="laca" i]');
    if (!placaInput) throw new Error('formulario de consulta no encontrado');
    await placaInput.type(key, { delay: 50 });

    if (cedula) {
      const docInput = await page.$('#noDocumento, input[name="noDocumento"], input[placeholder*="ocumento" i]');
      if (docInput) await docInput.type(String(cedula), { delay: 50 });
    }

    const btn = await page.$('button[type="submit"], #btnConsultar, button.btn-primary');
    if (btn) await btn.click();
    await new Promise(r => setTimeout(r, 5000));

    const texto = await page.evaluate(() => document.body.innerText || '');
    const datos = parsearCamposRunt(texto);

    const tieneAlgo = Object.values(datos).some(v => v);
    cache[key] = { ok: tieneAlgo, datos, ts: Date.now() };
    saveCache();

    if (!tieneAlgo) {
      console.error(`[RUNT] ${key}: sin datos en la respuesta`);
      return null;
    }
    console.error(`[RUNT] ✓ ${key}: ${datos.marca} ${datos.linea} ${datos.modelo}`);
    return { placa: key, ...datos };

  } catch (e) {
    console.error(`[RUNT] ${key}: ${e.message}`);
    cache[key] = { ok: false, motivo: e.message, ts: Date.now() };
    saveCache();
    return null;
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

module.exports = { consultarPlacaRunt };
