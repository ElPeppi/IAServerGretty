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
import { BANCO_DEFAULT, unir, type Proceso } from './rutas';
import { carpetasDeCedula, carpetaDestino } from './carpetasCedula';

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

// Un DOCS_DIR vacío deshabilita EN SILENCIO la sincronización con Drive, y el
// síntoma aparece muy lejos de la causa: el motor no encuentra el pagaré en la
// carpeta del cliente y la demanda se rechaza como si faltara un documento del
// expediente. Se avisa UNA vez por causa (no por cédula) para no inundar el log.
const yaAvisado = new Set<string>();
function raizUtilizable(operacion: string, exigirQueExista: boolean): string | null {
  const root = docsRoot();
  let problema: string | null = null;
  if (!storage.enabled) problema = 'el storage no está configurado (revisa STORAGE_DRIVER y las credenciales)';
  else if (!root) problema = 'DOCS_DIR está vacío';
  else if (exigirQueExista && !fs.existsSync(root)) problema = `DOCS_DIR apunta a "${root}", que no existe`;
  if (!problema) return root;
  const clave = `${operacion}:${problema}`;
  if (!yaAvisado.has(clave)) {
    yaAvisado.add(clave);
    console.error(`[sacSync] ${operacion} DESHABILITADA: ${problema}.`);
  }
  return null;
}

// Carpetas del disco cuyo nombre es la cédula o empieza por "{cedula}_".
function carpetasLocalesDeCedula(root: string, cedula: string): string[] {
  const ced = String(cedula);
  try {
    return fs.readdirSync(root).filter((n) => n === ced || n.startsWith(`${ced}_`));
  } catch {
    return [];
  }
}

// Cada llamada a Drive es una espera de red, no cómputo: medido en producción, el
// proceso pasa el 88% del tiempo por debajo del 20% de CPU. Hacerlas en serie es
// sumar latencias. Este helper las solapa con un tope, que evita que un cliente con
// muchos archivos dispare cientos de peticiones a la API de Google a la vez.
const CONCURRENCIA_DRIVE = 5;

async function enParalelo<T>(items: T[], tarea: (item: T) => Promise<void>): Promise<void> {
  let siguiente = 0;
  const obrero = async (): Promise<void> => {
    for (let i = siguiente++; i < items.length; i = siguiente++) await tarea(items[i]!);
  };
  const obreros = Math.min(CONCURRENCIA_DRIVE, items.length);
  await Promise.all(Array.from({ length: obreros }, obrero));
}

/**
 * Sube a Drive los SAC_*.pdf / CONTACTOS_*.csv de una cédula desde el disco del motor
 * y BORRA la copia local (Drive queda como única fuente). Destino en Drive:
 * `{carpetaGarantias(banco)}/{carpeta}/{archivo}`. Idempotente (overwrite). Devuelve
 * cuántos subió. `banco` = FINANDINA por defecto (en la descarga no se conoce el banco).
 */
