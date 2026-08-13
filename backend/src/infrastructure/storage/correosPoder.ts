/**
 * correosPoder — los correos del banco que otorgan el poder (ANEXO 1 de la demanda).
 *
 * La oficina los guarda como PDF en `…/{proceso}/PODERES` (sueltos y dentro de
 * subcarpetas por año). Antes había que volver a subir el PDF en cada generación;
 * con esto se puede ELEGIR uno de los que ya están en el servidor.
 *
 * Se ordenan por la fecha del NOMBRE ("30 ABRIL 2025", "04 DE NOVIEMBRE DE 2025"),
 * no por la de Drive: la migración dejó a todos los archivos con la misma fecha de
 * modificación, así que esa no distingue nada.
 */
import { storage } from './index';
import { carpetaPoderes, unir, type Proceso } from './rutas';

export interface CorreoPoder {
  nombre: string;
  relPath: string;
  url: string;
  fecha: string | null;   // ISO (solo día) si se pudo leer del nombre
  carpeta: string;        // '' si está suelto en PODERES, o el año/subcarpeta
}

const MESES: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7,
  agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

const sinTilde = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Fecha escrita en el nombre del archivo, si la hay ("30 ABRIL 2025"). */
export function fechaDeNombre(nombre: string): Date | null {
  const n = sinTilde(nombre);
  const anio = n.match(/\b(20\d{2})\b/);
  if (!anio) return null;
  let mes = -1, posMes = -1;
  for (const [nom, num] of Object.entries(MESES)) {
    const i = n.indexOf(nom);
    if (i >= 0 && (posMes < 0 || i < posMes)) { mes = num; posMes = i; }
  }
  if (mes < 0) return null;
  // Día = último número de 1–2 cifras antes del mes ("ASIGNACION 04 DE NOVIEMBRE").
  const antes = n.slice(0, posMes);
  const nums = [...antes.matchAll(/\b(\d{1,2})\b/g)]
    .map((m) => parseInt(m[1], 10))
    .filter((d) => d >= 1 && d <= 31);
  const dia = nums.length ? nums[nums.length - 1] : 1;
  const d = new Date(Number(anio[1]), mes - 1, dia, 12);
  return isNaN(d.getTime()) ? null : d;
}

// Qué PDFs de esa carpeta son el correo de otorgamiento de cada proceso. Misma
// regla que usa el motor para elegir el ANEXO 1 de respaldo (anexos.js).
const ES_CORREO: Record<Proceso, (n: string) => boolean> = {
  singular: (n) => /(PODERES?\s+EJECUTIVOS?|OTORGAMIENTO)/i.test(n) && !/PAGO\s*DIRECTO/i.test(n),
  pago_directo: (n) => /PAGO\s*DIRECTO/i.test(n),
};

/**
 * Correos disponibles en el servidor, MÁS RECIENTE PRIMERO. Mira la carpeta
 * PODERES y sus subcarpetas de año (un nivel, que es como está organizada).
 */
export async function correosPoderDisponibles(
  banco: string,
  proceso: Proceso = 'singular',
): Promise<CorreoPoder[]> {
  if (!storage.enabled) return [];
  const base = carpetaPoderes(banco, proceso);
  const sirve = ES_CORREO[proceso];
  const out: CorreoPoder[] = [];

  const revisar = async (dir: string, etiqueta: string): Promise<string[]> => {
    let nombres: string[] = [];
    try { nombres = await storage.list(dir); } catch { return []; }
    const subcarpetas: string[] = [];
    for (const n of nombres) {
      if (/\.[a-z0-9]{2,5}$/i.test(n)) {
        if (!/\.pdf$/i.test(n) || !sirve(n)) continue;
        const rel = unir(dir, n);
        const f = fechaDeNombre(n);
        out.push({
          nombre: n,
          relPath: rel,
          url: storage.urlFor(rel),
          fecha: f ? f.toISOString().slice(0, 10) : null,
          carpeta: etiqueta,
        });
      } else {
        subcarpetas.push(n);   // sin extensión → subcarpeta (año)
      }
    }
    return subcarpetas;
  };

  const anios = await revisar(base, '');
  await Promise.all(anios.map((a) => revisar(unir(base, a), a)));

  // Los que traen fecha en el nombre van primero, del más nuevo al más viejo.
  out.sort((a, b) => {
    if (a.fecha && b.fecha) return a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : 0;
    if (a.fecha) return -1;
    if (b.fecha) return 1;
    return a.nombre.localeCompare(b.nombre);
  });
  return out;
}
