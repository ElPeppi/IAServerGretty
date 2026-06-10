/**
 * utils/carpetas.js — Creación y resolución de carpetas por cédula
 *
 * Convención de carpetas en OUT_DIR:
 *   {cedula}        → primera vez que se procesa el cliente
 *   {cedula}_{año}  → si la carpeta {cedula} ya existía (nuevo proceso en otro año)
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const { execFileSync } = require('child_process');

// ─── mkdirpSync: mkdir robusto para rutas UNC en Windows ─────────────────────
// Node.js fs.mkdirSync({ recursive: true }) falla con UNKNOWN en rutas UNC
// (\\servidor\recurso\...) porque no puede determinar el "root" del UNC path.
// Solución: intentar fs.mkdirSync primero; si falla con UNKNOWN en Windows,
// usar cmd.exe /c md que soporta UNC natively.
function mkdirpSync(dir) {
  if (fs.existsSync(dir)) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    if (e.code === 'EEXIST') return; // ya existe — OK
    // En Windows, rutas UNC pueden fallar con UNKNOWN aunque el share sea accesible.
    // cmd.exe /c md maneja UNC paths de forma nativa.
    if (process.platform === 'win32' && (e.code === 'UNKNOWN' || e.code === 'EPERM')) {
      try {
        execFileSync('cmd.exe', ['/c', 'md', dir], { timeout: 15000 });
        if (!fs.existsSync(dir)) throw e; // si aún no existe, relanzar original
        return;
      } catch (e2) {
        // cmd.exe sale con error si el directorio ya existe — ignorar ese caso
        if (fs.existsSync(dir)) return;
        // Si aún no existe y fue UNKNOWN, agregar contexto al error
        const err = new Error(`No se pudo crear directorio "${dir}": ${e.message} (cmd fallback: ${e2.message})`);
        err.code = e.code;
        throw err;
      }
    }
    throw e;
  }
}

// Al ESCRIBIR (procesar ZIP nuevo): si ya existe {cedula}, usa {cedula}_{año}.
// Así los documentos de un nuevo año no mezclan con los anteriores.
function resolverCarpetaEscritura(outBase, cedula) {
  const normal = path.join(outBase, String(cedula));
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

module.exports = {
  mkdirpSync,
  resolverCarpetaEscritura,
  resolverCarpetaLectura,
  // Alias usado por el procesador Singular (misma semántica que lectura)
  resolverCarpetaCedula: resolverCarpetaLectura,
};
