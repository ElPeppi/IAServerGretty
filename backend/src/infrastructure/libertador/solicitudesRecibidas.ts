/**
 * solicitudesRecibidas.ts — Registro de las solicitudes de Libertador que llegan
 * por correo (n8n → POST /api/libertador/carpetas) y de en qué va cada paso
 * automático: carpeta en Drive, anexos de Bolívar y formulario de solicitud de
 * documentos. La página de Libertador lo lee para mostrar lo que llegó al
 * instante, sin esperar a que aparezca en el cuadro jurídico.
 *
 * Todo es best-effort: si Postgres falla, el flujo de Drive sigue igual y solo se
 * pierde la traza en pantalla. Por eso nada de aquí lanza.
 */
import { prisma } from '../database/prisma/client';

export type EstadoCarpeta = 'creada' | 'existente' | 'error';
export type EstadoAnexos = 'pendiente' | 'ok' | 'sin_anexos' | 'error';
export type EstadoFormulario = 'pendiente' | 'enviado' | 'ya_enviado' | 'error' | 'apagado';

export interface RecepcionLibertador {
  solicitud: string;
  procesos: string[];
  tipoAlistamiento?: string;
  estadoSiniestro?: string;
  canon?: number;
  deuda?: number;
  asuntoCorreo?: string;
}

async function seguro<T>(que: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e: unknown) {
    console.error(`[LIB-RECIBIDAS] ${que}: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/**
 * Anota que llegó la solicitud. Si ya estaba, suma los procesos nuevos (una
 * conciliación puede llegar primero y el ejecutivo después) y deja los pasos en
 * "pendiente", porque el flujo vuelve a correr.
 */
export async function registrarRecepcion(r: RecepcionLibertador, formularioActivo: boolean): Promise<void> {
  const formularioEstado: EstadoFormulario = formularioActivo ? 'pendiente' : 'apagado';
  await seguro(`registrar ${r.solicitud}`, async () => {
    const previa = await prisma.libertadorSolicitud.findUnique({ where: { solicitud: r.solicitud } });
    const datos = {
      tipoAlistamiento: r.tipoAlistamiento || previa?.tipoAlistamiento || null,
      estadoSiniestro: r.estadoSiniestro || previa?.estadoSiniestro || null,
      canon: r.canon ?? previa?.canon ?? null,
      deuda: r.deuda ?? previa?.deuda ?? null,
      asuntoCorreo: r.asuntoCorreo || previa?.asuntoCorreo || null,
      anexosEstado: 'pendiente',
      anexosCantidad: null,
      anexosDetalle: null,
      formularioEstado,
      formularioDetalle: null,
    };
    if (!previa) {
      await prisma.libertadorSolicitud.create({ data: { solicitud: r.solicitud, procesos: r.procesos, ...datos } });
      return;
    }
    await prisma.libertadorSolicitud.update({
      where: { solicitud: r.solicitud },
      data: {
        ...datos,
        procesos: [...new Set([...previa.procesos, ...r.procesos])],
        vecesRecibida: { increment: 1 },
        ultimaRecepcion: new Date(),
      },
    });
  });
}

export async function marcarCarpeta(
  solicitud: string,
  estado: EstadoCarpeta,
  info: { nombre?: string; id?: string; detalle?: string } = {},
): Promise<void> {
  await seguro(`carpeta ${solicitud}`, async () => {
    await prisma.libertadorSolicitud.update({
      where: { solicitud },
      data: {
        carpetaEstado: estado,
        carpetaNombre: info.nombre ?? undefined,
        carpetaId: info.id ?? undefined,
        carpetaDetalle: info.detalle ?? null,
        // Sin carpeta no se bajan anexos ni se manda formulario: quedarían "pendiente" para siempre.
        ...(estado === 'error' ? { anexosEstado: 'error', anexosDetalle: 'no hay carpeta del caso' } : {}),
      },
    });
    // El formulario apagado sigue apagado: no es que haya fallado, es que no se usa.
    if (estado === 'error') {
      await prisma.libertadorSolicitud.updateMany({
        where: { solicitud, NOT: { formularioEstado: 'apagado' } },
        data: { formularioEstado: 'error', formularioDetalle: 'no hay carpeta del caso' },
      });
    }
  });
}

export async function marcarAnexos(solicitud: string, estado: EstadoAnexos, cantidad?: number, detalle?: string): Promise<void> {
  await seguro(`anexos ${solicitud}`, () => prisma.libertadorSolicitud.update({
    where: { solicitud },
    data: { anexosEstado: estado, anexosCantidad: cantidad ?? null, anexosDetalle: detalle ?? null },
  }));
}

export async function marcarFormulario(solicitud: string, estado: EstadoFormulario, detalle?: string): Promise<void> {
  await seguro(`formulario ${solicitud}`, () => prisma.libertadorSolicitud.update({
    where: { solicitud },
    data: { formularioEstado: estado, formularioDetalle: detalle ?? null },
  }));
}

/** Las que llegaron en los últimos `dias`, la más reciente primero. */
export async function listarRecibidas(dias = 60) {
  const desde = new Date(Date.now() - dias * 24 * 60 * 60 * 1000);
  return prisma.libertadorSolicitud.findMany({
    where: { ultimaRecepcion: { gte: desde } },
    orderBy: { ultimaRecepcion: 'desc' },
    take: 500,
  });
}
