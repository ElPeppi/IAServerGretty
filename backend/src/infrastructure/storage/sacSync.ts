/**
 * sacSync — sincroniza la info del SAC entre el disco del motor y Drive.
 *
 * Modelo: **Drive es la fuente de verdad**; el disco local (DOCS_DIR = carpeta del
 * motor) es solo un caché EFÍMERO.
 *
 *   - Al DESCARGAR el SAC: el motor lo deja en `DOCS_DIR/{cedula}/`. El backend lo
 *     SUBE a Drive (`GARANTIAS/{cedula}/`) y BORRA la copia local (`subirSacDeCedula`).
 *   - Al GENERAR la demanda: el backend DESCARGA de Drive a `DOCS_DIR/{cedula}/`
 *     (`hidratarCedula`) para que el motor lea los SAC del disco, y al terminar
 *     BORRA la carpeta local (`limpiarLocalCedula`).
 *
 * Best-effort: no lanzan. Requieren `storage` habilitado y `DOCS_DIR` (disco del motor).
 */
import fs from 'fs';
import path from 'path';
import { storage } from './index';
import { carpetaGarantias, BANCO_DEFAULT, unir } from './rutas';

// Artefactos que produce la descarga del SAC (no toca lo demás de la carpeta).
const SAC_FILE = /^(SAC_.*\.pdf|CONTACTOS_.*\.csv)$/i;

function mimeDe(name: string): string {
  if (/\.pdf$/i.test(name)) return 'application/pdf';
  if (/\.csv$/i.test(name)) return 'text/csv; charset=utf-8';
  if (/\.docx$/i.test(name)) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (/\.xlsx$/i.test(name)) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  return 'application/octet-stream';
}

function docsRoot(): string {
  return process.env.DOCS_DIR || '';
}

// Carpetas del disco cuyo nombre es la cédula o empieza por "{cedula}_".
function carpetasDeCedula(root: string, cedula: string): string[] {
  const ced = String(cedula);
  try {
    return fs.readdirSync(root).filter((n) => n === ced || n.startsWith(`${ced}_`));
  } catch {
    return [];
  }
}

/**
 * Sube a Drive los SAC_*.pdf / CONTACTOS_*.csv de una cédula desde el disco del motor
 * y BORRA la copia local (Drive queda como única fuente). Destino en Drive:
 * `{carpetaGarantias(banco)}/{carpeta}/{archivo}`. Idempotente (overwrite). Devuelve
 * cuántos subió. `banco` = FINANDINA por defecto (en la descarga no se conoce el banco).
 */
export async function subirSacDeCedula(cedula: string, banco: string = BANCO_DEFAULT): Promise<number> {
  const root = docsRoot();
  if (!storage.enabled || !root || !fs.existsSync(root)) return 0;
  let subidos = 0;
  const base = carpetaGarantias(banco);
  for (const carpeta of carpetasDeCedula(root, cedula)) {
    const absDir = path.join(root, carpeta);
    let archivos: string[];
    try {
      if (!fs.statSync(absDir).isDirectory()) continue;
      archivos = fs.readdirSync(absDir).filter((f) => SAC_FILE.test(f));
    } catch {
      continue;
    }
    for (const f of archivos) {
      try {
        const buf = fs.readFileSync(path.join(absDir, f));
        await storage.save(unir(base, carpeta, f), buf, mimeDe(f));
        fs.rmSync(path.join(absDir, f), { force: true }); // Drive = fuente → borra local
        subidos++;
      } catch (e) {
        console.error('[sacSync] no se pudo subir/borrar', carpeta, f, e instanceof Error ? e.message : e);
      }
    }
    // Si la carpeta quedó vacía (solo tenía SAC), quítala.
    try {
      if (fs.readdirSync(absDir).length === 0) fs.rmdirSync(absDir);
    } catch {
      /* quedaban otros archivos (p. ej. pagaré) → se deja la carpeta */
    }
  }
  if (subidos) console.error(`[sacSync] ${cedula}: ${subidos} archivo(s) SAC subido(s) a Drive y borrado(s) de local`);
  return subidos;
}

/**
 * Descarga de Drive a `DOCS_DIR/{cedula}/` los archivos de la cédula (GARANTIAS/{cedula})
 * ANTES de generar, para que el motor los lea del disco. Devuelve cuántos bajó.
 */
export async function hidratarCedula(cedula: string, banco: string = BANCO_DEFAULT): Promise<number> {
  const root = docsRoot();
  if (!storage.enabled || !root) return 0;
  const ced = String(cedula);
  const relDir = unir(carpetaGarantias(banco), ced);
  let bajados = 0;
  try {
    const archivos = await storage.list(relDir);
    if (!archivos.length) return 0;
    const absDir = path.join(root, ced);
    fs.mkdirSync(absDir, { recursive: true });
    for (const f of archivos) {
      try {
        const buf = await storage.read(unir(relDir, f));
        fs.writeFileSync(path.join(absDir, f), buf);
        bajados++;
      } catch (e) {
        console.error('[sacSync] no se pudo hidratar', ced, f, e instanceof Error ? e.message : e);
      }
    }
    if (bajados) console.error(`[sacSync] ${cedula}: ${bajados} archivo(s) hidratado(s) de Drive a local`);
  } catch (e) {
    console.error('[sacSync] error hidratando', cedula, e instanceof Error ? e.message : e);
  }
  return bajados;
}

/** Borra la(s) carpeta(s) local(es) de la cédula tras generar (todo ya quedó en Drive). */
export function limpiarLocalCedula(cedula: string): void {
  const root = docsRoot();
  if (!root || !fs.existsSync(root)) return;
  for (const carpeta of carpetasDeCedula(root, cedula)) {
    try {
      fs.rmSync(path.join(root, carpeta), { recursive: true, force: true });
    } catch (e) {
      console.error('[sacSync] no se pudo limpiar local', carpeta, e instanceof Error ? e.message : e);
    }
  }
}
