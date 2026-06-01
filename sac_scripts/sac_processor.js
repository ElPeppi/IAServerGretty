/**
 * sac_processor.js
 * Recibe la ruta de un archivo ZIP, lo descomprime, extrae la cédula
 * DESDE EL CONTENIDO DE LOS PDFs internos, organiza los archivos en la
 * carpeta de salida y lanza sac_puppeteer.js.
 *
 * Uso:
 *   node sac_processor.js <zipPath> <outputBaseDir> <sacBaseUrl> <usuario> <password>
 *
 * Salida (stdout): JSON con el resultado completo
 */

const AdmZip       = require('adm-zip');
const pdfParse     = require('pdf-parse');
const path         = require('path');
const fs           = require('fs');
const { execSync } = require('child_process');

const [,, zipPath, outputBaseDir, sacBaseUrl, sacUser, sacPass] = process.argv;

// ─── Patrones para detectar cédula colombiana ─────────────────────────────────
// Los PDFs de DataCrédito tienen la estructura de tabla:
//   "Tipo Documento  C.C.  Número Documento  72286794  Estado Documento  Vigente"
// pdf-parse extrae eso como texto plano en una sola línea o con saltos de línea.

// Prioridad 1: campo "Número Documento" seguido del número (formato DataCrédito)
const CEDULA_DATACREDITO_RE = /N[uú]mero\s+Documento\s+(\d{6,11})/i;

// Prioridad 2: "C.C." con hasta 80 caracteres de por medio antes del número
//   Cubre: "C.C. 12345678", "C.C. Número Documento 72286794", "C.C No. 12345678"
const CEDULA_CC_RE = /C\.?\s*C\.?[\s\S]{0,80}?(\d{6,11})/;

