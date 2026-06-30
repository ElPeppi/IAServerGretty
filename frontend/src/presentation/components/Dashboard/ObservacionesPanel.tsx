import { useEffect, useState } from 'react';
import { dashboardApi } from '../../../infrastructure/api/dashboardApi';
import type { Observacion } from '../../../domain/types/dashboard';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';

export function ObservacionesPanel() {
  const [items, setItems] = useState<Observacion[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    dashboardApi.getObservaciones()
      .then(setItems)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
      <div className="flex items-center gap-2.5 mb-3">
        <span className="w-8 h-8 rounded-lg bg-amber-100 flex items-center justify-center text-amber-600">⚠️</span>
        <div>
          <h3 className="text-sm font-semibold text-gray-700">Observaciones</h3>
          <p className="text-xs text-gray-400">Demandas que NO se generaron y por qué</p>
        </div>
        {!loading && items.length > 0 && (
          <span className="ml-auto text-xs font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">
            {items.length}
          </span>
        )}
      </div>

      {loading ? (
        <p className="text-sm text-gray-400">Cargando…</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-gray-400">Sin observaciones: todas las demandas se generaron. ✅</p>
      ) : (
        <ul className="divide-y divide-gray-50 max-h-96 overflow-auto">
          {items.map((o) => (
            <li key={o.id} className="py-2.5 flex gap-3">
              <span className="mt-0.5 text-amber-500 flex-shrink-0">⚠️</span>
              <div className="min-w-0">
                <p className="text-sm text-gray-800">
                  <span className="font-medium">{o.nombre || 'Sin nombre'}</span>
                  <span className="text-gray-400"> · CC {o.cedula}</span>
                </p>
                <p className="text-xs text-gray-500">No se generó la demanda: {o.motivo}</p>
                <p className="text-[11px] text-gray-400 mt-0.5">
                  {o.lote ? `${o.lote} · ` : ''}
                  {format(new Date(o.createdAt), "d MMM yyyy HH:mm", { locale: es })}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
