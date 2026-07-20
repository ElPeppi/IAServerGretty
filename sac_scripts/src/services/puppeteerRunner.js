/**
 * services/puppeteerRunner.js — Ejecución del worker sac_puppeteer.js
 *
 * El worker corre como proceso hijo de Node (un Chromium por ejecución).
 * Toda ejecución pasa por la cola SAC para garantizar una sesión a la vez.
 *
 *   correrPuppeteerLote   → N clientes en una sola sesión (un login, N búsquedas)
 *   correrPuppeteerCedula → un solo cliente (endpoint /procesar-zip)
 *   enriquecerClientes    → agrega archivos reales en disco al resultado
 */

'use strict';

const fs   = require('fs');
const { execFile, spawn } = require('child_process');

const config   = require('../config');
const sacQueue = require('./colaSac');
const { resolverCarpetaLectura } = require('../utils/carpetas');

// ─── Lote: N clientes en una sesión (usado por /procesar-zips) ────────────────
// IMPORTANTE: esta función se llama desde DENTRO de sacQueue.run() en el flujo
// de ZIPs; NO wrappear con sacQueue.run() aquí — causaría deadlock
// (inner espera outer, outer espera inner).
async function correrPuppeteerLote(clientes, sacUrl, sacUser, sacPass) {
  // Procesamiento secuencial: ~6 min por cliente con margen extra
  const timeoutMs  = clientes.length * 360000;
  const cedulasStr = clientes.map(c => c.cedula).join(', ');
  console.log(`[${new Date().toISOString()}] Puppeteer: ${clientes.length} cédula(s) secuencial: ${cedulasStr}`);

  const clientesArg = JSON.stringify(clientes.map(c => ({ cedula: c.cedula, outputDir: c.outputDir })));
  const env = { ...process.env };

  // Usar spawn (no execFile) para ver los logs de Puppeteer en tiempo real
  const stdout = await new Promise((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      [config.SCRIPT_PUPPETEER, clientesArg, sacUrl, sacUser, sacPass],
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

// ─── Una cédula (usado por /procesar-zip) ─────────────────────────────────────
// Encola la ejecución en la cola SAC y devuelve el resultado parseado del worker.
// Nunca lanza: ante errores devuelve { success: false, error, cedula }.
async function correrPuppeteerCedula(cedula, carpetaSalida, sacUrl, sacUser, sacPass) {
  const posEnCola = sacQueue.size + 1;
  console.log(`[${new Date().toISOString()}] ZIP encolado para cédula ${cedula} (posición en cola: ${posEnCola})`);

  let resultadoPuppeteer;
  try {
    const stdout = await sacQueue.run(() => new Promise((resolve, reject) => {
      console.log(`[${new Date().toISOString()}] Iniciando Puppeteer para cédula ${cedula}...`);
      // sac_puppeteer.js espera: <clientesJSON> <sacUrl> <user> <pass>
      // (el 1er arg es un ARRAY JSON de { cedula, outputDir }, no la cédula suelta).
      const clientesArg = JSON.stringify([{ cedula: String(cedula), outputDir: carpetaSalida }]);
      execFile(
        process.execPath,
        [config.SCRIPT_PUPPETEER, clientesArg, sacUrl, sacUser, sacPass],
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

  return resultadoPuppeteer;
}

// ─── Enriquece resultados de Puppeteer con archivos reales en carpeta ─────────
function enriquecerClientes(clientesPuppeteer, clientesMeta, outBase) {
  return (clientesPuppeteer || []).map(c => {
    const info    = clientesMeta.find(ci => ci.cedula === c.cedula) || {};
    const carpeta = resolverCarpetaLectura(outBase, c.cedula);
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

module.exports = { correrPuppeteerLote, correrPuppeteerCedula, enriquecerClientes };
