import { useMemo, useState } from 'react';
import { useAsignaciones } from '../../application/hooks/useAsignaciones';
import { useRefreshOnNotification } from '../../application/context/NotificationContext';
import { asignacionApi, type AsignacionResumen } from '../../infrastructure/api/asignacionApi';
import { SubirAsignacionModal } from '../components/Asignaciones/SubirAsignacionModal';
import { GenerarPoderesModal } from '../components/Asignaciones/GenerarPoderesModal';
import { GenerarDemandasModal } from '../components/Asignaciones/GenerarDemandasModal';
import { PoderFaltanteModal } from '../components/Asignaciones/PoderFaltanteModal';

function fmtFecha(s: string | null): string {
  if (!s) return '—';
  const d = new Date(s);
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function AsignacionesPage() {
  const { asignaciones, isLoading, error, refetch } = useAsignaciones();

  // La generación corre en segundo plano y responde 202 al instante, así que la
  // tabla se quedaría congelada mostrando pendientes que ya se generaron. El
  // backend emite una notificación por demanda lista: cada una recarga la lista,
  // y el contador baja solo mientras el lote avanza.
  useRefreshOnNotification(refetch);
  const [showSubir, setShowSubir] = useState(false);
  const [poderTarget, setPoderTarget] = useState<AsignacionResumen | null>(null);   // Generar poderes
  const [demandasTarget, setDemandasTarget] = useState<AsignacionResumen | null>(null); // modal generar demandas
  const [faltanteTarget, setFaltanteTarget] = useState<AsignacionResumen | null>(null); // popup poder faltante
  const [actualizando, setActualizando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const [fechaAsc, setFechaAsc] = useState(false); // false = más recientes primero
  const [demandante, setDemandante] = useState('');  // '' = todos

  // Demandantes que hay DE VERDAD en la lista, no una lista fija de bancos: así
  // el filtro crece solo cuando entre un banco nuevo y nunca ofrece uno vacío.
  const demandantes = useMemo(
    () => [...new Set(asignaciones.map((a) => a.banco).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es')),
    [asignaciones],
  );

  const filtradas = useMemo(
    () => (demandante ? asignaciones.filter((a) => a.banco === demandante) : asignaciones),
    [asignaciones, demandante],
  );

  // El backend ordena por `createdAt`, pero todas las asignaciones entran en el mismo
  // escaneo de Drive: el timestamp empata y queda el orden alfabético del scan. Se
  // ordena aquí por `fechaAsignacion`, que es la fecha que le importa al usuario.
  const ordenadas = useMemo(() => {
    const ts = (a: AsignacionResumen): number | null => {
      if (!a.fechaAsignacion) return null;
      const t = new Date(a.fechaAsignacion).getTime();
      return isNaN(t) ? null : t;
    };
    return [...filtradas].sort((a, b) => {
      const ta = ts(a);
      const tb = ts(b);
      // Las que no tienen fecha legible van al final en AMBOS sentidos: si no,
      // al invertir el orden aparecerían de primeras y taparían lo reciente.
      if (ta === null && tb === null) return a.nombre.localeCompare(b.nombre, 'es');
      if (ta === null) return 1;
      if (tb === null) return -1;
      return fechaAsc ? ta - tb : tb - ta;
    });
  }, [filtradas, fechaAsc]);

  const handleActualizar = async () => {
    setActualizando(true);
    setAviso(null);
    try {
      const res = await asignacionApi.actualizar();
      setAviso(`${res.agregadas} asignación(es) nueva(s) de ${res.escaneadas} en el servidor.`);
      await refetch();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } }).response?.data?.message;
      setAviso(msg ?? (err instanceof Error ? err.message : 'Error al actualizar'));
    } finally {
      setActualizando(false);
    }
  };

  // "Generar demandas": si no hay poder cacheado → popup (subir/generar). Si hay →
  // abre el modal (tipo de demanda + selección de personas). El modal reusa el poder
  // y, si por alguna razón no hay, recibe el 409 y volvemos al popup de poder faltante.
  const handleGenerarDemandas = (a: AsignacionResumen) => {
    if (!a.tienePoder) { setFaltanteTarget(a); return; }
    setAviso(null);
    setDemandasTarget(a);
  };

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Asignaciones</h1>
          <p className="text-gray-500 text-sm mt-0.5">
            {ordenadas.length} asignación(es)
            {demandante ? ` de ${demandante}` : ' cacheada(s)'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="sr-only" htmlFor="filtro-demandante">Demandante</label>
          <select
            id="filtro-demandante"
            value={demandante}
            onChange={(e) => setDemandante(e.target.value)}
            className="px-3 py-2 border border-gray-200 rounded-xl text-sm text-gray-700 bg-white hover:bg-gray-50 transition-colors"
          >
            <option value="">Todos los demandantes</option>
            {demandantes.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
          <button onClick={handleActualizar} disabled={actualizando}
            className="flex items-center gap-2 px-4 py-2 border border-gray-200 text-gray-700 hover:bg-gray-50 rounded-xl text-sm font-medium transition-colors disabled:opacity-50">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            {actualizando ? 'Actualizando…' : 'Actualizar asignaciones'}
          </button>
          <button onClick={() => setShowSubir(true)}
            className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-xl text-sm font-medium transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
            Subir asignación
          </button>
        </div>
      </div>

      {aviso && (
        <div className="mb-4 p-3 rounded-xl bg-blue-50 border border-blue-200 text-blue-700 text-sm">{aviso}</div>
      )}

      {isLoading ? (
        <div className="space-y-3">{[...Array(4)].map((_, i) => <div key={i} className="animate-pulse bg-gray-100 rounded-xl h-16" />)}</div>
      ) : error ? (
        <div className="text-center py-16 text-red-500">{error}</div>
      ) : ordenadas.length === 0 ? (
        <div className="text-center py-16">
          {demandante ? (
            <>
              <p className="text-gray-500 font-medium">No hay asignaciones de {demandante}</p>
              <button
                type="button"
                onClick={() => setDemandante('')}
                className="text-blue-600 hover:underline text-sm mt-1"
              >
                Ver todos los demandantes
              </button>
            </>
          ) : (
            <>
              <p className="text-gray-500 font-medium">No hay asignaciones</p>
              <p className="text-gray-400 text-sm mt-1">Sube el Excel de asignación o pulsa "Actualizar asignaciones".</p>
            </>
          )}
        </div>
      ) : (
        <div className="overflow-x-auto border border-gray-200 rounded-xl">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
              <tr>
                <th className="text-left font-medium px-4 py-3">Asignación</th>
                <th className="text-left font-medium px-4 py-3">Demandante</th>
                <th className="text-left font-medium px-4 py-3">
                  <button
                    type="button"
                    onClick={() => setFechaAsc((v) => !v)}
                    title={fechaAsc ? 'Más antiguas primero — clic para invertir' : 'Más recientes primero — clic para invertir'}
                    className="inline-flex items-center gap-1 uppercase hover:text-gray-700 transition-colors"
                  >
                    Fecha
                    <span aria-hidden="true" className="text-[0.65rem]">{fechaAsc ? '▲' : '▼'}</span>
                  </button>
                </th>
                <th className="text-center font-medium px-4 py-3">Clientes</th>
                <th className="text-center font-medium px-4 py-3">Poder</th>
                <th className="text-center font-medium px-4 py-3">Demandas</th>
                <th className="text-center font-medium px-4 py-3">Pendientes</th>
                <th className="text-right font-medium px-4 py-3">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {ordenadas.map((a) => (
                <tr key={a.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900">{a.nombre}</td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 text-xs font-medium">
                      {a.banco}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{fmtFecha(a.fechaAsignacion)}</td>
                  <td className="px-4 py-3 text-center text-gray-600">{a.totalFilas}</td>
                  <td className="px-4 py-3 text-center">
                    {a.tienePoder ? (
                      <span className="inline-flex items-center gap-1 text-emerald-700">
                        ✓ {a.poderesCacheados}
                        {a.poderUrl && (
                          <a href={a.poderUrl} target="_blank" rel="noreferrer" title="Descargar Word de poderes"
                            className="ml-1 text-blue-600 hover:underline">⬇</a>
                        )}
                      </span>
                    ) : <span className="text-gray-400">—</span>}
                  </td>
                  <td className="px-4 py-3 text-center text-gray-600">{a.demandas}</td>
                  <td className="px-4 py-3 text-center">
                    {a.demandasPendientes === 0 ? (
                      <span className="inline-flex items-center gap-1 text-emerald-700 font-medium">✓ Completa</span>
                    ) : (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 font-medium">
                        {a.demandasPendientes}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      <button onClick={() => setPoderTarget(a)}
                        className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-medium transition-colors">
                        {a.tienePoder ? 'Regenerar poderes' : 'Generar poderes'}
                      </button>
                      <button onClick={() => handleGenerarDemandas(a)}
                        className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-medium transition-colors">
                        Generar demandas
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showSubir && <SubirAsignacionModal onClose={() => setShowSubir(false)} onSuccess={refetch} />}
      {poderTarget && (
        <GenerarPoderesModal asignacion={poderTarget} onClose={() => setPoderTarget(null)} onDone={refetch} />
      )}
      {demandasTarget && (
        <GenerarDemandasModal
          asignacion={demandasTarget}
          onClose={() => setDemandasTarget(null)}
          onDone={(msg) => { setDemandasTarget(null); setAviso(msg); void refetch(); }}
          onSinPoder={() => { const a = demandasTarget; setDemandasTarget(null); setFaltanteTarget(a); }}
        />
      )}
      {faltanteTarget && (
        <PoderFaltanteModal
          asignacion={faltanteTarget}
          onClose={() => setFaltanteTarget(null)}
          onGenerar={() => { const a = faltanteTarget; setFaltanteTarget(null); setPoderTarget(a); }}
          onSubido={() => { setFaltanteTarget(null); refetch(); }}
        />
      )}
    </div>
  );
}
