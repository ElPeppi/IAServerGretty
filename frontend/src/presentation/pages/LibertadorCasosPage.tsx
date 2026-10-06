import { useCallback, useEffect, useMemo, useState } from 'react';
import { libertadorApi, type LibertadorCaso } from '../../infrastructure/api/libertadorApi';
import { EstadosCuentaModal } from '../components/Libertador/EstadosCuentaModal';

/**
 * Casos de Libertador. A diferencia de Finandina no hay lotes que subir: el
 * cuadro de casos es la fuente y la unidad es la SOLICITUD.
 *
 * La pantalla existe para perseguir documentación: muestra ÚNICAMENTE los casos
 * cuya columna "DOCUMENTACION COMPLETA" no dice SI. No es un filtro que se pueda
 * apagar, es su alcance. El mismo número de solicitud sale en varias filas a
 * propósito: una persona puede tener abiertos un ejecutivo y una restitución a la
 * vez, y son procesos distintos.
 *
 * El estado de cuenta NO es una acción por fila: uno solo cubre todos los
 * procesos de la solicitud, así que se pide desde el botón de arriba.
 */

// 503 significa "el cuadro todavía no está configurado": es un estado esperable
// de la instalación, no un error de la aplicación, así que se distingue del
// resto para avisar en ámbar y no en rojo.
type ErrorCarga = { mensaje: string; sinConfigurar: boolean };

