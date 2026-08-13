/**
 * carpetasCedula — resuelve la carpeta de un cliente dentro de GARANTIAS.
 *
 * La oficina NO nombra esas carpetas de una sola forma. Lo que hay hoy en Drive:
 *
 *   98598830                  ← convención original (la mayoría del histórico)
 *   1143152167-AGOSTO 2026    ← convención NUEVA (cédula + mes de la asignación)
 *   92540211_2026             ← la que crea el motor cuando {cedula} ya existía
 *   33114995_06_2026          ← ídem, con mes
 *   CC 9306310                ← la dominante en GARANTIA MOBILIARIAS
 *   35252084 - 2025, 15648165- AGOSTO 2026, CC 45754033-, CC 40932033+ …
 *
 * Buscar por nombre EXACTO = cédula solo acierta en el primer caso. Aquí se
 * resuelve por la CÉDULA contenida en el nombre, y el resto se interpreta como
 * fecha para saber cuál es la más reciente — misma semántica que el motor en
 * disco (`sac_scripts/src/utils/carpetas.js`).
 */
import { storage } from './index';
import { carpetaGarantias, unir, type Proceso } from './rutas';

export interface CarpetaCliente {
  nombre: string;   // nombre tal cual en Drive
  relPath: string;  // ruta completa bajo GARANTIAS
  anio: number;     // 0 si el nombre no trae año
  mes: number;      // 0 si no trae mes
}

const MESES_ES: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7,
  agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
  // Vistos en carpetas reales (abreviatura y errata):
  nov: 11, gosto: 8,
};

/** Año/mes de lo que sobra del nombre tras la cédula. Tolera cualquier separador. */
function parseSufijoFecha(sufijo: string): { anio: number; mes: number } {
  let anio = 0, mes = 0;
  for (const p of String(sufijo).toLowerCase().split(/[^a-z0-9áéíóú]+/i).filter(Boolean)) {
    if (/^\d{4}$/.test(p)) anio = parseInt(p, 10);
    else if (/^\d{1,2}$/.test(p)) { const n = parseInt(p, 10); if (!mes && n >= 1 && n <= 12) mes = n; }
    else if (MESES_ES[p] !== undefined) mes = MESES_ES[p];
  }
  return { anio, mes };
}

/**
 * Cédula que identifica una carpeta de cliente, o null si el nombre no es de un
 * cliente (p. ej. `_poderes`). Se toma la PRIMERA corrida de 5–12 dígitos; un año
 * suelto ("2026") no califica por tener solo 4.
 */
export function analizarCarpeta(nombre: string): { cedula: string; anio: number; mes: number } | null {
  const m = String(nombre).match(/\d{5,12}/);
  if (!m) return null;
  const cedula = m[0];
  const sufijo = String(nombre).slice((m.index ?? 0) + cedula.length);
  return { cedula, ...parseSufijoFecha(sufijo) };
}

// El listado de GARANTIAS tiene cientos de entradas y se consulta una vez por
// cliente en los lotes → se cachea un rato. `invalidarCache` lo tira al crear
// una carpeta nueva.
const TTL_MS = 60 * 1000;
const cache = new Map<string, { nombres: string[]; ts: number }>();

export function invalidarCache(): void {
  cache.clear();
}

async function listarGarantias(banco: string, proceso: Proceso): Promise<string[]> {
  const clave = `${banco}|${proceso}`;
  const hit = cache.get(clave);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.nombres;
  let nombres: string[] = [];
  try {
    nombres = await storage.list(carpetaGarantias(banco, proceso));
  } catch {
    nombres = [];
  }
  cache.set(clave, { nombres, ts: Date.now() });
  return nombres;
}

/**
 * Carpetas existentes de una cédula, MÁS RECIENTE PRIMERO (año desc, mes desc y,
 * a igualdad, la de nombre más corto — la original sin sufijo). Vacío si no hay.
 */
export async function carpetasDeCedula(
  cedula: string,
  banco: string,
  proceso: Proceso = 'singular',
): Promise<CarpetaCliente[]> {
  const ced = String(cedula).replace(/\D/g, '');
  if (!ced) return [];
  const base = carpetaGarantias(banco, proceso);
  const out: CarpetaCliente[] = [];
  for (const nombre of await listarGarantias(banco, proceso)) {
    const info = analizarCarpeta(nombre);
    if (!info || info.cedula !== ced) continue;
    out.push({ nombre, relPath: unir(base, nombre), anio: info.anio, mes: info.mes });
  }
  out.sort((a, b) => (b.anio - a.anio) || (b.mes - a.mes) || (a.nombre.length - b.nombre.length));
  return out;
}

/**
 * Carpeta donde ESCRIBIR los documentos de una cédula: la más reciente que ya
 * exista (para no partir en dos el expediente del cliente) o, si no hay ninguna,
 * `GARANTIAS/{cedula}`.
 */
export async function carpetaDestino(
  cedula: string,
  banco: string,
  proceso: Proceso = 'singular',
): Promise<string> {
  const existentes = await carpetasDeCedula(cedula, banco, proceso);
  if (existentes.length) return existentes[0].relPath;
  invalidarCache(); // se va a crear una carpeta nueva
  return unir(carpetaGarantias(banco, proceso), String(cedula).replace(/\D/g, ''));
}

/**
 * Traduce el relPath que devuelve el MOTOR (`{carpetaLocalDelCliente}/{archivo}`)
 * a su sitio en Drive. El motor nombra la carpeta local con su propia convención
 * ({cedula}, {cedula}_{año}…), que no tiene por qué coincidir con la de Drive
 * ("1143152167-AGOSTO 2026"): si no se tradujera, la demanda acabaría en una
 * carpeta nueva, separada de los documentos del cliente.
 */
export async function relEnCarpetaCedula(
  relPathMotor: string,
  banco: string,
  proceso: Proceso = 'singular',
): Promise<string> {
  const partes = String(relPathMotor).replace(/\\/g, '/').split('/').filter(Boolean);
  const info = partes.length > 1 ? analizarCarpeta(partes[0]) : null;
  if (!info) {
    // Sin carpeta de cliente reconocible (o archivo suelto) → tal cual bajo GARANTIAS.
    return unir(carpetaGarantias(banco, proceso), relPathMotor);
  }
  return unir(await carpetaDestino(info.cedula, banco, proceso), ...partes.slice(1));
}
