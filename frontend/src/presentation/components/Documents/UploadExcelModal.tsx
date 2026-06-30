import { useState, useRef, type FormEvent, type DragEvent } from 'react';
import { generateApi } from '../../../infrastructure/api/generateApi';

interface Props {
  onClose: () => void;
  onSuccess: () => void;
}

// Tipo de demanda. "Finandina" usa el motor (la IA/OCR identifica si cada pagaré
// es DECEVAL o FINANDINA). "Alfonso M" se implementará después.
const TIPO_OPTIONS = [
  { value: 'FINANDINA', label: 'Finandina' },
  { value: 'ALFONSO_M', label: 'Alfonso M (próximamente)' },
];

export function UploadExcelModal({ onClose, onSuccess }: Props) {
  const [file, setFile]               = useState<File | null>(null);
  const [correoPoder, setCorreoPoder] = useState<File | null>(null);
  const [tipoDemanda, setTipoDemanda] = useState('FINANDINA');
  const [fechaAsignacion, setFechaAsignacion] = useState(() => new Date().toISOString().slice(0, 10));
  const [isDragging, setIsDragging]   = useState(false);
  const [isLoading, setIsLoading]     = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [successMsg, setSuccessMsg]   = useState<string | null>(null);
  const inputRef                      = useRef<HTMLInputElement>(null);
  const correoRef                     = useRef<HTMLInputElement>(null);

  const handleFile = (f: File) => {
    const ext = f.name.split('.').pop()?.toLowerCase();
    if (!['xlsx', 'xls', 'csv'].includes(ext ?? '')) {
      setError('Solo se permiten archivos .xlsx, .xls o .csv');
      return;
    }
    setFile(f);
    setError(null);
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const dropped = e.dataTransfer.files[0];
    if (dropped) handleFile(dropped);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) { setError('Selecciona un archivo Excel'); return; }
    if (tipoDemanda === 'ALFONSO_M') {
      setError('El tipo "Alfonso M" aún no está disponible — se implementará después.');
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      // Fecha de asignación del input (YYYY-MM-DD) → DD/MM/YYYY para el motor.
      const [y, m, d] = fechaAsignacion.split('-');
      const fechaDMY = (y && m && d) ? `${d}/${m}/${y}` : undefined;

      // Motor real: una demanda por cliente del Excel. Para "Finandina" la IA/OCR
      // detecta si cada pagaré es DECEVAL o escaneado (FINANDINA). El correo del
      // poder (opcional) se usa para el ANEXO 1.
      const res = await generateApi.singular(file, { correoPoder, fechaAsignacion: fechaDMY });
      // La generación corre en SEGUNDO PLANO: el backend responde de inmediato.
      // Las demandas aparecen en Documentos a medida que el motor las termina.
      setSuccessMsg(
        res.message ||
        'Generación iniciada en segundo plano. Las demandas aparecerán en Documentos en unos minutos (usa "Actualizar"). Los clientes sin documentos quedarán en Observaciones.'
      );
      setTimeout(() => { onSuccess(); onClose(); }, 4500);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error al generar la demanda';
      const axiosMsg = (err as { response?: { data?: { message?: string } } }).response?.data?.message;
      setError(axiosMsg ?? msg);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />

      <div className="relative bg-white dark:bg-gray-800 rounded-2xl shadow-xl w-full max-w-lg z-10">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-emerald-100 flex items-center justify-center">
              <svg className="w-5 h-5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <div>
              <h2 className="font-bold text-gray-900">Generar Demandas desde Excel</h2>
              <p className="text-xs text-gray-500 mt-0.5">El motor procesa el Excel y genera una demanda por cliente</p>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {/* Drop zone Excel */}
          <div
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            onClick={() => inputRef.current?.click()}
            className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors ${
              isDragging || file ? 'border-emerald-400 bg-emerald-50' : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
            }`}
          >
            <input ref={inputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden"
              onChange={(e) => { if (e.target.files?.[0]) handleFile(e.target.files[0]); }} />
            {file ? (
              <div className="flex items-center justify-center gap-3">
                <svg className="w-8 h-8 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <div className="text-left">
                  <p className="font-medium text-gray-900 text-sm">{file.name}</p>
                  <p className="text-xs text-gray-500">{(file.size / 1024).toFixed(1)} KB</p>
                </div>
              </div>
            ) : (
              <>
                <svg className="w-10 h-10 text-gray-300 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                    d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                </svg>
                <p className="text-sm font-medium text-gray-600">Arrastra tu Excel aquí</p>
                <p className="text-xs text-gray-400 mt-1">.xlsx, .xls o .csv</p>
              </>
            )}
          </div>

          {/* Correo del poder (opcional) → ANEXO 1 */}
          <div
            onClick={() => correoRef.current?.click()}
            className={`border-2 border-dashed rounded-xl p-4 text-center cursor-pointer transition-colors ${
              correoPoder ? 'border-emerald-400 bg-emerald-50' : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
            }`}
          >
            <input ref={correoRef} type="file" accept=".pdf" className="hidden"
              onChange={(e) => { if (e.target.files?.[0]) setCorreoPoder(e.target.files[0]); }} />
            <p className="text-sm font-medium text-gray-600">
              📧 Correo del poder <span className="text-gray-400 font-normal">(opcional, PDF) → ANEXO 1</span>
            </p>
            <p className="text-xs text-emerald-600 mt-1 font-medium">
              {correoPoder ? correoPoder.name : 'Sin correo seleccionado'}
            </p>
          </div>

          {/* Tipo de demanda + fecha de asignación */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Tipo de demanda</label>
              <select
                value={tipoDemanda}
                onChange={(e) => setTipoDemanda(e.target.value)}
                className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 bg-white"
              >
                {TIPO_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Fecha de asignación</label>
              <input
                type="date"
                value={fechaAsignacion}
                onChange={(e) => setFechaAsignacion(e.target.value)}
                className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 bg-white"
              />
            </div>
          </div>

          {successMsg && (
            <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-700 text-sm">
              ✅ {successMsg}
            </div>
          )}
          {error && (
            <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm">{error}</div>
          )}

          <div className="flex gap-3 pt-1">
            <button type="button" onClick={onClose} disabled={isLoading}
              className="flex-1 px-4 py-2.5 border border-gray-200 rounded-xl text-gray-700 text-sm font-medium hover:bg-gray-50 transition-colors disabled:opacity-50">
              {successMsg ? 'Cerrar' : 'Cancelar'}
            </button>
            <button type="submit" disabled={isLoading || !file || !!successMsg}
              className="flex-1 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-sm font-semibold transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
              {isLoading ? (
                <>
                  <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Generando…
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                  Generar Demandas
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
