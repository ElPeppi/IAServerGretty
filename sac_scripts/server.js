/**
 * server.js — SAC Processor HTTP Server
 *
 * Recibe ZIPs desde n8n, extrae la cédula, organiza archivos
 * y lanza Puppeteer para automatizar el SAC.
 *
 * Inicio:  node server.js
 * Puerto:  http://localhost:3456
 *
 * Variables de entorno opcionales:
 *   SAC_PORT     (default: 3456)
 *   SAC_TEMP_DIR (default: C:/temp/sac_temp)
 *   SAC_OUT_DIR  (default: C:/SAC_Documentos)
 *   SAC_URL      (default: https://servicios.bancofinandina.com/Sac)
 *   SAC_USER     (default: jairramo)
 *   SAC_PASS     ← OBLIGATORIO si no se envía por el body
 */

require('dotenv').config();

const express      = require('express');
const multer       = require('multer');
const AdmZip       = require('adm-zip');
const pdfParse     = require('pdf-parse');
const path         = require('path');
const fs           = require('fs');
const { execFile, spawn } = require('child_process');
const { procesarSingular } = require('./singular_processor');

// ─── Cola Puppeteer (una sesión SAC a la vez) ─────────────────────────────────
// execFile es NO bloqueante → el servidor puede recibir todos los ZIPs
// simultáneamente. La cola garantiza que Chromium corre de a uno para
// evitar conflictos de sesión en el SAC y no saturar la RAM.
class SacQueue {
  constructor() { this._chain = Promise.resolve(); this.size = 0; }
  run(task) {
    this.size++;
    return new Promise((resolve, reject) => {
      // Cada tarea se encadena; la cadena nunca se rompe aunque falle una tarea
      this._chain = this._chain.then(
        () => task().then(
          v => { this.size--; resolve(v); },
          e => { this.size--; reject(e); }
        )
      );
    });
  }
}
const sacQueue = new SacQueue();

// ─── Job Store (procesamiento async) ─────────────────────────────────────────
// Guarda el estado de cada job de /procesar-zips.
// El cliente (n8n) hace polling a GET /job-status/:id hasta que status == 'done'|'failed'.
const jobStore = new Map();

// Limpia jobs con más de 4 horas cada 30 min para no acumular memoria
setInterval(() => {
  const cutoff = Date.now() - 4 * 60 * 60 * 1000;
  for (const [id, job] of jobStore) {
    if ((job.createdAt || 0) < cutoff) jobStore.delete(id);
  }
}, 30 * 60 * 1000);

// ─── Configuración ────────────────────────────────────────────────────────────
const PORT     = process.env.SAC_PORT     || 3456;
const TEMP_DIR = process.env.SAC_TEMP_DIR || 'C:/temp/sac_temp';
const OUT_DIR  = process.env.SAC_OUT_DIR
  || '\\\\10.0.10.10\\compartida\\DOCUMENTOS ACTUALIZADOS 2019\\DEMANDAS\\FINANDINA\\EJECUTIVAS SINGULARES\\GARANTIAS';
const SAC_URL  = process.env.SAC_URL      || 'https://servicios.bancofinandina.com/Sac';
const SAC_USER = process.env.SAC_USER     || 'jairramo';
const SAC_PASS = process.env.SAC_PASS     || '';

fs.mkdirSync(TEMP_DIR, { recursive: true });

// ─── Resolución de carpeta por cédula ────────────────────────────────────────
// Al ESCRIBIR (procesar ZIP nuevo): si ya existe {cedula}, usa {cedula}_{año}.
// Así los documentos de un nuevo año no mezclan con los anteriores.
function resolverCarpetaEscritura(outBase, cedula) {
  const normal  = path.join(outBase, String(cedula));
  if (!fs.existsSync(normal)) return normal;
  // Ya existe → añadir el año actual
  return path.join(outBase, `${cedula}_${new Date().getFullYear()}`);
}

// Al LEER (generar Plantilla Singular): busca la carpeta más reciente que exista.
// Orden: {cedula}_{año} > {cedula}
function resolverCarpetaLectura(outBase, cedula) {
  const conAnio = path.join(outBase, `${cedula}_${new Date().getFullYear()}`);
  const normal  = path.join(outBase, String(cedula));
  if (fs.existsSync(conAnio)) return conAnio;
  return normal; // puede no existir; cada función lo maneja con existsSync
}

