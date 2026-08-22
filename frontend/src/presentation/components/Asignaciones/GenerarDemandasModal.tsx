import { useState, useEffect, useMemo, useRef, type FormEvent } from 'react';
import { asignacionApi, TIPOS_DEMANDA, type AsignacionResumen, type AsignacionPersona, type TipoPoder } from '../../../infrastructure/api/asignacionApi';
import { expedienteApi, type CorreoPoder } from '../../../infrastructure/api/expedienteApi';

interface Props {
  asignacion: AsignacionResumen;
  onClose: () => void;
  onDone: (message: string) => void;   // éxito → cerrar + mostrar aviso + refetch
  // 409 SIN_PODER → abrir popup de poder faltante. Se le dice DE QUÉ PROCESO
  // falta el poder: cada uno se enlaza en su propia columna.
  onSinPoder: (tipo: TipoPoder) => void;
}

// Procesos cuya demanda sabe generar el motor (ver TIPOS_DEMANDA). Los demás se
// muestran para que se vean las personas, pero deshabilitados para generar.
//
// El ejecutivo singular va primero en la lista por ser el volumen habitual.
const TIPO_PREFERIDO = 'EJECUTIVO SINGULAR';
const esGenerable = (t: string) => t in TIPOS_DEMANDA;

export function GenerarDemandasModal({ asignacion, onClose, onDone, onSinPoder }: Props) {
  const [personas, setPersonas] = useState<AsignacionPersona[]>([]);
  const [cargando, setCargando] = useState(true);
  const [tipo, setTipo] = useState('');
  const [seleccion, setSeleccion] = useState<Set<string>>(new Set()); // cédulas marcadas; vacío = todas del tipo
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [correoPoder, setCorreoPoder] = useState<File | null>(null);
  const correoRef = useRef<HTMLInputElement>(null);
  // Correos de poder ya guardados en el servidor, para elegir uno en vez de subirlo.
  const [correos, setCorreos] = useState<CorreoPoder[]>([]);
  const [correoRel, setCorreoRel] = useState('');
  const [cargandoCorreos, setCargandoCorreos] = useState(true);

  useEffect(() => {
    let cancelado = false;
    expedienteApi
      .correosPoder('singular')
      .then((cs) => { if (!cancelado) setCorreos(cs); })
      .catch(() => { if (!cancelado) setCorreos([]); })
      .finally(() => { if (!cancelado) setCargandoCorreos(false); });
    return () => { cancelado = true; };
  }, []);

  useEffect(() => {
    let cancelado = false;
    setCargando(true);
    asignacionApi
      .personas(asignacion.id)
      .then((p) => {
        if (cancelado) return;
        setPersonas(p);
        // Preferir ejecutivo singular; si no hay, el primer proceso generable; y
        // si tampoco, el primero que venga (solo para ver a sus personas).
        const tipos = [...new Set(p.map((x) => x.tipo))];
        setTipo(tipos.includes(TIPO_PREFERIDO)
          ? TIPO_PREFERIDO
          : (tipos.find(esGenerable) ?? tipos[0] ?? ''));
      })
      .catch((err: unknown) => {
        if (cancelado) return;
        const msg = (err as { response?: { data?: { message?: string } } }).response?.data?.message;
        setError(msg ?? (err instanceof Error ? err.message : 'Error al cargar personas'));
      })
      .finally(() => { if (!cancelado) setCargando(false); });
    return () => { cancelado = true; };
  }, [asignacion.id]);

  // Tipos con su conteo (orden: generable primero).
  const tipos = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of personas) m.set(p.tipo, (m.get(p.tipo) ?? 0) + 1);
    return [...m.entries()]
      .map(([nombre, count]) => ({ nombre, count, generable: esGenerable(nombre) }))
      // Los generables primero; entre ellos, el singular arriba.
      .sort((a, b) => (a.generable !== b.generable
        ? (a.generable ? -1 : 1)
        : a.nombre === TIPO_PREFERIDO ? -1
        : b.nombre === TIPO_PREFERIDO ? 1
        : a.nombre.localeCompare(b.nombre)));
  }, [personas]);

  const personasTipo = useMemo(() => personas.filter((p) => p.tipo === tipo), [personas, tipo]);
  // Las que ya tienen demanda quedan fuera de todo: ni se marcan ni se envían.
  const pendientesTipo = useMemo(() => personasTipo.filter((p) => !p.generada), [personasTipo]);
  const generable = esGenerable(tipo);
  // El pago directo saca sus datos de los documentos de la carpeta, no del Excel,
  // y su anexo no lleva el correo de otorgamiento: esa sección no le aplica.
  const esPagoDirecto = TIPOS_DEMANDA[tipo] === 'pago_directo';

  // Al cambiar de tipo, limpiar la selección (son personas distintas).
  useEffect(() => { setSeleccion(new Set()); }, [tipo]);

  // Sin marcar = todas las PENDIENTES, no todas. Antes esto reprocesaba las ya
  // generadas, que es trabajo caro y de riesgo (cada una llama al motor).
  const cedulasAEnviar = seleccion.size ? [...seleccion] : pendientesTipo.map((p) => p.cedula);

  const togglePersona = (cedula: string) => {
    setSeleccion((prev) => {
      const next = new Set(prev);
      if (next.has(cedula)) next.delete(cedula); else next.add(cedula);
      return next;
    });
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!generable) { setError('El motor todavía no genera demandas de este proceso.'); return; }
    if (!cedulasAEnviar.length) {
      setError(personasTipo.length
        ? 'No queda ninguna demanda pendiente de este tipo.'
        : 'No hay personas de este tipo.');
      return;
    }
    setEnviando(true);
    setError(null);
    try {
      const res = esPagoDirecto
        ? await asignacionApi.generarGarantias(asignacion.id, cedulasAEnviar)
        : await asignacionApi.generarDemandas(asignacion.id, cedulasAEnviar, correoPoder, correoRel);
      onDone(res.message);
    } catch (err: unknown) {
      const resp = (err as { response?: { status?: number; data?: { codigo?: string; message?: string } } }).response;
      if (resp?.status === 409 && resp.data?.codigo === 'SIN_PODER') {
        onSinPoder(TIPOS_DEMANDA[tipo] ?? 'singular');
        return;
      }
      setError(resp?.data?.message ?? (err instanceof Error ? err.message : 'Error al generar demandas'));
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />

      <div className="relative bg-white dark:bg-gray-800 rounded-2xl shadow-xl w-full max-w-lg z-10">
        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100">
          <div>
            <h2 className="font-bold text-gray-900">Generar demandas</h2>
            <p className="text-xs text-gray-500 mt-0.5 truncate max-w-sm">{asignacion.nombre}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {/* Selector de tipo de demanda */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Tipo de demanda</label>
            <select
              value={tipo}
              onChange={(e) => setTipo(e.target.value)}
              disabled={enviando || cargando}
              className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent disabled:bg-gray-50"
            >
              {cargando ? (
                <option>Cargando…</option>
              ) : (
                tipos.map((t) => (
                  <option key={t.nombre} value={t.nombre}>
                    {t.nombre} ({t.count}){t.generable ? '' : ' — no soportado aún'}
                  </option>
                ))
              )}
            </select>
            {!cargando && !generable && (
              <p className="text-xs text-amber-600 mt-1">
                El motor todavía no genera demandas de este proceso. Aparece solo como referencia.
              </p>
            )}
            {!cargando && esPagoDirecto && (
              <p className="text-xs text-gray-500 mt-1">
                Se genera la <b>solicitud de aprehensión y entrega</b>. Los datos salen de los
                documentos de cada carpeta (contrato de prenda, formularios de Confecámaras, RUNT y
                Servientrega); si a un cliente le falta alguno, esa solicitud no se genera y se
                informa cuál faltó.
              </p>
            )}
          </div>

          {/* Checklist de personas del tipo elegido. Nada marcado = todas. */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-sm font-medium text-gray-700">
                Personas <span className="text-gray-400 font-normal">(sin marcar = todas)</span>
              </label>
              {personasTipo.length > 0 && seleccion.size > 0 && (
                <button type="button" onClick={() => setSeleccion(new Set())}
                  className="text-xs text-emerald-600 hover:text-emerald-700 font-medium">Limpiar</button>
              )}
            </div>
            <div className="border border-gray-200 rounded-xl max-h-56 overflow-y-auto divide-y divide-gray-100">
              {cargando ? (
                <p className="p-3 text-sm text-gray-400">Cargando personas…</p>
              ) : personasTipo.length === 0 ? (
                <p className="p-3 text-sm text-gray-400">No hay personas de este tipo.</p>
              ) : (
                personasTipo.map((p) => (
                  <label key={p.cedula}
                    className={`flex items-center gap-3 px-3 py-2 ${p.generada ? 'cursor-default bg-gray-50/60' : 'cursor-pointer hover:bg-gray-50'}`}>
                    <input type="checkbox" checked={!p.generada && seleccion.has(p.cedula)}
                      onChange={() => togglePersona(p.cedula)}
                      disabled={enviando || p.generada}
                      className="w-4 h-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500 disabled:opacity-50" />
                    <span className={`text-sm truncate flex-1 ${p.generada ? 'text-gray-400' : 'text-gray-700'}`}>
                      {p.nombre || <span className="text-gray-400">(sin nombre)</span>}
                      <span className="text-gray-400"> — {p.cedula}</span>
                    </span>
                    {p.generada ? (
                      <span className="shrink-0 text-xs font-medium text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full">
                        Generada
                      </span>
                    ) : (
                      <span className="shrink-0 text-xs font-medium text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full">
                        Pendiente
                      </span>
                    )}
                  </label>
                ))
              )}
            </div>
            {!cargando && personasTipo.length > 0 && (
              <p className="text-xs mt-1 text-gray-400">
                {pendientesTipo.length === 0 ? (
                  <span className="text-emerald-600 font-medium">
                    Todas las demandas de este tipo ya están generadas.
                  </span>
                ) : seleccion.size ? (
                  `${seleccion.size} de ${pendientesTipo.length} pendiente${pendientesTipo.length !== 1 ? 's' : ''} seleccionada${seleccion.size !== 1 ? 's' : ''}`
                ) : (
                  `Se generarán las ${pendientesTipo.length} demanda${pendientesTipo.length !== 1 ? 's' : ''} pendiente${pendientesTipo.length !== 1 ? 's' : ''} de este tipo`
                )}
              </p>
            )}
          </div>

          {/* Correo del banco → ANEXO 1. Se ELIGE de los que ya están en el
              servidor (carpeta PODERES, del más reciente al más viejo); subir uno
              nuevo queda como salida de emergencia si aún no está guardado.
              No aplica al pago directo: su anexo del poder no lleva el correo de
              otorgamiento, así que la sección se oculta en vez de pedir algo que
              se va a ignorar. */}
          <div className={esPagoDirecto ? 'hidden' : undefined}>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Correo del poder <span className="text-gray-400 font-normal">→ ANEXO 1</span>
            </label>
            <select
              value={correoRel}
              onChange={(e) => { setCorreoRel(e.target.value); setCorreoPoder(null); }}
              disabled={enviando || cargandoCorreos}
              className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50"
            >
              {cargandoCorreos ? (
                <option value="">Cargando correos del servidor…</option>
              ) : (
                <>
                  <option value="">
                    {asignacion.correoPoderUrl
                      ? '— Usar el ya guardado en esta asignación —'
                      : '— Elige el correo del poder —'}
                  </option>
                  {correos.map((c) => (
                    <option key={c.relPath} value={c.relPath}>
                      {c.fecha ? `${c.fecha} · ` : ''}{c.nombre.replace(/\.pdf$/i, '')}
                    </option>
                  ))}
                </>
              )}
            </select>

            <div className="flex items-center gap-3 mt-1.5">
              {correoRel && (
                <a href={correos.find((c) => c.relPath === correoRel)?.url} target="_blank" rel="noreferrer"
                  className="text-xs text-blue-600 hover:underline font-medium">Ver el PDF</a>
              )}
              <button type="button" disabled={enviando}
                onClick={() => { if (!enviando) correoRef.current?.click(); }}
                className="text-xs text-gray-500 hover:text-gray-700">
                {correoPoder ? `Subido: ${correoPoder.name}` : '…o subir uno nuevo'}
              </button>
              {correoPoder && (
                <button type="button" onClick={() => setCorreoPoder(null)} disabled={enviando}
                  className="text-xs text-gray-500 hover:text-gray-700">Quitar</button>
              )}
              <input ref={correoRef} type="file" accept=".pdf" className="hidden" disabled={enviando}
                onChange={(e) => { if (e.target.files?.[0]) { setCorreoPoder(e.target.files[0]); setCorreoRel(''); } }} />
            </div>
            {!correos.length && !cargandoCorreos && !asignacion.correoPoderUrl && (
              <p className="text-xs text-amber-600 mt-1">
                No hay correos de poder en el servidor: sube uno.
              </p>
            )}
          </div>

          {error && (
            <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm">{error}</div>
          )}

          <div className="flex gap-3 pt-1">
            <button type="button" onClick={onClose} disabled={enviando}
              className="flex-1 px-4 py-2.5 border border-gray-200 rounded-xl text-gray-700 text-sm font-medium hover:bg-gray-50 transition-colors disabled:opacity-50">
              Cancelar
            </button>
            <button type="submit" disabled={enviando || cargando || !generable || !cedulasAEnviar.length}
              className="flex-1 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-sm font-semibold transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
              {enviando ? 'Generando…' : `Generar${cedulasAEnviar.length ? ` (${cedulasAEnviar.length})` : ''}`}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
