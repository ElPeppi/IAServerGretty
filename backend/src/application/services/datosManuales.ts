/**
 * datosManuales — datos del pagaré que se capturan a mano.
 *
 * El pagaré FINANDINA llega escaneado y hay dos datos que NINGÚN OCR saca:
 *   · el número impreso del pagaré (el motor cae a la OBLIGACION del Excel, que
 *     es otro número: la demanda salía citando un pagaré que no es),
 *   · la fecha de suscripción, que va manuscrita ("a los treinta y uno (31) del
 *     mes de Julio del año 2023") → la demanda salía con "#####".
 *
 * Se capturan desde el visor del documento y se guardan por cédula. A partir de
 * ahí mandan sobre lo que lea el motor, tanto en demandas como en poderes.
 */

import { prisma } from '../../infrastructure/database/prisma/client';
import type { CorreccionesPorCedula } from './IEngineService';

export interface DatoManualInput {
  numeroPagare?: string | null;
  fechaSuscripcion?: string | null;
  nota?: string | null;
}

/** Solo dígitos: la cédula viaja con puntos/espacios según de dónde venga. */
export function normalizarCedula(cedula: string | number): string {
  return String(cedula ?? '').replace(/\D/g, '');
}

/**
 * Valida y normaliza la fecha de suscripción a DD/MM/YYYY (lo que entiende el
 * motor). Acepta DD/MM/YYYY, DD-MM-YYYY y el ISO del <input type="date">.
 * Devuelve null si no es una fecha real — mejor no capturarla que meter basura
 * en un documento que se radica.
 */
export function normalizarFechaSuscripcion(valor: string): string | null {
  const s = String(valor ?? '').trim();
  if (!s) return null;

  let d: number, m: number, y: number;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const dmy = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (iso) {
    [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  } else if (dmy) {
    [d, m, y] = [Number(dmy[1]), Number(dmy[2]), Number(dmy[3])];
  } else {
    return null;
  }

  // Rechazar 31/02 y compañía: Date "corrige" solo y pasaría desapercibido.
  const fecha = new Date(Date.UTC(y, m - 1, d));
  if (fecha.getUTCFullYear() !== y || fecha.getUTCMonth() !== m - 1 || fecha.getUTCDate() !== d) return null;
  if (y < 1950 || y > new Date().getUTCFullYear() + 1) return null;

  return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
}

/** Lo guardado para una cédula (null si nunca se capturó nada). */
export async function obtenerDatoManual(cedula: string) {
  const ced = normalizarCedula(cedula);
  if (!ced) return null;
  return prisma.datoManual.findUnique({ where: { cedula: ced } });
}

/**
 * Guarda/actualiza los datos de una cédula. Un campo vacío BORRA el valor
 * (volver a lo que lea el motor), no lo deja como estaba.
 */
export async function guardarDatoManual(cedula: string, datos: DatoManualInput, autorId?: string) {
  const ced = normalizarCedula(cedula);
  if (!ced) throw new Error('Cédula inválida');

  const numeroPagare = String(datos.numeroPagare ?? '').trim() || null;
  const nota         = String(datos.nota ?? '').trim() || null;

  const fechaCruda = String(datos.fechaSuscripcion ?? '').trim();
  const fechaSuscripcion = fechaCruda ? normalizarFechaSuscripcion(fechaCruda) : null;
  if (fechaCruda && !fechaSuscripcion) {
    throw new Error(`Fecha de suscripción inválida: "${fechaCruda}". Usa DD/MM/AAAA.`);
  }

  const valores = { numeroPagare, fechaSuscripcion, nota, autorId: autorId ?? null };
  return prisma.datoManual.upsert({
    where:  { cedula: ced },
    update: valores,
    create: { cedula: ced, ...valores },
  });
}

/**
 * Mapa { cedula: { numeroPagare, fechaSuscripcion } } para pasarle al motor.
 * Sin cédulas → devuelve {} sin tocar la base. Solo entran las que tienen algo
 * capturado, para que el motor no reciba ruido.
 */
export async function correccionesDeCedulas(cedulas: Array<string | number>): Promise<CorreccionesPorCedula> {
  const lista = [...new Set(cedulas.map(normalizarCedula).filter(Boolean))];
  if (!lista.length) return {};

  const filas = await prisma.datoManual.findMany({ where: { cedula: { in: lista } } });
  const out: CorreccionesPorCedula = {};
  for (const f of filas) {
    if (!f.numeroPagare && !f.fechaSuscripcion) continue;
    out[f.cedula] = {
      ...(f.numeroPagare     ? { numeroPagare: f.numeroPagare } : {}),
      ...(f.fechaSuscripcion ? { fechaSuscripcion: f.fechaSuscripcion } : {}),
    };
  }
  return out;
}