// El buscador compara contra nombres que el cuadro escribe en mayúsculas y con
// tildes irregulares, así que se normaliza todo antes de comparar.
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** "05/03/2025" → timestamp. 0 si no hay fecha legible (no se puede comparar). */
function aFecha(dmy: string): number {
  const m = String(dmy || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? Date.UTC(+m[3], +m[2] - 1, +m[1]) : 0;
}

/** El input de tipo date habla ISO; el cuadro escribe DD/MM/AAAA. */
function isoATimestamp(iso: string): number {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : 0;
}

export function LibertadorCasosPage() {
  const [casos, setCasos] = useState<LibertadorCaso[]>([]);
  const [fuente, setFuente] = useState('');
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<ErrorCarga | null>(null);

  const [busqueda, setBusqueda] = useState('');
  const [proceso, setProceso] = useState('');   // '' = todos los tipos
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');
  // Por defecto lo más reciente arriba. Se invierte con un clic en la columna
  // "Recibido": perseguir documentación admite las dos lecturas —lo que acaba de
  // entrar, o lo que lleva más tiempo esperando— y depende de cómo trabaje cada uno.
  const [masRecientePrimero, setMasRecientePrimero] = useState(true);

  const [modalEstados, setModalEstados] = useState(false);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    try {
      const res = await libertadorApi.casos();
      setCasos(res.casos);
      setFuente(res.fuente);
    } catch (err: unknown) {
      const res = (err as { response?: { status?: number; data?: { message?: string } } }).response;
      setError({
        mensaje: res?.data?.message ?? (err instanceof Error ? err.message : 'No se pudieron cargar los casos'),
        sinConfigurar: res?.status === 503,
      });
      setCasos([]);
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => { void cargar(); }, [cargar]);

  // La pantalla SOLO trata los casos sin documentación: el resto no se muestra ni
  // se puede pedir. De aquí para abajo "los casos" son estos, no el cuadro entero.
  const pendientes = useMemo(() => casos.filter((c) => !c.documentacionCompleta), [casos]);

  // Los tipos salen de los datos, no de una lista fija: el cuadro va sumando
  // procesos nuevos (residual, reorganización…) y una lista a mano se quedaría corta.
  // Solo los de los pendientes: ofrecer un proceso que no deja ninguna fila confunde.
  const tiposProceso = useMemo(
    () => [...new Set(pendientes.map((c) => c.proceso).filter(Boolean))].sort(),
    [pendientes],
  );

  // El cuadro completo ya está en memoria: filtrar en cliente evita ir al
  // servidor por cada tecla y deja buscar aunque el cuadro deje de responder.
  const filtrados = useMemo(() => {
    const q = norm(busqueda.trim());
    const tDesde = isoATimestamp(desde);
    const tHasta = isoATimestamp(hasta);

    return pendientes.filter((c) => {
      if (proceso && c.proceso !== proceso) return false;

      if (tDesde || tHasta) {
        const ts = aFecha(c.recibido);
        // Sin fecha legible no se puede ubicar en el rango: se deja fuera mientras
        // haya filtro, en vez de colarla y que parezca que sí cumple.
        if (!ts) return false;
        if (tDesde && ts < tDesde) return false;
        if (tHasta && ts > tHasta) return false;
      }

      if (!q) return true;
      // Un mismo campo sirve para solicitud, cédula, demandante y demandado: el
      // usuario llega con el número o con el nombre, pero nunca sabe de antemano
      // en qué columna está lo que le dictaron.
      return norm(c.solicitud).includes(q)
        || norm(c.cedula).includes(q)
        || norm(c.demandante).includes(q)
        || norm(c.demandado).includes(q);
    }).sort((a, b) => {
      const fa = aFecha(a.recibido);
      const fb = aFecha(b.recibido);
      // Las que no traen fecha legible van al final en ambos sentidos: no se
      // pueden ordenar y arriba solo estorbarían.
      if (!fa && !fb) return 0;
      if (!fa) return 1;
      if (!fb) return -1;
      return masRecientePrimero ? fb - fa : fa - fb;
    });
  }, [pendientes, busqueda, proceso, desde, hasta, masRecientePrimero]);

  const hayFiltros = !!(busqueda.trim() || proceso || desde || hasta);
  const limpiar = () => { setBusqueda(''); setProceso(''); setDesde(''); setHasta(''); };

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Casos Libertador</h1>
          <p className="text-gray-500 text-sm mt-0.5">
            {/* Un "0 caso(s)" junto al aviso de error se lee como que el cuadro
                está vacío, que es otra cosa: si no se pudo leer, no se cuenta. */}
            {cargando
              ? 'Leyendo el cuadro de casos…'
              : error
                ? 'Sin datos del cuadro de casos'
                : filtrados.length !== pendientes.length
                  ? `${filtrados.length} de ${pendientes.length} sin documentación`
                  : `${pendientes.length} caso(s) sin documentación`}
            {!error && fuente && ` · ${fuente}`}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setModalEstados(true)}
            disabled={cargando || casos.length === 0}
            className="px-4 py-2 bg-sky-600 hover:bg-sky-700 text-white rounded-xl text-sm font-medium transition-colors disabled:opacity-40"
          >
            Generar estados de cuenta
          </button>
          <button
            onClick={() => void cargar()}
            disabled={cargando}
            className="flex items-center gap-2 px-4 py-2 border border-gray-200 text-gray-700 hover:bg-gray-50 rounded-xl text-sm font-medium transition-colors disabled:opacity-50"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            {cargando ? 'Cargando…' : 'Actualizar'}
          </button>
        </div>
      </div>

      {/* Sin pendientes no hay nada que filtrar: la barra solo estorbaría encima
          del aviso de error o del vacío. */}
      {pendientes.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            placeholder="Nº de solicitud, cédula o nombre"
            className="flex-1 min-w-[220px] px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
          />

          <select
            value={proceso}
            onChange={(e) => setProceso(e.target.value)}
            className="px-3 py-2.5 border border-gray-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-purple-500"
          >
            <option value="">Todos los procesos</option>
            {tiposProceso.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>

          <span className="flex items-center gap-1.5 text-xs text-gray-500">
            Recibido
            <input
              type="date" value={desde} onChange={(e) => setDesde(e.target.value)}
              className="px-2.5 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
            />
            a
            <input
              type="date" value={hasta} onChange={(e) => setHasta(e.target.value)}
              className="px-2.5 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
            />
          </span>

          {hayFiltros && (
            <button
              type="button"
              onClick={limpiar}
              className="px-3 py-2 border border-gray-200 text-gray-600 hover:bg-gray-50 rounded-xl text-xs font-medium transition-colors"
            >
              Limpiar
            </button>
          )}
        </div>
      )}

      {error && (
        <div
          className={`p-4 rounded-xl border text-sm ${
            error.sinConfigurar
              ? 'bg-amber-50 border-amber-200 text-amber-800'
              : 'bg-red-50 border-red-200 text-red-700'
          }`}
        >
          <p className="font-medium">
            {error.sinConfigurar ? 'El cuadro de casos aún no está disponible' : 'No se pudieron cargar los casos'}
          </p>
          <p className="mt-0.5">{error.mensaje}</p>
          <button
            type="button"
            onClick={() => void cargar()}
            className="mt-3 px-3 py-1.5 bg-purple-600 hover:bg-purple-700 text-white rounded-lg text-xs font-medium transition-colors"
          >
            Reintentar
          </button>
        </div>
      )}

      {cargando ? (
        <div className="space-y-3">
          {[...Array(6)].map((_, i) => <div key={i} className="animate-pulse bg-gray-100 rounded-xl h-12" />)}
        </div>
      ) : !error && pendientes.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-gray-500 font-medium">
            {casos.length === 0 ? 'No hay casos de Libertador' : 'Ningún caso pendiente de documentación'}
          </p>
          <p className="text-gray-400 text-sm mt-1">
            {casos.length === 0
              ? 'El cuadro de casos está vacío o todavía no tiene filas.'
              : `Los ${casos.length} casos del cuadro tienen la documentación completa.`}
          </p>
        </div>
      ) : !error && filtrados.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-gray-500 font-medium">Ningún caso con esos filtros</p>
          <button type="button" onClick={limpiar} className="text-blue-600 hover:underline text-sm mt-1">
            Quitar los filtros
          </button>
        </div>
      ) : filtrados.length > 0 ? (
        <div className="overflow-x-auto border border-gray-200 rounded-xl">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
              <tr>
                <th className="text-left font-medium px-4 py-3">Solicitud</th>
                <th className="text-left font-medium px-4 py-3">Demandante</th>
                <th className="text-left font-medium px-4 py-3">Demandado(s)</th>
                <th className="text-left font-medium px-4 py-3">Proceso</th>
                <th className="text-left font-medium px-4 py-3">
                  <button
                    type="button"
                    onClick={() => setMasRecientePrimero((v) => !v)}
                    title={masRecientePrimero ? 'Ordenado de más reciente a más antiguo' : 'Ordenado de más antiguo a más reciente'}
                    className="inline-flex items-center gap-1 uppercase hover:text-gray-700 transition-colors"
                  >
                    Recibido
                    <span aria-hidden="true">{masRecientePrimero ? '↓' : '↑'}</span>
                  </button>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtrados.map((c) => (
                // `observaciones` es un texto largo (deuda, estado del siniestro,
                // histórico…): no cabe en una columna, así que va como tooltip de
                // la fila completa.
                <tr key={`${c.solicitud}-${c.fila}`} className="hover:bg-gray-50 align-top" title={c.observaciones || undefined}>
                  <td className="px-4 py-3 font-medium text-gray-900 whitespace-nowrap">{c.solicitud}</td>
                  <td className="px-4 py-3 text-gray-600">{c.demandante || '—'}</td>
                  {/* El cuadro mete varios demandados en una sola celda separados
                      por "/": se parten para que se lean como la lista que son. */}
                  <td className="px-4 py-3 text-gray-900">
                    {c.demandado
                      ? c.demandado.split('/').map((n) => n.trim()).filter(Boolean).map((n, i) => (
                          <div key={i}>{n}</div>
                        ))
                      : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 text-xs font-medium whitespace-nowrap">
                      {c.proceso || '—'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{c.recibido || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {modalEstados && (
        <EstadosCuentaModal casos={casos} onClose={() => setModalEstados(false)} />
      )}
    </div>
  );
}
