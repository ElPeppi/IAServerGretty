import { useRef, useState, type FormEvent } from 'react';
import { asignacionApi } from '../../../infrastructure/api/asignacionApi';

interface Props {
  onClose: () => void;
  onSuccess: () => void;
}

type Demandante = 'FINANDINA' | 'LIBERTADOR';

// Agrega una asignación. FINANDINA: sube el Excel y lo CACHEA. LIBERTADOR: las
// asignaciones llegan solo como NÚMEROS DE SOLICITUD (sin Excel ni cédulas), así
// que se pegan en un cuadro de texto.
export function SubirAsignacionModal({ onClose, onSuccess }: Props) {
  const [demandante, setDemandante] = useState<Demandante>('FINANDINA');
  const [file, setFile] = useState<File | null>(null);
  const [fecha, setFecha] = useState('');
  const [solicitudes, setSolicitudes] = useState('');
  const [isLoading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = (f: File) => {
    const ext = f.name.split('.').pop()?.toLowerCase();
    if (!['xlsx', 'xls', 'csv'].includes(ext ?? '')) {
      setError('Solo .xlsx, .xls o .csv');
      return;
    }
    setFile(f);
    setError(null);
  };

  // Nº de solicitudes válidas detectadas en el textarea (para el contador y el disabled).
  const nSolicitudes = solicitudes.split(/[\s,;]+/).filter((s) => /^\d{3,}$/.test(s.trim())).length;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (demandante === 'LIBERTADOR') {
        if (nSolicitudes === 0) { setError('Pega al menos un número de solicitud.'); setLoading(false); return; }
        const res = await asignacionApi.crearLibertador(solicitudes);
        setOk(`Asignación Libertador "${res.asignacion.nombre}" creada (${res.asignacion.totalFilas} solicitud(es)).`);
      } else {
        if (!file) { setError('Selecciona el Excel de asignación'); setLoading(false); return; }
        const res = await asignacionApi.subir(file, fecha || undefined);
        setOk(`Asignación "${res.asignacion.nombre}" cacheada (${res.asignacion.totalFilas} cliente(s)).`);
      }
      setTimeout(() => { onSuccess(); onClose(); }, 1800);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } }).response?.data?.message;
      setError(msg ?? (err instanceof Error ? err.message : 'Error al guardar la asignación'));
    } finally {
      setLoading(false);
    }
  };

  const puedeEnviar = demandante === 'LIBERTADOR' ? nSolicitudes > 0 : !!file;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />

      <div className="relative bg-white dark:bg-gray-800 rounded-2xl shadow-xl w-full max-w-lg z-10">
        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100">
          <div>
            <h2 className="font-bold text-gray-900">Agregar asignación</h2>
            <p className="text-xs text-gray-500 mt-0.5">Elige el demandante y agrega la asignación</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {/* Selector de demandante */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Demandante</label>
            <div className="grid grid-cols-2 gap-2">
              {(['FINANDINA', 'LIBERTADOR'] as Demandante[]).map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => { setDemandante(d); setError(null); }}
                  className={`px-4 py-2.5 rounded-xl text-sm font-semibold border transition-colors ${
                    demandante === d
                      ? 'bg-purple-600 text-white border-purple-600'
                      : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
                  }`}
                >
                  {d === 'FINANDINA' ? 'Finandina (Excel)' : 'Libertador (solicitudes)'}
                </button>
              ))}
            </div>
          </div>

          {demandante === 'FINANDINA' ? (
            <>
              <div
                onClick={() => inputRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); }}
                className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors ${
                  file ? 'border-purple-400 bg-purple-50' : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                }`}
              >
                <input ref={inputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden"
                  onChange={(e) => { if (e.target.files?.[0]) handleFile(e.target.files[0]); }} />
                {file
                  ? <p className="font-medium text-gray-900 text-sm">{file.name}</p>
                  : <p className="text-sm font-medium text-gray-600">Arrastra el Excel de asignación aquí (.xlsx)</p>}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  Fecha de asignación <span className="text-gray-400 font-normal">(opcional; si no, se saca del nombre del archivo)</span>
                </label>
                <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)}
                  className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 bg-white" />
              </div>
            </>
          ) : (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Números de solicitud <span className="text-gray-400 font-normal">(uno por línea o separados por coma)</span>
              </label>
              <textarea
                value={solicitudes}
                onChange={(e) => setSolicitudes(e.target.value)}
                rows={7}
                placeholder={'4755208\n11168927\n5761466'}
                className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm font-mono focus:outline-none focus:ring-2 focus:ring-purple-500 bg-white resize-y"
              />
              <p className="text-xs text-gray-500 mt-1">{nSolicitudes} solicitud(es) detectada(s).</p>
            </div>
          )}

          {ok && <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-700 text-sm">✅ {ok}</div>}
          {error && <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm">{error}</div>}

          <div className="flex gap-3 pt-1">
            <button type="button" onClick={onClose} disabled={isLoading}
              className="flex-1 px-4 py-2.5 border border-gray-200 rounded-xl text-gray-700 text-sm font-medium hover:bg-gray-50 transition-colors disabled:opacity-50">
              {ok ? 'Cerrar' : 'Cancelar'}
            </button>
            <button type="submit" disabled={isLoading || !puedeEnviar || !!ok}
              className="flex-1 px-4 py-2.5 bg-purple-600 hover:bg-purple-700 text-white rounded-xl text-sm font-semibold transition-colors disabled:opacity-50">
              {isLoading ? 'Guardando…' : demandante === 'LIBERTADOR' ? 'Crear asignación' : 'Cachear asignación'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
