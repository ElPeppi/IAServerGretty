import { useState } from 'react';
import { asignacionApi, type AsignacionResumen, type GenerarPoderesResult } from '../../../infrastructure/api/asignacionApi';

interface Props {
  asignacion: AsignacionResumen;
  onClose: () => void;
  onDone: () => void;
}

export function GenerarPoderesModal({ asignacion, onClose, onDone }: Props) {
  const [docsEnServidor, setDocsEnServidor] = useState(asignacion.docsEnServidor);
  const [isLoading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GenerarPoderesResult | null>(null);

  const handleGenerar = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await asignacionApi.generarPoderes(asignacion.id, docsEnServidor);
      setResult(res);
      onDone();
    } catch (err: unknown) {
      const data = (err as { response?: { data?: { message?: string; excluidos?: unknown[] } } }).response?.data;
      setError(data?.message ?? (err instanceof Error ? err.message : 'Error al generar poderes'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />

      <div className="relative bg-white dark:bg-gray-800 rounded-2xl shadow-xl w-full max-w-lg z-10">
        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100">
          <div>
            <h2 className="font-bold text-gray-900">Generar poderes</h2>
            <p className="text-xs text-gray-500 mt-0.5">{asignacion.nombre} · {asignacion.totalFilas} cliente(s)</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-6 space-y-4">
          {/* Checklist global: documentos en el servidor */}
          <label className="flex items-start gap-3 p-3 rounded-xl border border-gray-200 cursor-pointer hover:bg-gray-50">
            <input
              type="checkbox"
              checked={docsEnServidor}
              disabled={isLoading || !!result}
              onChange={(e) => setDocsEnServidor(e.target.checked)}
              className="mt-0.5 w-4 h-4 accent-blue-600"
            />
            <span className="text-sm text-gray-700">
              <span className="font-medium">Los documentos ya están en el servidor</span>
              <span className="block text-xs text-gray-500 mt-0.5">
                Si se marca, el Nº de pagaré se lee del documento de cada cliente (y se valida que sea del día
                de la asignación o posterior). Los clientes sin documentos válidos se excluyen. Si no se marca,
                el Nº de pagaré se toma de la OBLIGACIÓN del Excel.
              </span>
            </span>
          </label>

          {error && (
            <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm">{error}</div>
          )}

          {result && (
            <div className="p-3 rounded-xl bg-gray-50 border border-gray-200 text-sm space-y-2 max-h-60 overflow-y-auto">
              <p className="font-medium text-emerald-700">✅ {result.generados} poder(es) generado(s)</p>
              {result.poderUrl && (
                <a href={result.poderUrl} target="_blank" rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-blue-600 hover:underline text-sm font-medium">
                  ⬇ Descargar Word de poderes
                </a>
              )}
              {result.excluidos.length > 0 && (
                <div>
                  <p className="font-medium text-amber-700 mt-2">{result.excluidos.length} excluido(s):</p>
                  <ul className="mt-1 space-y-0.5">
                    {result.excluidos.map((e) => (
                      <li key={e.cedula} className="text-gray-600">
                        <span className="font-medium">{e.cedula}</span>{e.nombre ? ` (${e.nombre})` : ''} — {e.motivo}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          <div className="flex gap-3 pt-1">
            <button type="button" onClick={onClose} disabled={isLoading}
              className="flex-1 px-4 py-2.5 border border-gray-200 rounded-xl text-gray-700 text-sm font-medium hover:bg-gray-50 transition-colors disabled:opacity-50">
              {result ? 'Cerrar' : 'Cancelar'}
            </button>
            {!result && (
              <button type="button" onClick={handleGenerar} disabled={isLoading}
                className="flex-1 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-semibold transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
                {isLoading ? (
                  <>
                    <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Generando…
                  </>
                ) : 'Generar poderes'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