const app    = express();
const upload = multer({ dest: TEMP_DIR });

// CORS — permite llamadas desde file:// y cualquier origen local (test_singular.html)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Permite recibir JSON grande (base64 de varios ZIPs)
app.use(express.json({ limit: '100mb' }));

// ─── Patrones cédula colombiana ───────────────────────────────────────────────
const CEDULA_DATACREDITO_RE    = /N[uú]mero\s+Documento\s+(\d{6,11})/i;
const CEDULA_CC_RE             = /C\.?\s*C\.?[\s\S]{0,80}?(\d{6,11})/;
const CEDULA_TEXTO_RE          = /[Cc][eé]dula\s*(?:de\s*[Cc]iudadan[ií]a)?\s*[:#Nn°\.]?\s*(\d{6,11})/i;
const CEDULA_SOLO_RE           = /\b(\d{6,11})\b/;
const CEDULA_NUM_DOC_RE        = /N[uú]mero\s+(?:de\s+)?[Dd]ocumento\s*[:\-]?\s*(\d{6,12})/i;
const CEDULA_IDENTIFICACION_RE = /[Ii]dentificaci[oó]n\s*[:\-]?\s*(\d{6,12})/i;

function limpiarNumero(str) { return str.replace(/[\s.]/g, ''); }

// ─── Extrae contraseña del cuerpo del correo ──────────────────────────────────
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

// ─── Extrae cédula de los PDFs del ZIP (con soporte de contraseña) ────────────
async function extraerCedulaDePDFs(zip, zipFileName, password) {
  const entries    = zip.getEntries();
  const pdfEntries = entries.filter(e => e.entryName.toLowerCase().endsWith('.pdf') && !e.isDirectory);

  console.log(`[DEBUG] ZIP "${zipFileName || '?'}": ${entries.length} entradas, ${pdfEntries.length} PDFs${password ? ' [cifrado]' : ''}`);
  pdfEntries.forEach(e => console.log(`[DEBUG]   PDF: ${e.entryName} (${e.header.size} bytes)`));

  // Intento 1: texto dentro de cada PDF (descifrando con la contraseña si aplica)
  for (const entry of pdfEntries) {
    try {
      const buffer = password ? entry.getData(password) : entry.getData();
      console.log(`[DEBUG]   Parseando PDF: ${entry.entryName} (${buffer.length} bytes)`);
      const parsed = await pdfParse(buffer, { max: 5 });
      const texto  = (parsed.text || '').replace(/\s+/g, ' ').trim();
      console.log(`[DEBUG]   Texto PDF (300 chars): ${texto.slice(0, 300)}`);

      const mND = texto.match(CEDULA_NUM_DOC_RE);        if (mND) { console.log(`[DEBUG]   Cédula NUM_DOC: ${mND[1]}`);        return limpiarNumero(mND[1]); }
      const mDC = texto.match(CEDULA_DATACREDITO_RE);    if (mDC) { console.log(`[DEBUG]   Cédula DATACREDITO: ${mDC[1]}`);    return limpiarNumero(mDC[1]); }
      const mID = texto.match(CEDULA_IDENTIFICACION_RE); if (mID) { console.log(`[DEBUG]   Cédula IDENTIFICACION: ${mID[1]}`); return limpiarNumero(mID[1]); }
      const mCC = texto.match(CEDULA_CC_RE);              if (mCC) { console.log(`[DEBUG]   Cédula CC: ${mCC[1]}`);             return limpiarNumero(mCC[1]); }
      const mTx = texto.match(CEDULA_TEXTO_RE);           if (mTx) { console.log(`[DEBUG]   Cédula TEXTO: ${mTx[1]}`);          return limpiarNumero(mTx[1]); }
      const mS  = texto.match(CEDULA_SOLO_RE);            if (mS)  { console.log(`[DEBUG]   Cédula SOLO: ${mS[1]}`);            return mS[1]; }
      console.log(`[DEBUG]   Sin cédula en texto del PDF`);
    } catch (e) {
      // Si falla con password, intentar sin contraseña (ZIP no cifrado)
      if (password) {
        try {
          const buffer = entry.getData();
          const parsed = await pdfParse(buffer, { max: 5 });
          const texto  = (parsed.text || '').replace(/\s+/g, ' ').trim();
          const mS = texto.match(CEDULA_SOLO_RE);
          if (mS) { console.log(`[DEBUG]   Cédula (sin pwd): ${mS[1]}`); return mS[1]; }
        } catch (_) {}
      }
      console.warn(`[DEBUG]   pdfParse ERROR ${entry.entryName}: ${e.message}`);
    }
  }

  // Intento 2: nombre del PDF dentro del ZIP
  for (const entry of pdfEntries) {
    const nombre = path.basename(entry.entryName, '.pdf');
    const m = nombre.match(/\b(\d{6,12})\b/);
    if (m) { console.log(`[DEBUG]   Cédula del nombre PDF: ${m[1]}`); return m[1]; }
  }

  // Intento 3: nombre del archivo ZIP
  if (zipFileName) {
    const baseName = path.basename(zipFileName, '.zip');
    const m = baseName.match(/\b(\d{6,12})\b/);
    if (m) { console.log(`[DEBUG]   Cédula del nombre ZIP: ${m[1]}`); return m[1]; }
  }

  return null;
}

// ─── POST /procesar-zip ───────────────────────────────────────────────────────
app.post('/procesar-zip', upload.single('zipFile'), async (req, res) => {
  const zipPath     = req.file?.path;
  const zipFileName = req.file?.originalname || req.body.zipFileName || 'adjunto.zip';

  const sacUrl  = req.body.sacBaseUrl    || SAC_URL;
  const sacUser = req.body.sacUser       || SAC_USER;
  const sacPass = req.body.sacPass       || SAC_PASS;
  const outBase = req.body.outputBaseDir || OUT_DIR;

  if (!zipPath) {
    return res.status(400).json({ success: false, error: 'No se recibió archivo ZIP (campo: zipFile)' });
  }

  try {
    const zip    = new AdmZip(zipPath);
    const cedula = await extraerCedulaDePDFs(zip, zipFileName);

    if (!cedula) {
      fs.unlinkSync(zipPath);
      return res.json({
        success: false,
        error: `No se encontró cédula en los PDFs del ZIP: ${zipFileName}`,
        sugerencia: 'Los PDFs deben contener texto seleccionable con el número de C.C.',
      });
    }

    // Crear carpeta: si ya existe {cedula} usa {cedula}_{año}
    const carpetaSalida = resolverCarpetaEscritura(outBase, cedula);
    fs.mkdirSync(carpetaSalida, { recursive: true });
    zip.extractAllTo(carpetaSalida, true);
    fs.unlinkSync(zipPath);

    // Lanzar sac_puppeteer.js para automatizar el SAC
    // execFile (async) + cola → el servidor no bloquea y procesa ZIPs de a uno
    const scriptPuppeteer = path.join(__dirname, 'sac_puppeteer.js');
    const posEnCola = sacQueue.size + 1;
    console.log(`[${new Date().toISOString()}] ZIP encolado para cédula ${cedula} (posición en cola: ${posEnCola})`);

    let resultadoPuppeteer;
    try {
      const stdout = await sacQueue.run(() => new Promise((resolve, reject) => {
        console.log(`[${new Date().toISOString()}] Iniciando Puppeteer para cédula ${cedula}...`);
        execFile(
          process.execPath,
          [scriptPuppeteer, cedula, carpetaSalida, sacUrl, sacUser, sacPass],
          { timeout: 300000, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
          (err, stdout, stderr) => {
            if (err) reject({ err, stdout: stdout || '', stderr: stderr || '' });
            else     resolve(stdout || '');
          }
        );
      }));

      const lineas = stdout.trim().split('\n').filter(l => l.trim().startsWith('{'));
      resultadoPuppeteer = JSON.parse(lineas[lineas.length - 1]);
      console.log(`[${new Date().toISOString()}] Puppeteer OK para cédula ${cedula}`);

    } catch (e) {
      // execFile rechaza con { err, stdout, stderr } si el proceso termina con código ≠ 0
      const stdoutData = (e.stdout || '').toString();
      const lineas = stdoutData.trim().split('\n').filter(l => l.trim().startsWith('{'));
      if (lineas.length > 0) {
        try { resultadoPuppeteer = JSON.parse(lineas[lineas.length - 1]); } catch (_) {}
      }
      if (!resultadoPuppeteer) {
        const detalle = (e.stderr || e.err?.message || e.message || '').toString()
          .replace(/\x1B\[[0-9;]*m/g, '')
          .slice(0, 800);
        resultadoPuppeteer = { success: false, error: detalle, cedula };
      }
      console.error(`[${new Date().toISOString()}] Puppeteer ERROR para cédula ${cedula}:`, resultadoPuppeteer.error?.slice(0, 200));
    }

    const archivosFinales = fs.readdirSync(carpetaSalida);

    return res.json({
      success:        resultadoPuppeteer.success,
      cedula,
      carpetaSalida,
      archivosZip:    archivosFinales.filter(f => !f.startsWith('SAC_')),
      pdfsSAC:        archivosFinales.filter(f => f.startsWith('SAC_') && f.endsWith('.pdf')),
      totalArchivos:  archivosFinales.length,
      errorPuppeteer: resultadoPuppeteer.success ? undefined : resultadoPuppeteer.error,
    });

  } catch (err) {
    if (zipPath && fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /job-status/:jobId ───────────────────────────────────────────────────
// n8n hace polling aquí cada 60 s hasta que status === 'done' | 'failed'.
app.get('/job-status/:jobId', (req, res) => {
  const job = jobStore.get(req.params.jobId);
  if (!job) return res.status(404).json({ status: 'not_found', error: 'Job no encontrado' });
  return res.json(job);
});

// ─── Helpers internos para /procesar-zips ────────────────────────────────────

// Extrae entrada por entrada con soporte de contraseña ZIP
function extraerZipADirectorio(zip, destDir, password) {
  for (const entry of zip.getEntries()) {
    const entryPath = path.join(destDir, entry.entryName);
    if (entry.isDirectory) {
      fs.mkdirSync(entryPath, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(entryPath), { recursive: true });
      try {
        const data = password ? entry.getData(password) : entry.getData();
        fs.writeFileSync(entryPath, data);
      } catch (_) {
        // Si falla con pwd, intentar sin (algunos entries no cifrados)
        try { fs.writeFileSync(entryPath, entry.getData()); } catch (e2) {
          console.warn(`[WARN] No se pudo extraer ${entry.entryName}: ${e2.message}`);
        }
      }
    }
  }
}

// Extrae cédulas y descomprime ZIPs; devuelve { clientes, erroresExtraccion }
async function extraerClientesDeZips(zipsBase64, outBase, password) {
  const clientes = [], errores = [];
  for (let i = 0; i < zipsBase64.length; i++) {
    const item     = zipsBase64[i] || {};
    const data     = item.data     || '';
    const fileName = item.fileName || `adjunto_${i}.zip`;

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
      const cedula = await extraerCedulaDePDFs(zip, fileName, password);
      if (!cedula) {
        const msg = `No se encontró cédula (${zip.getEntries().length} entradas)`;
        errores.push({ fileName, error: msg });
        console.warn(`[WARN] ZIP ${fileName}: ${msg}`);
        continue;
      }

      const carpetaSalida = resolverCarpetaEscritura(outBase, cedula);
      fs.mkdirSync(carpetaSalida, { recursive: true });
      extraerZipADirectorio(zip, carpetaSalida, password);

      clientes.push({ cedula, outputDir: carpetaSalida, fileName });
      console.log(`[${new Date().toISOString()}] ✓ ${cedula} ← ${fileName}`);
    } catch (e) {
      errores.push({ fileName, error: e.message });
      console.error(`[${new Date().toISOString()}] ✗ "${fileName}": ${e.message}`);
    }
  }
  return { clientes, erroresExtraccion: errores };
}

// Enriquece resultados de Puppeteer con archivos reales en carpeta
function enriquecerClientes(clientesPuppeteer, clientesMeta, outBase) {
  return (clientesPuppeteer || []).map(c => {
    const info    = clientesMeta.find(ci => ci.cedula === c.cedula) || {};
    const carpeta = info.outputDir || resolverCarpetaLectura(outBase, c.cedula);
    let archivos  = [];
    try { archivos = fs.readdirSync(carpeta); } catch (_) {}
    return {
      ...c,
      carpetaSalida: carpeta,
      archivosZip:   archivos.filter(f => !f.startsWith('SAC_') && !f.startsWith('CONTACTOS_')),
      pdfsSAC:       archivos.filter(f => f.startsWith('SAC_') && f.endsWith('.pdf')),
      contactosCsv:  archivos.find(f => f.startsWith('CONTACTOS_') && f.endsWith('.csv')) || null,
    };
  });
}

// Corre sac_puppeteer.js y parsea su salida JSON
async function correrPuppeteer(clientes, sacUrl, sacUser, sacPass) {
  const scriptPuppeteer = path.join(__dirname, 'sac_puppeteer.js');
  // Procesamiento secuencial: ~6 min por cliente con margen extra
  const timeoutMs  = clientes.length * 360000;
  const cedulasStr = clientes.map(c => c.cedula).join(', ');
  console.log(`[${new Date().toISOString()}] Puppeteer: ${clientes.length} cédula(s) secuencial: ${cedulasStr}`);

  const clientesArg = JSON.stringify(clientes.map(c => ({ cedula: c.cedula, outputDir: c.outputDir })));
  const env = { ...process.env };

  // Usar spawn (no execFile) para ver los logs de Puppeteer en tiempo real
  // NOTA: correrPuppeteer ya es llamado desde dentro de sacQueue.run() en el handler;
  //       NO wrappear con sacQueue.run() aquí — causaría deadlock (inner espera outer, outer espera inner).
  const stdout = await new Promise((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      [scriptPuppeteer, clientesArg, sacUrl, sacUser, sacPass],
      { env, windowsHide: true }
    );

    let stdoutData = '', stderrData = '';

    proc.stdout.on('data', chunk => { stdoutData += chunk.toString(); });

    // Streaming en tiempo real de stderr → logs visibles mientras corre Puppeteer
    proc.stderr.on('data', chunk => {
      const str = chunk.toString();
      stderrData += str;
      str.split('\n').forEach(l => {
        const t = l.trim();
        if (t && /^\[(OK|ERR|BATCH|INFO|AUTH|TAB|DIR|CONTACTOS|PDF|PDF-ERR|WARN)\]/.test(t)) {
          console.log(`[Puppeteer] ${t}`);
        }
      });
    });

    // Timeout manual (spawn no tiene opción timeout)
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject({ err: new Error(`Timeout ${timeoutMs}ms`), stdout: stdoutData, stderr: stderrData });
    }, timeoutMs);

    proc.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 && !stdoutData.trim().startsWith('{')) {
        reject({ err: new Error(`Proceso salió con código ${code}`), stdout: stdoutData, stderr: stderrData });
      } else {
        resolve(stdoutData);
      }
    });

    proc.on('error', err => { clearTimeout(timer); reject({ err, stdout: stdoutData, stderr: stderrData }); });
  });

  const lineas = stdout.trim().split('\n').filter(l => l.trim().startsWith('{'));
  const resultado = JSON.parse(lineas[lineas.length - 1]);
  (resultado.clientes || []).forEach(c => {
    if (c.success) console.log(`[${new Date().toISOString()}] ✓ ${c.cedula}: ${(c.pdfs||[]).length} PDF(s)`);
    else           console.log(`[${new Date().toISOString()}] ✗ ${c.cedula}: ${c.error}`);
  });
  return resultado;
}

