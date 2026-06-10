/**
 * services/zips.js — Flujo completo de procesamiento de ZIPs
 *
 *   extraerPasswordDelCorreo → contraseña del ZIP desde el cuerpo del email
 *   extraerClientesDeZips    → decodifica, extrae cédula y descomprime cada ZIP
 *   procesarLoteZips         → orquestación completa: extracción + Puppeteer + enriquecido
 *
 * Internos: extracción adm-zip con fallback PowerShell y renombrado de pagarés.
 */

'use strict';

const path     = require('path');
const fs       = require('fs');
const AdmZip   = require('adm-zip');
const pdfParse = require('pdf-parse');
const { execFileSync } = require('child_process');

const config   = require('../config');
const sacQueue = require('./colaSac');
const { extraerCedulaDePDFs } = require('./cedulas');
const { correrPuppeteerLote, enriquecerClientes } = require('./puppeteerRunner');
const { mkdirpSync, resolverCarpetaEscritura } = require('../utils/carpetas');

// ─── Contraseña del ZIP desde el cuerpo del correo ────────────────────────────
// Busca patrones como "Clave de ingreso: Jairoenriqueramoslazaro"
const PASSWORD_PATTERNS = [
  /[Cc]lave\s+de\s+ingreso\s*:\s*(\S+)/,
  /[Cc]ontraseña\s+de\s+ingreso\s*:\s*(\S+)/,
  /[Cc]ontraseña\s*:\s*(\S+)/,
  /[Cc]lave\s+del?\s+(?:archivo|zip|documento)\s*:\s*(\S+)/i,
  /[Cc]lave\s*:\s*(\S+)/,
  /[Pp]assword\s*:\s*(\S+)/,
  /[Pp]in\s*:\s*(\S+)/,
  /[Cc][oó]digo\s+de\s+acceso\s*:\s*(\S+)/i,
];

function extraerPasswordDelCorreo(bodyText) {
  if (!bodyText) return null;
  // Limpiar etiquetas HTML si las hay
  const texto = bodyText.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
  for (const re of PASSWORD_PATTERNS) {
    const m = texto.match(re);
    if (m && m[1] && m[1].length >= 4) {
      const pwd = m[1].trim().replace(/[.,;:!?]$/, ''); // quitar puntuación final
      console.log(`[INFO] Contraseña extraída del correo: "${pwd}"`);
      return pwd;
    }
  }
  return null;
}

// ─── Extracción de archivos del ZIP ───────────────────────────────────────────

// Extrae entrada por entrada con soporte de contraseña ZIP.
// Devuelve el número de archivos extraídos con éxito.
function extraerZipADirectorio(zip, destDir, password) {
  let extraidos = 0;
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) {
      mkdirpSync(path.join(destDir, entry.entryName));
      continue;
    }
    // Aplanar la ruta: ignorar subdirectorios dentro del ZIP
    const nombre    = path.basename(entry.entryName);
    const destFile  = path.join(destDir, nombre);
    try {
      const data = password ? entry.getData(password) : entry.getData();
      fs.writeFileSync(destFile, data);
      extraidos++;
    } catch (_) {
      // Si falla con pwd, intentar sin (algunos entries no cifrados)
      try {
        fs.writeFileSync(destFile, entry.getData());
        extraidos++;
      } catch (e2) {
        console.warn(`[WARN] No se pudo extraer ${nombre}: ${e2.message}`);
      }
    }
  }
  return extraidos;
}

// Fallback de extracción usando PowerShell (Expand-Archive).
// Se usa cuando adm-zip no puede leer el ZIP (formato no estándar, AES, etc.).
// Guarda el buffer en un archivo temporal, extrae con PowerShell y borra el temp.
function extraerConPowerShell(zipBuffer, fileName, destDir) {
  const tempZip = path.join(config.TEMP_DIR, `tmp_${Date.now()}_${path.basename(fileName)}`);
  try {
    fs.writeFileSync(tempZip, zipBuffer);
    // Expand-Archive aplana la estructura si hay subcarpetas → extraemos a destDir directamente
    execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${tempZip.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
    ], { timeout: 60000 });
    const archivos = fs.readdirSync(destDir).filter(f => !f.startsWith('SAC_') && !f.startsWith('CONTACTOS_'));
    console.log(`[ZIP-PS] Extraído con PowerShell: ${archivos.length} archivo(s) → ${path.basename(destDir)}`);
    return archivos.length;
  } catch (e) {
    console.warn(`[WARN] PowerShell extraction falló: ${e.message.slice(0, 200)}`);
    return 0;
  } finally {
    try { if (fs.existsSync(tempZip)) fs.unlinkSync(tempZip); } catch (_) {}
  }
}

