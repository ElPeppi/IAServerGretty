import { useRef, useState, type FormEvent } from 'react';
import { asignacionApi } from '../../../infrastructure/api/asignacionApi';

interface Props {
  onClose: () => void;
  onSuccess: () => void;
}

// Sube el Excel de asignación y lo CACHEA (ya no genera demandas: eso es otro botón).
export function SubirAsignacionModal({ onClose, onSuccess }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [fecha, setFecha] = useState('');
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

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) { setError('Selecciona el Excel de asignación'); return; }
    setLoading(true);
    setError(null);
    try {
      const res = await asignacionApi.subir(file, fecha || undefined);
      setOk(`Asignación "${res.asignacion.nombre}" cacheada (${res.asignacion.totalFilas} cliente(s)).`);
      setTimeout(() => { onSuccess(); onClose(); }, 1800);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } }).response?.data?.message;
      setError(msg ?? (err instanceof Error ? err.message : 'Error al cachear la asignación'));
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
            <h2 className="font-bold text-gray-900">Subir asignación</h2>
            <p className="text-xs text-gray-500 mt-0.5">Cachea el Excel para generar poderes y demandas</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
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

          {ok && <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-700 text-sm">✅ {ok}</div>}
          {error && <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm">{error}</div>}

          <div className="flex gap-3 pt-1">
            <button type="button" onClick={onClose} disabled={isLoading}
              className="flex-1 px-4 py-2.5 border border-gray-200 rounded-xl text-gray-700 text-sm font-medium hover:bg-gray-50 transition-colors disabled:opacity-50">
              {ok ? 'Cerrar' : 'Cancelar'}
            </button>
            <button type="submit" disabled={isLoading || !file || !!ok}
              className="flex-1 px-4 py-2.5 bg-purple-600 hover:bg-purple-700 text-white rounded-xl text-sm font-semibold transition-colors disabled:opacity-50">
              {isLoading ? 'Guardando…' : 'Cachear asignación'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
