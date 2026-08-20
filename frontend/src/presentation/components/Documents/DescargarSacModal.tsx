import { useState, useEffect, type FormEvent } from 'react';
import { generateApi, type DescargarSacResult } from '../../../infrastructure/api/generateApi';
import { asignacionApi, type AsignacionPersona } from '../../../infrastructure/api/asignacionApi';
import { useAsignaciones } from '../../../application/hooks/useAsignaciones';

interface Props {
  onClose: () => void;
}

// Cuenta las cédulas válidas (5-12 dígitos) del texto, con la misma separación
// que acepta el motor: "-", ",", ";", espacios o saltos de línea.
function contarCedulas(raw: string): number {
  return new Set(
    raw
      .split(/[\s,;\-]+/)
      .map((s) => s.replace(/\D/g, ''))
      .filter((s) => /^\d{5,12}$/.test(s))
  ).size;
}

export function DescargarSacModal({ onClose }: Props) {
  const { asignaciones, isLoading: cargandoAsig } = useAsignaciones();

  const [cedulas, setCedulas]         = useState('');
  const [asignacionId, setAsignacionId] = useState('');
  const [personas, setPersonas]       = useState<AsignacionPersona[]>([]);
  const [cargandoPersonas, setCargandoPersonas] = useState(false);
  const [seleccion, setSeleccion]     = useState<Set<string>>(new Set()); // cédulas marcadas; vacío = todas
  const [isLoading, setLoading]       = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [result, setResult]           = useState<DescargarSacResult | null>(null);

  // Al elegir una asignación, traer sus personas y limpiar la selección previa.
  useEffect(() => {
    setPersonas([]);
    setSeleccion(new Set());
    if (!asignacionId) return;
    let cancelado = false;
    setCargandoPersonas(true);
    setError(null);
    asignacionApi
      .personas(asignacionId, true)   // con insumos: quién tiene ya el SAC
      .then((p) => { if (!cancelado) setPersonas(p); })
      .catch((err: unknown) => {
        if (cancelado) return;
        const msg = (err as { response?: { data?: { message?: string } } }).response?.data?.message;
        setError(msg ?? (err instanceof Error ? err.message : 'Error al cargar personas'));
      })
      .finally(() => { if (!cancelado) setCargandoPersonas(false); });
    return () => { cancelado = true; };
  }, [asignacionId]);

  // Quien ya tiene su SAC en Drive no necesita volver a bajarse: cada descarga
  // es una sesión contra el portal del banco de ~2 minutos.
  const pendientes = personas.filter((p) => !p.sac);

  const nPegadas = contarCedulas(cedulas);
  // Filas totales del Excel (incluye repetidas) vs personas únicas del checklist.
  const asigSel = asignaciones.find((a) => a.id === asignacionId);
  const repetidas = asigSel ? Math.max(0, asigSel.totalFilas - personas.length) : 0;
  // Nada marcado en una asignación elegida = TODAS sus personas.
  const cedulasAsig = asignacionId
    ? (seleccion.size ? [...seleccion] : pendientes.map((p) => p.cedula))
    : [];
  const totalAsig = cedulasAsig.length;
  const puedeEnviar = nPegadas > 0 || totalAsig > 0;

  const togglePersona = (cedula: string) => {
    setSeleccion((prev) => {
      const next = new Set(prev);
      if (next.has(cedula)) next.delete(cedula);
      else next.add(cedula);
      return next;
    });
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!puedeEnviar) { setError('Pega cédulas o elige una asignación.'); return; }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      // Unir cédulas pegadas + las de la asignación (el motor deduplica/normaliza).
      const todas = [cedulas, ...cedulasAsig].filter(Boolean).join(' ');
      const res = await generateApi.descargarSac(todas, null);
      setResult(res);
    } catch (err: unknown) {
      const axiosMsg = (err as { response?: { data?: { message?: string } } }).response?.data?.message;
      setError(axiosMsg ?? (err instanceof Error ? err.message : 'Error al descargar del SAC'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />

      <div className="relative bg-white dark:bg-gray-800 rounded-2xl shadow-xl w-full max-w-lg z-10">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-blue-100 flex items-center justify-center">
              <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
            </div>
            <div>
              <h2 className="font-bold text-gray-900">Descargar información del SAC</h2>
              <p className="text-xs text-gray-500 mt-0.5">Baja las obligaciones (SAC) por cédula a la carpeta de cada cliente</p>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Cédulas <span className="text-gray-400 font-normal">(separadas por "-", "," o espacios)</span>
            </label>
            <textarea
              value={cedulas}
              onChange={(e) => setCedulas(e.target.value)}
              rows={3}
              placeholder="Ej: 1216970638 - 79876543, 52123456"
              disabled={isLoading}
              className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-y disabled:bg-gray-50"
            />
            <p className="text-xs text-gray-400 mt-1">
              {nPegadas} cédula{nPegadas !== 1 ? 's' : ''} válida{nPegadas !== 1 ? 's' : ''} detectada{nPegadas !== 1 ? 's' : ''}
            </p>
          </div>

          {/* Separador */}
          <div className="flex items-center gap-3">
            <div className="flex-1 h-px bg-gray-200" />
            <span className="text-xs text-gray-400 font-medium">o desde una asignación</span>
            <div className="flex-1 h-px bg-gray-200" />
          </div>

          {/* Selector de asignación ya cacheada */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Asignación</label>
            <select
              value={asignacionId}
              onChange={(e) => setAsignacionId(e.target.value)}
              disabled={isLoading || cargandoAsig}
              className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-50"
            >
              <option value="">
                {cargandoAsig ? 'Cargando asignaciones…' : '— Ninguna —'}
              </option>
              {asignaciones.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.nombre} ({a.totalFilas})
                </option>
              ))}
            </select>
          </div>

          {/* Checklist de personas de la asignación elegida. Nada marcado = todas. */}
          {asignacionId && (
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-sm font-medium text-gray-700">
                  Personas <span className="text-gray-400 font-normal">(sin marcar = todas)</span>
                </label>
                {personas.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setSeleccion(new Set())}
                    className="text-xs text-blue-600 hover:text-blue-700 font-medium"
                  >
                    Limpiar
                  </button>
                )}
              </div>
              <div className="border border-gray-200 rounded-xl max-h-48 overflow-y-auto divide-y divide-gray-100">
                {cargandoPersonas ? (
                  <p className="p-3 text-sm text-gray-400">Cargando personas…</p>
                ) : personas.length === 0 ? (
                  <p className="p-3 text-sm text-gray-400">Esta asignación no tiene personas con cédula.</p>
                ) : (
                  personas.map((p) => {
                    const yaTiene = !!p.sac;
                    const marcada = !yaTiene && seleccion.has(p.cedula);
                    return (
                      <label
                        key={p.cedula}
                        className={`flex items-center gap-3 px-3 py-2 ${yaTiene ? 'cursor-default bg-gray-50/60' : 'cursor-pointer hover:bg-gray-50'}`}
                      >
                        <input
                          type="checkbox"
                          checked={marcada}
                          onChange={() => togglePersona(p.cedula)}
                          disabled={isLoading || yaTiene}
                          className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50"
                        />
                        <span className={`text-sm truncate flex-1 ${yaTiene ? 'text-gray-400' : 'text-gray-700'}`}>
                          {p.nombre || <span className="text-gray-400">(sin nombre)</span>}
                          <span className="text-gray-400"> — {p.cedula}</span>
                        </span>
                        {yaTiene ? (
                          <span className="shrink-0 text-xs font-medium text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full">
                            SAC listo
                          </span>
                        ) : (
                          <span className="shrink-0 text-xs font-medium text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full">
                            Pendiente
                          </span>
                        )}
                      </label>
                    );
                  })
                )}
              </div>
              {personas.length > 0 && (
                <p className="text-xs text-gray-400 mt-1">
                  {pendientes.length === 0
                    ? <span className="text-emerald-600 font-medium">Todas ya tienen su SAC descargado.</span>
                    : seleccion.size
                      ? `${seleccion.size} de ${pendientes.length} pendiente${pendientes.length !== 1 ? 's' : ''} seleccionada${seleccion.size !== 1 ? 's' : ''}`
                      : `Se descargarán las ${pendientes.length} persona${pendientes.length !== 1 ? 's' : ''} pendiente${pendientes.length !== 1 ? 's' : ''}`}
                  {repetidas > 0 && (
                    <span className="text-amber-600">
                      {' '}· {asigSel!.totalFilas} filas, {repetidas} cédula{repetidas !== 1 ? 's' : ''} repetida{repetidas !== 1 ? 's' : ''}
                    </span>
                  )}
                </p>
              )}
            </div>
          )}

          {error && (
            <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm">{error}</div>
          )}

          {result && (
            <div className="p-3 rounded-xl bg-blue-50 border border-blue-200 text-sm space-y-1.5">
              <p className="font-medium text-blue-900">
                ⏳ Descarga iniciada para {result.total} persona{result.total !== 1 ? 's' : ''}
              </p>
              <p className="text-blue-800">
                Corre en segundo plano. Te avisamos <b>por cada persona</b> que termine, y puedes ir
                generando su demanda sin esperar al resto. Puedes cerrar esta ventana.
              </p>
              {/* Respaldo: si el motor respondiera el lote completo (versión vieja). */}
              {result.resultados && result.resultados.length > 0 && (
                <ul className="space-y-1 pt-1 max-h-40 overflow-y-auto">
                  {result.resultados.map((r) => (
                    <li key={r.cedula} className="flex items-start gap-2">
                      <span className={r.success ? 'text-emerald-600' : 'text-red-600'}>
                        {r.success ? '✅' : '❌'}
                      </span>
                      <span className="text-gray-700">
                        <span className="font-medium">{r.cedula}</span>
                        {r.success
                          ? <span className="text-gray-500"> — {r.pdfsSAC?.length ?? 0} PDF{(r.pdfsSAC?.length ?? 0) !== 1 ? 's' : ''}{r.contactos ? ' + contactos' : ''}</span>
                          : <span className="text-red-500"> — {r.error || 'error'}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="flex gap-3 pt-1">
            <button type="button" onClick={onClose} disabled={isLoading}
              className="flex-1 px-4 py-2.5 border border-gray-200 rounded-xl text-gray-700 text-sm font-medium hover:bg-gray-50 transition-colors disabled:opacity-50">
              {result ? 'Cerrar' : 'Cancelar'}
            </button>
            <button type="submit" disabled={isLoading || !puedeEnviar}
              className="flex-1 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-semibold transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
              {isLoading ? (
                <>
                  <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Encolando…
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  Descargar del SAC{puedeEnviar ? ` (${nPegadas + totalAsig})` : ''}
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