// ─── POST /procesar-zips (batch, SÍNCRONO) ───────────────────────────────────
// Espera a que Puppeteer termine y responde con { success, clientes }.
// n8n tiene timeout de 20 min (1 200 000 ms) — suficiente para lotes normales.
app.post('/procesar-zips', async (req, res) => {
  const {
    zipsBase64, emailFrom, emailSubject,
    emailBodyText,            // ← cuerpo del correo para extraer contraseña
    zipPassword: reqZipPwd,   // ← contraseña ya extraída (opcional)
    sacBaseUrl: reqUrl, sacUser: reqUser, sacPass: reqPass,
    outputBaseDir,
  } = req.body;

  const sacUrl  = reqUrl  || SAC_URL;
  const sacUser = reqUser || SAC_USER;
  const sacPass = reqPass || SAC_PASS;
  const outBase = outputBaseDir || OUT_DIR;

  // Determinar contraseña del ZIP: campo explícito → extraer del cuerpo → sin contraseña
  const zipPassword = reqZipPwd || extraerPasswordDelCorreo(emailBodyText) || null;
  if (zipPassword) {
    console.log(`[${new Date().toISOString()}] Contraseña ZIP detectada: "${zipPassword}"`);
  } else {
    console.log(`[${new Date().toISOString()}] Sin contraseña ZIP (ZIPs no cifrados o contraseña no encontrada)`);
  }

  if (!Array.isArray(zipsBase64) || !zipsBase64.length) {
    return res.status(400).json({ success: false, error: 'zipsBase64 debe ser un array no vacío' });
  }

  console.log(`[${new Date().toISOString()}] /procesar-zips: ${zipsBase64.length} ZIPs recibidos`);

  try {
    const resultado = await sacQueue.run(async () => {
      // 1. Extraer cédulas y descomprimir ZIPs (con contraseña si aplica)
      const { clientes, erroresExtraccion } = await extraerClientesDeZips(zipsBase64, outBase, zipPassword);

      if (clientes.length === 0) {
        console.error(`[${new Date().toISOString()}] 0 clientes extraídos. Errores de extracción:`);
        erroresExtraccion.forEach((e, i) => console.error(`  [${i+1}] ${e.fileName}: ${e.error}`));
        return {
          success: false,
          error: 'Ningún ZIP tenía cédula válida',
          erroresExtraccion,
          clientes: [],
        };
      }

      // 2. Correr Puppeteer secuencialmente
      let resultadoPuppeteer;
      try {
        resultadoPuppeteer = await correrPuppeteer(clientes, sacUrl, sacUser, sacPass);
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

    console.log(`[${new Date().toISOString()}] /procesar-zips completado: ${resultado.clientes?.length ?? 0} cliente(s)`);
    res.json(resultado);

  } catch (e) {
    console.error(`[${new Date().toISOString()}] /procesar-zips error: ${e.message}`);
    res.json({ success: false, error: e.message, clientes: [] });
  }
});

// ─── POST /generar-singular ───────────────────────────────────────────────────
// Recibe un Excel de entrada (campo: excelFile), filtra DECEVAL, llena la
// Plantilla Singular y devuelve JSON con base64 del Excel resultante.
//
// Body (multipart/form-data):
//   excelFile        – archivo Excel obligatorio
//   plantillaPath?   – ruta server-side de la plantilla (default: SAC_OUT_DIR/PLANTILLA SINGULAR GRETTY.xlsx)
//   fechaAsignacion? – DD/MM/YYYY (default: hoy)
//
app.post('/generar-singular', upload.single('excelFile'), async (req, res) => {
  const tmpPath = req.file?.path;

  if (!tmpPath) {
    return res.status(400).json({ success: false, error: 'No se recibió el archivo Excel (campo: excelFile)' });
  }

  try {
    const excelBuffer   = fs.readFileSync(tmpPath);
    fs.unlinkSync(tmpPath);  // limpiar temp inmediatamente

    const plantillaPath   = req.body.plantillaPath   || undefined;
    const fechaAsignacion = req.body.fechaAsignacion || undefined;

    console.log(`[${new Date().toISOString()}] /generar-singular: procesando Excel...`);

    const result = await procesarSingular(excelBuffer, {
      sacDocsDir:    OUT_DIR,
      plantillaPath,
      fechaAsignacion,
    });

    if (!result.success || !result.xlsxBuffer) {
      return res.status(result.error ? 422 : 500).json({
        success:  false,
        error:    result.error || 'Error desconocido',
        clientes: result.clientes || [],
        errores:  result.errores  || [],
      });
    }

    console.log(`[${new Date().toISOString()}] /generar-singular: OK — ${result.totalFilas} fila(s)`);

    // Devolver JSON con base64 para fácil consumo desde n8n
    return res.json({
      success:    true,
      totalFilas: result.totalFilas,
      clientes:   result.clientes,
      errores:    result.errores,
      xlsxBase64: result.xlsxBuffer.toString('base64'),
    });

  } catch (err) {
    if (tmpPath && fs.existsSync(tmpPath)) { try { fs.unlinkSync(tmpPath); } catch (_) {} }
    console.error(`[${new Date().toISOString()}] /generar-singular ERROR: ${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /health ──────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', port: PORT, outDir: OUT_DIR }));

app.listen(PORT, () => {
  console.log(`SAC Processor Server corriendo en http://localhost:${PORT}`);
  console.log(`  Carpeta salida : ${OUT_DIR}`);
  console.log(`  SAC URL        : ${SAC_URL}`);
  console.log(`  SAC usuario    : ${SAC_USER}`);
});
