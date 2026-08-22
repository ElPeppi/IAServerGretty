import { useRef, useState } from 'react';
import { asignacionApi, type AsignacionResumen, type TipoPoder } from '../../../infrastructure/api/asignacionApi';

interface Props {
  asignacion: AsignacionResumen;
  // Proceso cuyo poder falta. Cada uno se enlaza en su propia columna, así que
  // subir el Word sin saber cuál es lo dejaría en el sitio equivocado.
  tipo?: TipoPoder;
  onClose: () => void;
  onGenerar: () => void;   // abrir el modal de Generar poderes
  onSubido: () => void;    // se subió el Word y quedó enlazado
}

// Popup: "no hay poder enlazado a esta asignación, ¿subirlo o generarlo?"
export function PoderFaltanteModal({ asignacion, tipo = 'singular', onClose, onGenerar, onSubido }: Props) {
  const [isLoading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubir = async (f: File) => {
    if (!/\.docx$/i.test(f.name)) { setError('El poder debe ser un .docx'); return; }
    setLoading(true);
    setError(null);
    try {
      await asignacionApi.subirPoder(asignacion.id, f, tipo);
      onSubido();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } }).response?.data?.message;
      setError(msg ?? (err instanceof Error ? err.message : 'Error al subir el poder'));
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />

      <div className="relative bg-white dark:bg-gray-800 rounded-2xl shadow-xl w-full max-w-md z-10">
        <div className="px-6 py-5 border-b border-gray-100">
          <h2 className="font-bold text-gray-900">No hay poder enlazado</h2>
          <p className="text-sm text-gray-500 mt-1">
            La asignación <span className="font-medium">"{asignacion.nombre}"</span> no tiene un poder generado.
            ¿Deseas subirlo o generarlo?
          </p>
        </div>

        <div className="p-6 space-y-3">
          {error && <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm">{error}</div>}

          <input ref={inputRef} type="file" accept=".docx" className="hidden"
            onChange={(e) => { if (e.target.files?.[0]) handleSubir(e.target.files[0]); }} />

          <button onClick={() => inputRef.current?.click()} disabled={isLoading}
            className="w-full px-4 py-2.5 border border-gray-200 rounded-xl text-gray-700 text-sm font-semibold hover:bg-gray-50 transition-colors disabled:opacity-50">
            {isLoading ? 'Subiendo…' : '⬆ Subir Word de poderes'}
          </button>
          <button onClick={onGenerar} disabled={isLoading}
            className="w-full px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-semibold transition-colors disabled:opacity-50">
            ⚙ Generarlo automáticamente
          </button>
          <button onClick={onClose} disabled={isLoading}
            className="w-full px-4 py-2 text-gray-500 hover:text-gray-700 text-sm transition-colors disabled:opacity-50">
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}