// Prioridad 3: "Cédula" / "Cedula de Ciudadanía" seguido del número
const CEDULA_TEXTO_RE = /[Cc][eé]dula\s*(?:de\s*[Cc]iudadan[ií]a)?\s*[:#Nn°\.]?\s*(\d{6,11})/i;

// Prioridad 4: número de 6 a 11 dígitos (sin separadores) — último recurso
const CEDULA_SOLO_RE = /\b(\d{6,11})\b/;

function limpiarNumero(str) {
  return str.replace(/[\s.]/g, '');
}

async function extraerCedulaDePDFs(zip) {
  const entradas = zip.getEntries();

  // ── Intento 1: Leer el texto de cada PDF dentro del ZIP ───────────────────
  for (const entry of entradas) {
    if (!entry.entryName.toLowerCase().endsWith('.pdf') || entry.isDirectory) continue;

    try {
      const buffer = entry.getData();
      const parsed = await pdfParse(buffer, { max: 3 }); // leer máximo 3 páginas
      const texto  = parsed.text || '';

      // 1. Formato DataCrédito: "Número Documento  72286794"
      const mDC = texto.match(CEDULA_DATACREDITO_RE);
      if (mDC) return limpiarNumero(mDC[1]);

      // 2. "C.C." con el número en los próximos ~80 caracteres
      const mCC = texto.match(CEDULA_CC_RE);
      if (mCC) return limpiarNumero(mCC[1]);

      // 3. "Cédula" / "Cédula de Ciudadanía"
      const mTexto = texto.match(CEDULA_TEXTO_RE);
      if (mTexto) return limpiarNumero(mTexto[1]);

      // 4. Primer número de 6-11 dígitos (último recurso dentro del PDF)
      const mSolo = texto.match(CEDULA_SOLO_RE);
      if (mSolo) return mSolo[1];

    } catch (_) {
      // PDF ilegible o protegido → continuar con el siguiente
    }
  }

  // ── Intento 2: Nombre del archivo PDF dentro del ZIP ──────────────────────
  // Por ejemplo: "1012345678_contrato.pdf" o "CC_1012345678.pdf"
  for (const entry of entradas) {
    if (!entry.entryName.toLowerCase().endsWith('.pdf') || entry.isDirectory) continue;
    const nombre = path.basename(entry.entryName, '.pdf');
    const mCC   = nombre.match(CEDULA_CC_RE);
    if (mCC)   return limpiarNumero(mCC[1]);
    const mSolo = nombre.match(CEDULA_SOLO_RE);
    if (mSolo)  return mSolo[1];
  }

  // ── Intento 3: Cualquier archivo de texto dentro del ZIP ──────────────────
  for (const entry of entradas) {
    const nombre = entry.entryName.toLowerCase();
    if (!['.txt', '.csv', '.xml'].some(ext => nombre.endsWith(ext)) || entry.isDirectory) continue;
    try {
      const texto = entry.getData().toString('utf8').slice(0, 3000);
      const m = texto.match(new RegExp(CEDULA_PREFIJO_RE.source, 'i')) || texto.match(CEDULA_SOLO_RE);
      if (m) return limpiarNumero(m[1]);
    } catch (_) {}
  }

  return null;
}

async function main() {
  if (!zipPath || !outputBaseDir || !sacBaseUrl || !sacUser || !sacPass) {
    console.log(JSON.stringify({ success: false, error: 'Argumentos incompletos al llamar sac_processor.js' }));
    process.exit(1);
  }

  if (!fs.existsSync(zipPath)) {
    console.log(JSON.stringify({ success: false, error: `ZIP no encontrado: ${zipPath}` }));
    process.exit(1);
  }

  let zip;
  try {
    zip = new AdmZip(zipPath);
  } catch (e) {
    console.log(JSON.stringify({ success: false, error: `No se pudo leer el ZIP: ${e.message}` }));
    process.exit(1);
  }

  // ── Extraer cédula desde los PDFs internos ────────────────────────────────
  const cedula = await extraerCedulaDePDFs(zip);

  if (!cedula) {
    console.log(JSON.stringify({
      success: false,
      error: `No se encontró número de cédula en los PDFs del ZIP: ${path.basename(zipPath)}`,
      zipPath,
      sugerencia: 'Verifique que los PDFs contengan el número de C.C. en texto legible (no imagen escaneada)',
    }));
    process.exit(1);
  }

  // ── Crear carpeta de salida: {outputBaseDir}/{cedula}/ ────────────────────
  const carpetaSalida = path.join(outputBaseDir, cedula);
  fs.mkdirSync(carpetaSalida, { recursive: true });

  // ── Descomprimir todos los archivos del ZIP en la carpeta del cliente ──────
  zip.extractAllTo(carpetaSalida, true /* sobreescribir */);

  // ── Limpiar el ZIP temporal ────────────────────────────────────────────────
  try { fs.unlinkSync(zipPath); } catch (_) {}

  // ── Lanzar Puppeteer para automatización SAC ───────────────────────────────
  const scriptPuppeteer = path.join(__dirname, 'sac_puppeteer.js');
  const cmd = [
    'node',
    JSON.stringify(scriptPuppeteer),
    JSON.stringify(cedula),
    JSON.stringify(carpetaSalida),
    JSON.stringify(sacBaseUrl),
    JSON.stringify(sacUser),
    JSON.stringify(sacPass),
  ].join(' ');

  let resultadoPuppeteer;
  try {
    const stdout = execSync(cmd, { timeout: 180000, encoding: 'utf8' });
    const lineas = stdout.trim().split('\n').filter(l => l.trim().startsWith('{'));
    resultadoPuppeteer = JSON.parse(lineas[lineas.length - 1]);
  } catch (e) {
    resultadoPuppeteer = {
      success: false,
      error: `Error ejecutando Puppeteer: ${e.message}`.slice(0, 500),
      cedula,
    };
  }

  // ── Listar archivos finales en la carpeta ─────────────────────────────────
  const archivosFinales = fs.readdirSync(carpetaSalida);

  console.log(JSON.stringify({
    success:        resultadoPuppeteer.success,
    cedula,
    carpetaSalida,
    archivosZip:    archivosFinales.filter(f => !f.startsWith('SAC_')),
    pdfsSAC:        archivosFinales.filter(f => f.startsWith('SAC_') && f.endsWith('.pdf')),
    totalArchivos:  archivosFinales.length,
    errorPuppeteer: resultadoPuppeteer.success ? undefined : resultadoPuppeteer.error,
  }));
}

main().catch(err => {
  console.log(JSON.stringify({ success: false, error: err.message }));
  process.exit(1);
});
