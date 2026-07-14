import { useEffect, useState, useCallback, useMemo } from 'react';
import { dashboardApi } from '../../../infrastructure/api/dashboardApi';
import type { Observacion } from '../../../domain/types/dashboard';
import { useRefreshOnNotification } from '../../../application/context/NotificationContext';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';

// Una "corrida" (lote que llegó): mismas observaciones se insertan juntas al
// generar. Se agrupan por nombre del Excel (lote) + el minuto de creación, así
// dos envíos del mismo archivo en momentos distintos quedan separados.
interface Grupo {
  key: string;
  lote: string;
  count: number;
  at: string;            // momento de la corrida (la más antigua del grupo)
  items: Observacion[];
}

function agrupar(items: Observacion[]): Grupo[] {
  const mapa = new Map<string, Grupo>();
  for (const o of items) {
    const lote = o.lote || 'Sin lote';
    const minuto = o.createdAt.slice(0, 16); // YYYY-MM-DDTHH:mm → identifica la corrida
    const key = `${lote}__${minuto}`;
    let g = mapa.get(key);
    if (!g) { g = { key, lote, count: 0, at: o.createdAt, items: [] }; mapa.set(key, g); }
    g.items.push(o);
    g.count++;
    if (o.createdAt < g.at) g.at = o.createdAt;
  }
  // Más reciente primero.
  return [...mapa.values()].sort((a, b) => (a.at < b.at ? 1 : -1));
}

export function ObservacionesPanel() {
  const [items, setItems] = useState<Observacion[]>([]);
  const [loading, setLoading] = useState(true);
  const [abiertos, setAbiertos] = useState<Set<string>>(new Set());

  const load = useCallback(() => {
    dashboardApi.getObservaciones()
      .then(setItems)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  // Refrescar cuando termina una generación (aparecen nuevas observaciones).
  useRefreshOnNotification(load);

  const grupos = useMemo(() => agrupar(items), [items]);

  // Abrir el grupo más reciente por defecto (sin pisar lo que el usuario toque).
  useEffect(() => {
    if (grupos.length) setAbiertos((prev) => (prev.size ? prev : new Set([grupos[0].key])));
  }, [grupos]);

  const toggle = (key: string) =>
    setAbiertos((prev) => {
      const n = new Set(prev);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
      <div className="flex items-center gap-2.5 mb-3">
        <span className="w-8 h-8 rounded-lg bg-amber-100 flex items-center justify-center text-amber-600">⚠️</span>
        <div>
          <h3 className="text-sm font-semibold text-gray-700">Observaciones</h3>
          <p className="text-xs text-gray-400">Demandas que NO se generaron, agrupadas por lote</p>
        </div>
        {!loading && items.length > 0 && (
          <span className="ml-auto text-xs font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">
            {grupos.length} lote{grupos.length !== 1 ? 's' : ''} · {items.length}
          </span>
        )}
      </div>

      {loading ? (
        <p className="text-sm text-gray-400">Cargando…</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-gray-400">Sin observaciones: todas las demandas se generaron. ✅</p>
      ) : (
        <div className="space-y-2 max-h-[28rem] overflow-auto pr-1">
          {grupos.map((g) => {
            const open = abiertos.has(g.key);
            return (
              <div key={g.key} className="border border-gray-100 rounded-lg overflow-hidden">
                {/* Cabecera del lote — clic para plegar/desplegar */}
                <button
                  onClick={() => toggle(g.key)}
                  className="w-full flex items-center gap-2.5 px-3 py-2.5 bg-amber-50/60 hover:bg-amber-50 text-left transition-colors"
                >
                  <svg className={`w-3.5 h-3.5 text-amber-600 flex-shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
                    fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
                  </svg>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-gray-800 truncate">📦 {g.lote}</p>
                    <p className="text-[11px] text-gray-500">
                      {format(new Date(g.at), "d MMM yyyy · HH:mm", { locale: es })}
                    </p>
                  </div>
                  <span className="flex-shrink-0 text-xs font-semibold text-amber-700 bg-white border border-amber-200 rounded-full px-2 py-0.5">
                    {g.count}
                  </span>
                </button>

                {/* Detalle del lote */}
                {open && (
                  <ul className="divide-y divide-gray-50 px-3">
                    {g.items.map((o) => (
                      <li key={o.id} className="py-2.5 flex gap-3">
                        <span className="mt-0.5 text-amber-500 flex-shrink-0">⚠️</span>
                        <div className="min-w-0">
                          <p className="text-sm text-gray-800">
                            <span className="font-medium">{o.nombre || 'Sin nombre'}</span>
                            <span className="text-gray-400"> · CC {o.cedula}</span>
                          </p>
                          <p className="text-xs text-gray-500">No se generó la demanda: {o.motivo}</p>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
