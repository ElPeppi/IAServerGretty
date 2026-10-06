import { useMemo, useState } from 'react';
import { libertadorApi, type LibertadorCaso } from '../../../infrastructure/api/libertadorApi';

/**
 * Selector de solicitudes para pedir estados de cuenta.
 *
 * Va por SOLICITUD, no por caso: un mismo estado de cuenta sirve para todos los
 * procesos de esa solicitud (ejecutivo, restitución, conciliación…), así que
 * pedirlo por cada fila del cuadro sería entrar al portal varias veces para
 * traer lo mismo. Aquí las solicitudes llegan ya deduplicadas.
 */

/** "05/03/2025" → timestamp. 0 si no hay fecha legible (no se puede comparar). */
function aFecha(dmy: string): number {
  const m = String(dmy || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? Date.UTC(+m[3], +m[2] - 1, +m[1]) : 0;
}

/** El <input type="date"> habla ISO; el cuadro escribe DD/MM/AAAA. */
function isoATimestamp(iso: string): number {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : 0;
}

/**
 * Minúsculas y sin tildes: en el cuadro conviven "MUÑOZ" y "MUNOZ", "Pérez" y
 * "PEREZ". Buscar "munoz" tiene que encontrarlos todos o el buscador no sirve.
 */
function normaliza(s: string): string {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

interface SolicitudAgrupada {
  solicitud: string;
  recibido: string;
  recibidoTs: number;
  demandado: string;
  demandante: string;
  cedula: string;
  procesos: string[];
  algunaSinDocumentacion: boolean;
  /** Todo lo buscable ya normalizado: se arma una vez, no en cada pulsación. */
  buscable: string;
}

export function EstadosCuentaModal({ casos, onClose }: { casos: LibertadorCaso[]; onClose: () => void }) {
  const [busqueda, setBusqueda] = useState('');
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');
  const [seleccion, setSeleccion] = useState<Set<string>>(new Set());
  const [enviando, setEnviando] = useState(false);
  const [aviso, setAviso] = useState<{ tipo: 'ok' | 'error'; texto: string } | null>(null);

  // Una entrada por solicitud, con sus procesos juntos.
  const solicitudes = useMemo<SolicitudAgrupada[]>(() => {
    const porNumero = new Map<string, SolicitudAgrupada>();
    for (const c of casos) {
      const ya = porNumero.get(c.solicitud);
      if (ya) {
        if (c.proceso && !ya.procesos.includes(c.proceso)) ya.procesos.push(c.proceso);
        if (!c.documentacionCompleta) ya.algunaSinDocumentacion = true;
        continue;
      }
      porNumero.set(c.solicitud, {
        solicitud: c.solicitud,
        recibido: c.recibido,
        recibidoTs: aFecha(c.recibido),
        demandado: c.demandado,
        demandante: c.demandante,
        cedula: c.cedula,
        procesos: c.proceso ? [c.proceso] : [],
        algunaSinDocumentacion: !c.documentacionCompleta,
        buscable: '',
      });
    }
    // El texto buscable se arma al final, cuando la solicitud ya tiene TODOS sus
    // procesos: hacerlo en el primer caso dejaría fuera los de las filas siguientes.
    for (const s of porNumero.values()) {
      s.buscable = normaliza(
        [s.solicitud, s.cedula, s.demandado, s.demandante, s.recibido, ...s.procesos].join(' '),
      );
    }
    // Más recientes primero: es el orden en que la oficina las persigue.
    return [...porNumero.values()].sort((a, b) => b.recibidoTs - a.recibidoTs);
  }, [casos]);

  const visibles = useMemo(() => {
    const tDesde = isoATimestamp(desde);
    const tHasta = isoATimestamp(hasta);
    // Varias palabras = todas deben aparecer ("pulido 2026", "ejecutivo munoz").
    // Así se acota sin tener que acertar el orden exacto del texto.
    const terminos = normaliza(busqueda).split(/\s+/).filter(Boolean);

    if (!tDesde && !tHasta && !terminos.length) return solicitudes;
    return solicitudes.filter((s) => {
      if (terminos.some((t) => !s.buscable.includes(t))) return false;
      if (!tDesde && !tHasta) return true;
      // Sin fecha legible no se puede ubicar en el rango: se deja fuera mientras
      // haya filtro, en vez de colarla y que parezca que sí cumple.
      if (!s.recibidoTs) return false;
      if (tDesde && s.recibidoTs < tDesde) return false;
      if (tHasta && s.recibidoTs > tHasta) return false;
      return true;
    });
  }, [solicitudes, busqueda, desde, hasta]);

  const visiblesSeleccionadas = visibles.filter((s) => seleccion.has(s.solicitud)).length;
  const todasVisiblesMarcadas = visibles.length > 0 && visiblesSeleccionadas === visibles.length;
  // La selección sobrevive al filtro (si no, buscar de una en una obligaría a
  // generar de una en una). Pero entonces puede haber marcadas que no se ven, y
  // eso hay que decirlo: si no, el contador dice 5 y la lista muestra 0 marcadas.
  const hayFiltro = Boolean(busqueda.trim() || desde || hasta);
  const ocultasSeleccionadas = seleccion.size - visiblesSeleccionadas;

  const limpiarFiltros = () => { setBusqueda(''); setDesde(''); setHasta(''); };

  const alternar = (solicitud: string) => {
    setSeleccion((prev) => {
      const siguiente = new Set(prev);
      if (siguiente.has(solicitud)) siguiente.delete(solicitud);
      else siguiente.add(solicitud);
      return siguiente;
    });
  };

  // Marca/desmarca solo lo que se está viendo: con un filtro de fechas puesto,
  // tocar lo que quedó fuera sería invisible y sorprendente.
  const alternarTodas = () => {
    setSeleccion((prev) => {
      const siguiente = new Set(prev);
      for (const s of visibles) {
        if (todasVisiblesMarcadas) siguiente.delete(s.solicitud);
        else siguiente.add(s.solicitud);
      }
      return siguiente;
    });
  };

  const generar = async () => {
    setEnviando(true);
    setAviso(null);
    try {
      const res = await libertadorApi.estadosCuenta([...seleccion]);
      setAviso({ tipo: 'ok', texto: res.message });
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } }).response?.data?.message;
      setAviso({ tipo: 'error', texto: msg ?? (err instanceof Error ? err.message : 'No se pudo iniciar la consulta.') });
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-xl w-full max-w-3xl flex flex-col max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6 pb-4 border-b border-gray-100">
          <h3 className="text-base font-bold text-gray-900">Generar estados de cuenta</h3>
          <p className="text-sm text-gray-500 mt-0.5">
            {hayFiltro
              ? `${visibles.length} de ${solicitudes.length} solicitud(es)`
              : `${solicitudes.length} solicitud(es)`}
            {' · un estado de cuenta cubre todos los procesos de la misma'}
          </p>

          <div className="flex flex-wrap items-end gap-3 mt-4">
            <label className="block flex-1 min-w-[16rem]">
              <span className="text-xs font-medium text-gray-600">Buscar</span>
              <input
                type="search"
                // El foco va aquí al abrir: el caso normal es venir a por una
                // solicitud concreta, no a recorrer las 400 de la lista.
                autoFocus
                value={busqueda}
                onChange={(e) => setBusqueda(e.target.value)}
                placeholder="Nº de solicitud, cédula, demandado, demandante o proceso"
                className="mt-1 block w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-gray-600">Recibido desde</span>
              <input
                type="date" value={desde} onChange={(e) => setDesde(e.target.value)}
                className="mt-1 block px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-gray-600">hasta</span>
              <input
                type="date" value={hasta} onChange={(e) => setHasta(e.target.value)}
                className="mt-1 block px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
              />
            </label>
            {hayFiltro && (
              <button
                type="button"
                onClick={limpiarFiltros}
                className="px-3 py-1.5 border border-gray-200 text-gray-600 hover:bg-gray-50 rounded-lg text-xs font-medium transition-colors"
              >
                Limpiar filtros
              </button>
            )}
            <button
              type="button"
              onClick={alternarTodas}
              disabled={!visibles.length}
              className="px-3 py-1.5 border border-gray-200 text-gray-600 hover:bg-gray-50 rounded-lg text-xs font-medium transition-colors disabled:opacity-40"
            >
              {todasVisiblesMarcadas ? 'Quitar todas' : `Marcar las ${visibles.length} visibles`}
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-3">
          {visibles.length === 0 ? (
            <p className="text-sm text-gray-400 py-10 text-center">
              {busqueda.trim()
                ? `Ninguna solicitud coincide con "${busqueda.trim()}".`
                : 'Ninguna solicitud recibida en ese rango de fechas.'}
            </p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {visibles.map((s) => (
                <li key={s.solicitud}>
                  <label className="flex items-center gap-3 py-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={seleccion.has(s.solicitud)}
                      onChange={() => alternar(s.solicitud)}
                      className="w-4 h-4 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                    />
                    <span className="font-medium text-gray-900 w-28 shrink-0">{s.solicitud}</span>
                    <span className="text-gray-500 text-sm w-24 shrink-0">{s.recibido || '—'}</span>
                    <span className="text-gray-600 text-sm truncate flex-1" title={s.demandado}>
                      {s.demandado || '—'}
                    </span>
                    <span className="text-xs text-gray-400 shrink-0">
                      {s.procesos.length} proceso{s.procesos.length === 1 ? '' : 's'}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="p-6 pt-4 border-t border-gray-100 flex items-center justify-between gap-3">
          <span className="text-sm text-gray-500">
            {seleccion.size} seleccionada(s)
            {ocultasSeleccionadas > 0 && (
              <>
                <span className="text-amber-600"> ({ocultasSeleccionadas} fuera del filtro)</span>
                <button
                  type="button"
                  onClick={limpiarFiltros}
                  className="ml-2 text-sky-600 hover:underline text-xs font-medium"
                >
                  ver todas
                </button>
              </>
            )}
            {seleccion.size > 0 && (
              <button
                type="button"
                onClick={() => setSeleccion(new Set())}
                className="ml-2 text-gray-400 hover:text-gray-600 hover:underline text-xs font-medium"
              >
                limpiar selección
              </button>
            )}
            {aviso && (
              <span className={`ml-3 ${aviso.tipo === 'ok' ? 'text-emerald-700' : 'text-red-600'}`}>
                {aviso.texto}
              </span>
            )}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 border border-gray-200 text-gray-700 hover:bg-gray-50 rounded-xl text-sm font-medium transition-colors"
            >
              Cerrar
            </button>
            <button
              type="button"
              onClick={() => void generar()}
              disabled={enviando || seleccion.size === 0}
              className="px-4 py-2 bg-sky-600 hover:bg-sky-700 text-white rounded-xl text-sm font-medium transition-colors disabled:opacity-40"
            >
              {enviando ? 'Enviando…' : `Generar (${seleccion.size})`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
