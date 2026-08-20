/**
 * services/visionOcr.js — OCR con Google Cloud Vision (DOCUMENT_TEXT_DETECTION).
 *
 * POR QUÉ existe: tesseract.js lee tipografía pero NO caligrafía, y buena parte
 * de los pagarés escaneados traen la fecha de suscripción escrita a mano. Vision
 * sí reconoce manuscrito. El resto del pipeline no cambia: se sigue rasterizando
 * el PDF con pdf-to-img y solo se sustituye el motor que convierte imagen→texto.
 *
 * POR QUÉ imágenes y no el PDF directo: Vision acepta PDF, pero únicamente por
 * `files:asyncBatchAnnotate`, que exige un bucket de GCS de ENTRADA y otro de
 * SALIDA y es asíncrono. Para dos páginas no compensa montar eso: `images:annotate`
 * es síncrono y no necesita nada más.
 *
 * Auth: cuenta de servicio PROPIA (VISION_SA_KEY), distinta de la de Drive y sin
 * delegación de dominio ni permisos sobre Drive. Si esa clave se filtra, lo peor
 * que permite es gastar cuota de Vision — no leer documentos de clientes.
 *
 * Coste: 1 unidad por página, con ~1.000 unidades/mes gratis. El pagaré se lee
 * con maxPages=2, o sea ~500 demandas/mes sin coste.
 *
 * Env (ver src/config.js):
 *   OCR_MOTOR=vision       activa este motor
 *   VISION_SA_KEY=/ruta/al/vision-sa.json
 */
'use strict';

const config = require('../config');

const ENDPOINT = 'https://vision.googleapis.com/v1/images:annotate';
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

// Tope de payload por petición. Vision admite hasta 16 imágenes y 20 MB por
// imagen, pero el JSON va en base64 (+33 %) y las peticiones grandes fallan con
// errores poco claros. Se agrupa por TAMAÑO, no por número de páginas: dos
// escaneos a 300 dpi pueden pesar más que diez páginas de texto limpio.
const MAX_IMAGENES_POR_LOTE = 5;
const MAX_BYTES_POR_LOTE = 6 * 1024 * 1024;

let _cliente = null;

/**
 * Cliente autenticado. google-auth-library se carga aquí dentro a propósito:
 * si OCR_MOTOR no es 'vision', el motor arranca igual aunque la dependencia no
 * esté instalada (p. ej. un servidor que aún no ha hecho npm ci).
 */
async function getCliente() {
  if (_cliente) return _cliente;
  if (!config.VISION_SA_KEY) {
    throw new Error('VISION_SA_KEY no está configurada en el .env del motor.');
  }
  let GoogleAuth;
  try {
    ({ GoogleAuth } = require('google-auth-library'));
  } catch (e) {
    throw new Error('Falta la dependencia google-auth-library (npm ci en sac_scripts).');
  }
  const auth = new GoogleAuth({ keyFile: config.VISION_SA_KEY, scopes: [SCOPE] });
  _cliente = await auth.getClient();
  return _cliente;
}

/** Agrupa las imágenes en lotes que quepan en una petición. */
function lotes(imgs) {
  const out = [];
  let actual = [];
  let bytes = 0;
  for (const img of imgs) {
    const peso = Math.ceil(img.length * 4 / 3); // lo que ocupará en base64
    if (actual.length && (actual.length >= MAX_IMAGENES_POR_LOTE || bytes + peso > MAX_BYTES_POR_LOTE)) {
      out.push(actual);
      actual = [];
      bytes = 0;
    }
    actual.push(img);
    bytes += peso;
  }
  if (actual.length) out.push(actual);
  return out;
}

/**
 * Confianza de la página. Vision la publica en fullTextAnnotation.pages[].confidence,
 * pero no siempre viene; entonces se promedia la de los bloques. Es informativa:
 * ningún camino de decisión depende de ella, solo los logs y la sonda.
 */
function confianza(fta) {
  const pag = fta && fta.pages && fta.pages[0];
  if (!pag) return 0;
  if (typeof pag.confidence === 'number' && pag.confidence > 0) {
    return Math.round(pag.confidence * 100);
  }
  const bloques = (pag.blocks || []).map((b) => b.confidence).filter((c) => typeof c === 'number');
  if (!bloques.length) return 0;
  return Math.round((bloques.reduce((a, b) => a + b, 0) / bloques.length) * 100);
}

/**
 * OCR de una lista de imágenes (Buffers PNG).
 * Devuelve [{ page, confidence, text }] en el mismo orden que entraron.
 */
async function ocrImagenes(imgs) {
  const cliente = await getCliente();
  const paginas = [];

  for (const lote of lotes(imgs)) {
    const requests = lote.map((img) => ({
      image: { content: img.toString('base64') },
      features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
      // 'es' orienta el reconocimiento al español. Vision lo detecta solo, pero
      // la pista mejora los manuscritos, que es justo el caso que nos importa.
      imageContext: { languageHints: ['es'] },
    }));

    let res;
    try {
      res = await cliente.request({ url: ENDPOINT, method: 'POST', data: { requests } });
    } catch (e) {
      throw new Error(mensajeHttp(e));
    }

    for (const r of (res.data && res.data.responses) || []) {
      // Vision responde 200 y mete el fallo POR IMAGEN aquí dentro; sin esto,
      // una página rechazada pasaría como página vacía sin avisar.
      if (r.error && r.error.message) {
        throw new Error(`Vision rechazó una página: ${r.error.message}`);
      }
      const fta = r.fullTextAnnotation;
      paginas.push({
        page: paginas.length + 1,
        confidence: confianza(fta),
        text: ((fta && fta.text) || '').trim(),
      });
    }
  }

  return paginas;
}

/**
 * Traduce los fallos típicos a algo accionable. Son los tres que se ven al
 * estrenar el proyecto y los tres se arreglan en la consola, no en el código.
 */
function mensajeHttp(e) {
  const data = e && e.response && e.response.data;
  const err = data && data.error;
  const msg = (err && err.message) || (e && e.message) || String(e);
  const estado = err && err.status;
  if (/has not been used|is disabled|SERVICE_DISABLED/i.test(msg)) {
    return `${msg} → falta habilitar Cloud Vision API en el proyecto.`;
  }
  if (/billing/i.test(msg)) {
    return `${msg} → el proyecto no tiene facturación activa (hace falta aun para la capa gratuita).`;
  }
  if (estado === 'PERMISSION_DENIED' || /permission/i.test(msg)) {
    return `${msg} → revisa que la clave sea del proyecto correcto y no esté borrada.`;
  }
  return msg;
}

module.exports = { ocrImagenes };
