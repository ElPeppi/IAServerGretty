import { useState, useEffect, useMemo } from 'react';
import { asignacionApi, type AsignacionResumen, type AsignacionPersona, type GenerarPoderesResult } from '../../../infrastructure/api/asignacionApi';

interface Props {
  asignacion: AsignacionResumen;
  onClose: () => void;
  onDone: () => void;
}

// Solo el proceso ejecutivo singular genera poderes (la plantilla es de ese proceso;
// el motor excluye los demás). Los otros tipos se muestran como referencia.
const TIPO_GENERABLE = 'EJECUTIVO SINGULAR';

export function GenerarPoderesModal({ asignacion, onClose, onDone }: Props) {
  const [docsEnServidor, setDocsEnServidor] = useState(asignacion.docsEnServidor);
  const [personas, setPersonas] = useState<AsignacionPersona[]>([]);
  const [cargando, setCargando] = useState(true);
  const [tipo, setTipo] = useState('');
  const [seleccion, setSeleccion] = useState<Set<string>>(new Set()); // cédulas marcadas; vacío = todas del tipo
  const [isLoading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GenerarPoderesResult | null>(null);

  useEffect(() => {
    let cancelado = false;
    setCargando(true);
    asignacionApi
      .personas(asignacion.id)
      .then((p) => {
        if (cancelado) return;
        setPersonas(p);
        const tipos = [...new Set(p.map((x) => x.tipo))];
        setTipo(tipos.includes(TIPO_GENERABLE) ? TIPO_GENERABLE : (tipos[0] ?? ''));
      })
      .catch((err: unknown) => {
        if (cancelado) return;
        const msg = (err as { response?: { data?: { message?: string } } }).response?.data?.message;
        setError(msg ?? (err instanceof Error ? err.message : 'Error al cargar personas'));
      })
      .finally(() => { if (!cancelado) setCargando(false); });
    return () => { cancelado = true; };
  }, [asignacion.id]);

  const tipos = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of personas) m.set(p.tipo, (m.get(p.tipo) ?? 0) + 1);
    return [...m.entries()]
      .map(([nombre, count]) => ({ nombre, count }))
      .sort((a, b) => (a.nombre === TIPO_GENERABLE ? -1 : b.nombre === TIPO_GENERABLE ? 1 : a.nombre.localeCompare(b.nombre)));
  }, [personas]);

  const personasTipo = useMemo(() => personas.filter((p) => p.tipo === tipo), [personas, tipo]);
  const generable = tipo === TIPO_GENERABLE;

  useEffect(() => { setSeleccion(new Set()); }, [tipo]);

  const cedulasAEnviar = seleccion.size ? [...seleccion] : personasTipo.map((p) => p.cedula);

  const togglePersona = (cedula: string) => {
    setSeleccion((prev) => {
      const next = new Set(prev);
      if (next.has(cedula)) next.delete(cedula); else next.add(cedula);
      return next;
    });
  };

  const handleGenerar = async () => {
    if (!generable) { setError('Los poderes solo se generan para "Ejecutivo singular".'); return; }
    if (!cedulasAEnviar.length) { setError('No hay personas de este tipo.'); return; }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await asignacionApi.generarPoderes(asignacion.id, docsEnServidor, cedulasAEnviar);
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
            <p className="text-xs text-gray-500 mt-0.5 truncate max-w-sm">{asignacion.nombre}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-6 space-y-4">
          {!result && (
            <>
              {/* Selector de tipo de demanda */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Tipo de demanda</label>
                <select
                  value={tipo}
                  onChange={(e) => setTipo(e.target.value)}
                  disabled={isLoading || cargando}
                  className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-50"
                >
                  {cargando ? (
                    <option>Cargando…</option>
                  ) : (
                    tipos.map((t) => (
                      <option key={t.nombre} value={t.nombre}>
                        {t.nombre} ({t.count}){t.nombre !== TIPO_GENERABLE ? ' — no soportado aún' : ''}
                      </option>
                    ))
                  )}
                </select>
                {!cargando && !generable && (
                  <p className="text-xs text-amber-600 mt-1">
                    Los poderes solo se generan para <b>Ejecutivo singular</b>. Este tipo es solo referencia.
                  </p>
                )}
              </div>

              {/* Checklist de personas del tipo. Nada marcado = todas. */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block text-sm font-medium text-gray-700">
                    Personas <span className="text-gray-400 font-normal">(sin marcar = todas)</span>
                  </label>
                  {personasTipo.length > 0 && seleccion.size > 0 && (
                    <button type="button" onClick={() => setSeleccion(new Set())}
                      className="text-xs text-blue-600 hover:text-blue-700 font-medium">Limpiar</button>
                  )}
                </div>
                <div className="border border-gray-200 rounded-xl max-h-44 overflow-y-auto divide-y divide-gray-100">
                  {cargando ? (
                    <p className="p-3 text-sm text-gray-400">Cargando personas…</p>
                  ) : personasTipo.length === 0 ? (
                    <p className="p-3 text-sm text-gray-400">No hay personas de este tipo.</p>
                  ) : (
                    personasTipo.map((p) => (
                      <label key={p.cedula} className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-gray-50">
                        <input type="checkbox" checked={seleccion.has(p.cedula)} onChange={() => togglePersona(p.cedula)}
                          disabled={isLoading}
                          className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
                        <span className="text-sm text-gray-700 truncate">
                          {p.nombre || <span className="text-gray-400">(sin nombre)</span>}
                          <span className="text-gray-400"> — {p.cedula}</span>
                        </span>
                      </label>
                    ))
                  )}
                </div>
                {!cargando && personasTipo.length > 0 && (
                  <p className="text-xs text-gray-400 mt-1">
                    {seleccion.size
                      ? `${seleccion.size} de ${personasTipo.length} seleccionada${seleccion.size !== 1 ? 's' : ''}`
                      : `Se generarán los ${personasTipo.length} poderes de este tipo`}
                  </p>
                )}
              </div>

              {/* Checklist global: documentos en el servidor */}
              <label className="flex items-start gap-3 p-3 rounded-xl border border-gray-200 cursor-pointer hover:bg-gray-50">
                <input
                  type="checkbox"
                  checked={docsEnServidor}
                  disabled={isLoading}
                  onChange={(e) => setDocsEnServidor(e.target.checked)}
                  className="mt-0.5 w-4 h-4 accent-blue-600"
                />
                <span className="text-sm text-gray-700">
                  <span className="font-medium">Los documentos ya están en el servidor</span>
                  <span className="block text-xs text-gray-500 mt-0.5">
                    Si se marca, el Nº de pagaré se lee del documento (DECEVAL) de cada cliente. Los clientes que
                    NO tengan documentos en su carpeta del servidor se excluyen (no se valida la fecha del
                    documento). Si no se marca, el Nº de pagaré se toma de la OBLIGACIÓN del Excel.
                  </span>
                </span>
              </label>
            </>
          )}

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
              <button type="button" onClick={handleGenerar} disabled={isLoading || cargando || !generable || !cedulasAEnviar.length}
                className="flex-1 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-semibold transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
                {isLoading ? (
                  <>
                    <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Generando…
                  </>
                ) : `Generar${cedulasAEnviar.length ? ` (${cedulasAEnviar.length})` : ''}`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
