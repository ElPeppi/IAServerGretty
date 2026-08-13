/**
 * utils/carpetas.js — Creación y resolución de carpetas por cédula
 *
 * Convención de carpetas en OUT_DIR (de más antigua a más reciente):
 *   {cedula}            → primera vez que se procesa el cliente
 *   {cedula}_{año}      → la carpeta {cedula} ya existía (nuevo proceso)
 *   {cedula}_{MM}_{año} → {cedula} y {cedula}_{año} ya existían en el mismo año
 *
 * La LECTURA (generación de la Plantilla Singular) siempre usa la carpeta
 * MÁS RECIENTE de la cédula según esa convención.
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
  // Toda creación invalida el listado cacheado del padre (ver _dirCache abajo)
  _dirCache.delete(path.dirname(dir));
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

// ─── Listado de carpetas de una cédula ───────────────────────────────────────
// Devuelve las carpetas existentes de la cédula con su "clave de fecha":
//   {cedula}            → { anio: 0,    mes: 0 }   (la original, más antigua)
//   {cedula}_{año}      → { anio, mes: 0 }
//   {cedula}_{MM}_{año} → { anio, mes }
// Cache breve del readdir para no listar el share de red en cada llamada.

const _dirCache = new Map(); // outBase → { names, ts }
const DIR_CACHE_TTL = 60 * 1000;

function listarNombres(outBase) {
  const hit = _dirCache.get(outBase);
  if (hit && Date.now() - hit.ts < DIR_CACHE_TTL) return hit.names;
  let names = [];
  try { names = fs.readdirSync(outBase); } catch (_) {}
  _dirCache.set(outBase, { names, ts: Date.now() });
  return names;
}

// Nombres de mes en español → número. Para carpetas escritas a mano con el mes
// en texto: {cedula}_{año}_{mes} o {cedula}_{mes}_{año} (ej. 12345678_2026_Julio).
const MESES_ES = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7,
  agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
  // Vistos en carpetas reales del servidor (abreviatura y errata de tipeo):
  nov: 11, gosto: 8,
};

// Extrae {anio, mes} de un sufijo de carpeta. Tolerante: cualquier separador
// (_ / - / espacio) y el mes como número (1-12) o nombre en español, en cualquier
// orden. Casos:
//   ""             → {0,0}     (carpeta original {cedula}, la más antigua)
//   "2026"         → {2026,0}  ({cedula}_{año})
//   "06_2026"      → {2026,6}  ({cedula}_{MM}_{año}, convención del motor)
//   "2026_Julio"   → {2026,7}  (mes en texto)
//   "Julio_2026"   → {2026,7}
function parseSufijoFecha(sufijo) {
  let anio = 0, mes = 0;
  for (const p of String(sufijo).toLowerCase().split(/[_\-\s]+/).filter(Boolean)) {
    if (/^\d{4}$/.test(p)) anio = parseInt(p, 10);
    else if (/^\d{1,2}$/.test(p)) { const n = parseInt(p, 10); if (!mes && n >= 1 && n <= 12) mes = n; }
    else if (MESES_ES[p]) mes = MESES_ES[p];
  }
  return { anio, mes };
}

function carpetasDeCedula(outBase, cedula) {
  const ced = String(cedula);
  // La carpeta es la cédula, con cualquier prefijo/sufijo que use la oficina:
  //   12345678            12345678_2026        12345678_06_2026
  //   12345678-AGOSTO 2026    12345678 - 2025      CC 12345678
  // Antes solo se aceptaba "_" como separador, así que las carpetas nuevas
  // ({cedula}-{MES} {AÑO}) y las de "CC {cedula}" no se encontraban.
  const re = new RegExp(`^(?:CC\\s*)?${ced}(?![0-9])(.*)$`, 'i');
  const out = [];
  for (const name of listarNombres(outBase)) {
    const m = name.match(re);
    if (!m) continue;
    const { anio, mes } = parseSufijoFecha(m[1] || '');
    out.push({ name, anio, mes, path: path.join(outBase, name) });
  }
  // Más reciente primero: año desc, luego mes desc. A igualdad, la de nombre más
  // corto primero (la original {cedula} sin sufijo) para un orden estable.
  out.sort((a, b) => (b.anio - a.anio) || (b.mes - a.mes) || (a.name.length - b.name.length));
  return out;
}

// Al ESCRIBIR (procesar ZIP nuevo): no mezclar procesos en una carpeta vieja.
//   {cedula} libre               → {cedula}
//   {cedula}_{año} libre         → {cedula}_{año}
//   ambas ocupadas (mismo año)   → {cedula}_{MM}_{año}  (la del mes se reutiliza)
function resolverCarpetaEscritura(outBase, cedula) {
  _dirCache.delete(outBase); // decisión de escritura siempre con datos frescos

  const normal = path.join(outBase, String(cedula));
  if (!fs.existsSync(normal)) return normal;

  const hoy     = new Date();
  const anio    = hoy.getFullYear();
  const conAnio = path.join(outBase, `${cedula}_${anio}`);
  if (!fs.existsSync(conAnio)) return conAnio;

  const mes = String(hoy.getMonth() + 1).padStart(2, '0');
  return path.join(outBase, `${cedula}_${mes}_${anio}`);
}

// Al LEER (generar Plantilla Singular): la carpeta MÁS RECIENTE que exista
// según la convención ({cedula}_{MM}_{año} > {cedula}_{año} > {cedula}).
function resolverCarpetaLectura(outBase, cedula) {
  const carpetas = carpetasDeCedula(outBase, cedula);
  if (carpetas.length > 0) return carpetas[0].path;
  // Ninguna existe → devolver {cedula}; cada función lo maneja con existsSync
  return path.join(outBase, String(cedula));
}

module.exports = {
  mkdirpSync,
  resolverCarpetaEscritura,
  resolverCarpetaLectura,
  // Alias usado por el procesador Singular (misma semántica que lectura)
  resolverCarpetaCedula: resolverCarpetaLectura,
};