export async function subirSacDeCedula(
  cedula: string,
  banco: string = BANCO_DEFAULT,
  proceso: Proceso = 'singular',
): Promise<number> {
  const root = raizUtilizable('subida del SAC a Drive', true);
  if (!root) return 0;
  let subidos = 0;
  // Destino: la carpeta que YA tenga el cliente en Drive (aunque se llame
  // "1143152167-AGOSTO 2026" o "CC 9306310"), no una nueva con el nombre local.
  // Así el SAC cae junto al pagaré en vez de crear un expediente paralelo.
  const destino = await carpetaDestino(cedula, banco, proceso);
  for (const carpeta of carpetasLocalesDeCedula(root, cedula)) {
    const absDir = path.join(root, carpeta);
    let archivos: string[];
    try {
      if (!fs.statSync(absDir).isDirectory()) continue;
      archivos = fs.readdirSync(absDir).filter((f) => SAC_FILE.test(f));
    } catch {
      continue;
    }
    const subirUno = async (f: string): Promise<void> => {
      try {
        const buf = fs.readFileSync(path.join(absDir, f));
        await storage.save(unir(destino, f), buf, mimeDe(f));
        fs.rmSync(path.join(absDir, f), { force: true }); // Drive = fuente → borra local
        subidos++;
      } catch (e) {
        console.error('[sacSync] no se pudo subir/borrar', carpeta, f, e instanceof Error ? e.message : e);
      }
    };
    // La PRIMERA va sola a propósito: `storage.save` crea las carpetas que falten,
    // y `ensureFolder` es un "buscar → crear" sin candado. Varias subidas simultáneas
    // a una carpeta inexistente buscarían a la vez, ninguna la encontraría y cada una
    // crearía la suya → carpetas duplicadas en Drive. Con la primera hecha, el resto
    // ya solo encuentra.
    if (archivos.length) await subirUno(archivos[0]!);
    await enParalelo(archivos.slice(1), subirUno);
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
 * Descarga de Drive a `DOCS_DIR/{cedula}/` los archivos de la cédula ANTES de
 * generar, para que el motor los lea del disco. Devuelve cuántos bajó.
 *
 * La carpeta del cliente en Drive NO se llama siempre igual que la cédula
 * ("1143152167-AGOSTO 2026", "CC 9306310"…), así que se resuelve por contenido
 * del nombre. Si el mismo cliente tiene VARIAS carpetas (asignaciones de meses
 * distintos), se juntan todas en la carpeta local: al motor le da igual de qué
 * carpeta salió cada archivo, y así no se queda sin el pagaré por estar en otra.
 * Si un nombre se repite entre carpetas, gana el de la más reciente (van primero).
 */
export async function hidratarCedula(
  cedula: string,
  banco: string = BANCO_DEFAULT,
  proceso: Proceso = 'singular',
): Promise<number> {
  const root = raizUtilizable('hidratación desde Drive', false);
  if (!root) return 0;
  const ced = String(cedula).replace(/\D/g, '');
  const t0 = Date.now();
  let bajados = 0;
  try {
    const carpetas = await carpetasDeCedula(ced, banco, proceso);
    if (!carpetas.length) return 0;
    const absDir = path.join(root, ced);
    fs.mkdirSync(absDir, { recursive: true });
    // Se listan todas las carpetas del cliente a la vez y DESPUÉS se decide qué
    // bajar, respetando el orden: la carpeta más reciente manda sobre las viejas.
    // Ese desempate exige recorrer en orden, así que la dedupe va en serie aunque
    // las descargas vayan en paralelo.
    // Si una carpeta no se puede listar se sigue con las demás, pero SIN callarlo:
    // un fallo mudo aquí reaparecería como "sin pagaré" al generar.
    const listados = await Promise.all(
      carpetas.map((c) =>
        storage.list(c.relPath).catch((e: unknown) => {
          console.error('[sacSync] no se pudo listar', c.relPath, e instanceof Error ? e.message : e);
          return [] as string[];
        }),
      ),
    );
    const yaBajado = new Set<string>();
    const pendientes: Array<{ rel: string; nombre: string }> = [];
    carpetas.forEach((carpeta, i) => {
      for (const f of listados[i] ?? []) {
        if (yaBajado.has(f)) continue;
        yaBajado.add(f);
        pendientes.push({ rel: unir(carpeta.relPath, f), nombre: f });
      }
    });
    // Solo lecturas: no crean carpetas, así que no hay carrera posible.
    await enParalelo(pendientes, async ({ rel, nombre }) => {
      try {
        const buf = await storage.read(rel);
        fs.writeFileSync(path.join(absDir, nombre), buf);
        bajados++;
      } catch (e) {
        console.error('[sacSync] no se pudo hidratar', ced, nombre, e instanceof Error ? e.message : e);
      }
    });
    if (bajados) {
      const de = carpetas.map((c) => `"${c.nombre}"`).join(', ');
      // El tiempo va en el log a propósito: es la única forma de comparar el antes
      // y el después de paralelizar, y la latencia real solo se mide desde el servidor.
      const segs = ((Date.now() - t0) / 1000).toFixed(1);
      console.error(`[sacSync] ${cedula}: ${bajados} archivo(s) hidratado(s) de Drive (${de}) a local en ${segs}s`);
    }
  } catch (e) {
    console.error('[sacSync] error hidratando', cedula, e instanceof Error ? e.message : e);
  }
  return bajados;
}

/** Borra la(s) carpeta(s) local(es) de la cédula tras generar (todo ya quedó en Drive). */
export function limpiarLocalCedula(cedula: string): void {
  const root = docsRoot();
  if (!root || !fs.existsSync(root)) return;
  for (const carpeta of carpetasLocalesDeCedula(root, cedula)) {
    try {
      fs.rmSync(path.join(root, carpeta), { recursive: true, force: true });
    } catch (e) {
      console.error('[sacSync] no se pudo limpiar local', carpeta, e instanceof Error ? e.message : e);
    }
  }
}
