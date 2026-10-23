import { useState } from 'react';
import type { LibertadorRecibida } from '../../../infrastructure/api/libertadorApi';

/**
 * Solicitudes que llegaron por correo (n8n → backend) y en qué va su flujo
 * automático: carpeta en Drive, anexos del portal de Bolívar y formulario de
 * solicitud de documentos. Sale al instante, antes de que la solicitud aparezca
 * en el cuadro jurídico; la columna "Cuadro" dice si ya está ahí.
 */

interface Props {
  recibidas: LibertadorRecibida[];
  // Solicitudes que ya tiene el cuadro (cualquier fila, no solo las pendientes).
  enCuadro: Set<string>;
  // Si el cuadro no se pudo leer no se puede afirmar que falte en él.
  cuadroLeido: boolean;
  error: string | null;
}

const VISIBLES = 5;

type Chip = { texto: string; clase: string };
const VERDE = 'bg-green-100 text-green-700';
const AMBAR = 'bg-amber-100 text-amber-700';
const ROJO = 'bg-red-100 text-red-700';
const GRIS = 'bg-gray-100 text-gray-600';

function chipCarpeta(r: LibertadorRecibida): Chip | null {
  switch (r.carpetaEstado) {
    case 'creada': return { texto: 'Creada', clase: VERDE };
    case 'existente': return { texto: 'Ya existía', clase: VERDE };
    case 'error': return { texto: 'Error', clase: ROJO };
    default: return null;
  }
}

function chipAnexos(r: LibertadorRecibida): Chip | null {
  switch (r.anexosEstado) {
    case 'pendiente': return { texto: 'Bajando…', clase: AMBAR };
    case 'ok': return { texto: `${r.anexosCantidad ?? 0} documento(s)`, clase: VERDE };
    case 'sin_anexos': return { texto: 'Sin anexos en Bolívar', clase: GRIS };
    case 'error': return { texto: 'Error', clase: ROJO };
    default: return null;
  }
}

function chipFormulario(r: LibertadorRecibida): Chip | null {
  switch (r.formularioEstado) {
    case 'pendiente': return { texto: 'Pendiente', clase: AMBAR };
    case 'enviado': return { texto: 'Enviado', clase: VERDE };
    case 'ya_enviado': return { texto: 'Ya enviado', clase: VERDE };
    case 'error': return { texto: 'Sin enviar', clase: ROJO };
    case 'apagado': return { texto: 'Apagado', clase: GRIS };
    default: return null;
  }
}

function Estado({ chip, detalle }: { chip: Chip | null; detalle?: string | null }) {
  if (!chip) return <span className="text-gray-400">—</span>;
  return (
    <span
      title={detalle || undefined}
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${chip.clase} ${detalle ? 'cursor-help' : ''}`}
    >
      {chip.texto}
    </span>
  );
}

const fechaHora = (iso: string) => new Date(iso).toLocaleString('es-CO', {
  timeZone: 'America/Bogota', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
});

const pesos = (n: number | null) => (n ? `$${n.toLocaleString('es-CO')}` : '');

export function RecibidasPanel({ recibidas, enCuadro, cuadroLeido, error }: Props) {
  const [todas, setTodas] = useState(false);
  const lista = todas ? recibidas : recibidas.slice(0, VISIBLES);

  return (
    <section className="border border-gray-200 rounded-xl">
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-gray-100">
        <div>
          <h2 className="text-sm font-semibold text-gray-900">Llegadas por correo</h2>
          <p className="text-xs text-gray-500">
            {error
              ? 'No se pudieron leer'
              : recibidas.length
                ? `${recibidas.length} solicitud(es) en los últimos 60 días`
                : 'Todavía no ha llegado ninguna asignación por correo en los últimos 60 días'}
          </p>
        </div>
        {recibidas.length > VISIBLES && (
          <button
            type="button"
            onClick={() => setTodas((v) => !v)}
            className="px-3 py-1.5 border border-gray-200 text-gray-600 hover:bg-gray-50 rounded-lg text-xs font-medium transition-colors"
          >
            {todas ? 'Ver solo las últimas' : `Ver las ${recibidas.length}`}
          </button>
        )}
      </div>

      {error && <p className="px-4 py-3 text-sm text-red-700">{error}</p>}

      {!error && lista.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
              <tr>
                <th className="text-left font-medium px-4 py-2">Llegó</th>
                <th className="text-left font-medium px-4 py-2">Solicitud</th>
                <th className="text-left font-medium px-4 py-2">Procesos</th>
                <th className="text-left font-medium px-4 py-2">Carpeta</th>
                <th className="text-left font-medium px-4 py-2">Anexos</th>
                <th className="text-left font-medium px-4 py-2">Formulario</th>
                <th className="text-left font-medium px-4 py-2">Cuadro</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {lista.map((r) => {
                // Lo demás de la tabla del correo no cabe en columnas: va como tooltip.
                const datos = [
                  r.tipoAlistamiento && `Tipo: ${r.tipoAlistamiento}`,
                  r.estadoSiniestro && `Estado del siniestro: ${r.estadoSiniestro}`,
                  pesos(r.canon) && `Canon: ${pesos(r.canon)}`,
                  pesos(r.deuda) && `Deuda: ${pesos(r.deuda)}`,
                  r.asuntoCorreo && `Correo: ${r.asuntoCorreo}`,
                ].filter(Boolean).join('\n');
                const estaEnCuadro = enCuadro.has(r.solicitud);
                return (
                  <tr key={r.solicitud} className="hover:bg-gray-50 align-top">
                    <td className="px-4 py-2.5 text-gray-600 whitespace-nowrap">
                      {fechaHora(r.ultimaRecepcion)}
                      {r.vecesRecibida > 1 && (
                        <span className="ml-1 text-xs text-gray-400" title={`Llegó ${r.vecesRecibida} veces; la primera el ${fechaHora(r.recibidaEn)}`}>
                          ×{r.vecesRecibida}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 font-medium text-gray-900" title={datos || undefined}>
                      {r.solicitud}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-wrap gap-1">
                        {r.procesos.length
                          ? r.procesos.map((p) => (
                              <span key={p} className="inline-flex items-center px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 text-xs font-medium">
                                {p}
                              </span>
                            ))
                          : <span className="text-gray-400">{r.tipoAlistamiento || '—'}</span>}
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      <Estado chip={chipCarpeta(r)} detalle={[r.carpetaNombre, r.carpetaDetalle].filter(Boolean).join('\n')} />
                    </td>
                    <td className="px-4 py-2.5"><Estado chip={chipAnexos(r)} detalle={r.anexosDetalle} /></td>
                    <td className="px-4 py-2.5">
                      <Estado
                        chip={chipFormulario(r)}
                        detalle={r.formularioEstado === 'apagado'
                          ? 'El envío del formulario está apagado (LIBERTADOR_FORM_URL vacío en el servidor).'
                          : r.formularioDetalle}
                      />
                    </td>
                    <td className="px-4 py-2.5">
                      {!cuadroLeido
                        ? <span className="text-gray-400">—</span>
                        : estaEnCuadro
                          ? <Estado chip={{ texto: 'Sí', clase: VERDE }} />
                          : <Estado chip={{ texto: 'Falta', clase: AMBAR }} detalle="Aún no aparece en el cuadro jurídico." />}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