// ─── Renombrado de pagarés con nombre raro ────────────────────────────────────
// Regla: si el PDF contiene texto de pagaré pero su nombre NO tiene "PAGARE"/"PAGARÉ",
//        se renombra a "{NOMBRE} PAGARE.pdf" usando el nombre del cliente.
async function renombrarPagarePDFs(cedula, outputDir) {
  let pdfs;
  try { pdfs = fs.readdirSync(outputDir).filter(f => f.toLowerCase().endsWith('.pdf') && !f.startsWith('SAC_')); }
  catch (_) { return; }

  for (const archivo of pdfs) {
    // Saltar los que ya tienen PAGARE en el nombre
    if (/PAGARE|PAGAR[EÉ]/i.test(archivo)) continue;

    const fullPath = path.join(outputDir, archivo);
    try {
      const buf    = fs.readFileSync(fullPath);
      const parsed = await pdfParse(buf, { max: 3 });
      const texto  = (parsed.text || '').replace(/\s+/g, ' ');

      // ¿Contiene texto típico de un pagaré?
      const esPagare = /DATOS\s+BASICOS\s+DEL\s+PAGARE|SUSCRIPTORES\s+DEL\s+PAGARE|No\.\s*PAGARE|PAGAR[EÉ]\s+No\./i.test(texto);
      if (!esPagare) continue;

      // Inferir nombre del cliente desde otro archivo del folder (DATACREDITO/DECEVAL)
      const refFile = fs.readdirSync(outputDir).find(f =>
        /DATACREDITO|DECEVAL/i.test(f) && f.toLowerCase().endsWith('.pdf')
      );
      let nombre = '';
      if (refFile) {
        nombre = refFile.replace(/\s*(DATACREDITO|DECEVAL)\.pdf$/i, '').trim();
      } else {
        // Extraer nombre del texto del propio pagaré (OTORGANTE)
        const m = texto.match(/OTORGANTE\s+([A-ZÁÉÍÓÚÑÜ][A-ZÁÉÍÓÚÑÜ ]{4,50}?)(?=\s{2,}|\bCC\b|\bNIT\b|\d)/);
        nombre = m ? m[1].trim() : String(cedula);
      }

      const nuevoNombre = `${nombre} PAGARE.pdf`;
      const nuevaRuta   = path.join(outputDir, nuevoNombre);
      if (!fs.existsSync(nuevaRuta)) {
        fs.renameSync(fullPath, nuevaRuta);
        console.log(`[ZIP] Renombrado pagaré: "${archivo}" → "${nuevoNombre}"`);
      }
    } catch (e) {
      console.warn(`[WARN] renombrarPagarePDFs ${archivo}: ${e.message.slice(0, 100)}`);
    }
  }
}

// ─── Extrae cédulas y descomprime ZIPs ────────────────────────────────────────
// Devuelve { clientes, erroresExtraccion }
async function extraerClientesDeZips(zipsBase64, outBase, password) {
  const clientes = [], errores = [];
  for (let i = 0; i < zipsBase64.length; i++) {
    const item     = zipsBase64[i] || {};
    const data     = item.data     || '';
    const fileName = item.fileName || `adjunto_${i}.zip`;
    // Cédula explícita enviada por n8n (evita tener que extraerla del PDF)
    const cedulaExplicita = item.cedula ? String(item.cedula).trim().replace(/\D/g, '') : null;

    console.log(`[${new Date().toISOString()}] ZIP ${i + 1}/${zipsBase64.length}: "${fileName}" data.length=${data.length}${password ? ' [pwd: sí]' : ''}`);

    if (!data) {
      const msg = 'Campo "data" vacío o faltante';
      errores.push({ fileName, error: msg });
      console.error(`[ERR] ZIP ${fileName}: ${msg}`);
      continue;
    }

    try {
      const buffer = Buffer.from(data, 'base64');
      console.log(`[DEBUG] ZIP ${fileName}: buffer decodificado = ${buffer.length} bytes`);

      if (buffer.length < 22) {
        throw new Error(`Buffer demasiado pequeño (${buffer.length} bytes) — base64 inválido`);
      }

      const zip    = new AdmZip(buffer);
      const cedula = cedulaExplicita || await extraerCedulaDePDFs(zip, fileName, password);
      if (!cedula) {
        const msg = `No se encontró cédula (${zip.getEntries().length} entradas)`;
        errores.push({ fileName, error: msg });
        console.warn(`[WARN] ZIP ${fileName}: ${msg}`);
        continue;
      }
      if (cedulaExplicita) console.log(`[${new Date().toISOString()}] Cédula explícita: ${cedula} ← ${fileName}`);

      const carpetaSalida = resolverCarpetaEscritura(outBase, cedula);
      mkdirpSync(carpetaSalida);

      // Extraer archivos del ZIP a la carpeta de salida
      let extraidos = extraerZipADirectorio(zip, carpetaSalida, password);
      if (extraidos > 0) {
        console.log(`[${new Date().toISOString()}] ✓ ${cedula}: ${extraidos} archivo(s) extraídos (adm-zip)`);
      } else {
        // adm-zip no pudo leer el ZIP (formato no estándar, AES, etc.)
        // → fallback a PowerShell que soporta cualquier ZIP nativo de Windows
        console.warn(`[WARN] ${cedula}: adm-zip falló, intentando con PowerShell...`);
        extraidos = extraerConPowerShell(buffer, fileName, carpetaSalida);
        if (extraidos === 0) {
          console.warn(`[WARN] ${cedula}: no se pudieron extraer los archivos del ZIP`);
        }
      }

      // Renombrar pagarés con nombres raros a "{NOMBRE} PAGARE.pdf"
      await renombrarPagarePDFs(cedula, carpetaSalida);

      clientes.push({ cedula, outputDir: carpetaSalida, fileName });
      console.log(`[${new Date().toISOString()}] ✓ ${cedula} ← ${fileName}`);
    } catch (e) {
      errores.push({ fileName, error: e.message });
      console.error(`[${new Date().toISOString()}] ✗ "${fileName}": ${e.message}`);
    }
  }
  return { clientes, erroresExtraccion: errores };
}

// ─── Orquestación completa del lote (usado por POST /procesar-zips) ──────────
// Encola TODO el flujo en la cola SAC: extracción + Puppeteer + enriquecido.
async function procesarLoteZips({ zipsBase64, outBase, zipPassword, sacUrl, sacUser, sacPass }) {
  return sacQueue.run(async () => {
    // 1. Extraer cédulas y descomprimir ZIPs (con contraseña si aplica)
    const { clientes, erroresExtraccion } = await extraerClientesDeZips(zipsBase64, outBase, zipPassword);

    if (clientes.length === 0) {
      console.error(`[${new Date().toISOString()}] 0 clientes extraídos. Errores de extracción:`);
      erroresExtraccion.forEach((e, i) => console.error(`  [${i+1}] ${e.fileName}: ${e.error}`));
      // Mensaje más descriptivo: distinguir "sin cédula" de "carpeta inaccesible"
      const msgError = erroresExtraccion.some(e => /mkdir|UNKNOWN|EPERM|EACCES/i.test(e.error))
        ? `Error de acceso a carpeta de salida: ${outBase} — verifique que la red sea accesible`
        : 'Ningún ZIP tenía cédula válida';
      return {
        success: false,
        error: msgError,
        erroresExtraccion,
        clientes: [],
      };
    }

    // 2. Correr Puppeteer secuencialmente
    let resultadoPuppeteer;
    try {
      resultadoPuppeteer = await correrPuppeteerLote(clientes, sacUrl, sacUser, sacPass);
    } catch (e) {
      const stdoutData = (e.stdout || '').toString();
      const lineas = stdoutData.trim().split('\n').filter(l => l.trim().startsWith('{'));
      if (lineas.length > 0) {
        try { resultadoPuppeteer = JSON.parse(lineas[lineas.length - 1]); } catch (_) {}
      }
      if (!resultadoPuppeteer) {
        const detalle = (e.stderr || e.err?.message || e.message || '').toString()
          .replace(/\x1B\[[0-9;]*m/g, '').slice(0, 800);
        resultadoPuppeteer = { success: false, error: detalle, clientes: [] };
      }
    }

    // 3. Enriquecer con archivos en disco
    const clientesResultado = enriquecerClientes(resultadoPuppeteer.clientes, clientes, outBase);

    return {
      success:           resultadoPuppeteer.success,
      clientes:          clientesResultado,
      erroresExtraccion: erroresExtraccion.length ? erroresExtraccion : undefined,
      errorPuppeteer:    resultadoPuppeteer.success ? undefined : resultadoPuppeteer.error,
    };
  });
}

module.exports = {
  extraerPasswordDelCorreo,
  extraerClientesDeZips,
  procesarLoteZips,
};
