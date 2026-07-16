import { useState, useRef, type FormEvent } from 'react';
import { generateApi, type DescargarSacResult } from '../../../infrastructure/api/generateApi';

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
  const [cedulas, setCedulas]   = useState('');
  const [excel, setExcel]       = useState<File | null>(null);
  const [isLoading, setLoading] = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [result, setResult]     = useState<DescargarSacResult | null>(null);
  const excelRef                = useRef<HTMLInputElement>(null);

  const n = contarCedulas(cedulas);
  const puedeEnviar = n > 0 || !!excel;

  const handleExcel = (f: File) => {
    const ext = f.name.split('.').pop()?.toLowerCase();
    if (!['xlsx', 'xls', 'csv'].includes(ext ?? '')) {
      setError('El Excel debe ser .xlsx, .xls o .csv');
      return;
    }
    setExcel(f);
    setError(null);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!puedeEnviar) { setError('Pega cédulas o sube el Excel de asignación.'); return; }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await generateApi.descargarSac(cedulas, excel);
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
              rows={4}
              placeholder="Ej: 1216970638 - 79876543, 52123456"
              disabled={isLoading}
              className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-y disabled:bg-gray-50"
            />
            <p className="text-xs text-gray-400 mt-1">
              {n} cédula{n !== 1 ? 's' : ''} válida{n !== 1 ? 's' : ''} detectada{n !== 1 ? 's' : ''}
            </p>
          </div>

          {/* Separador */}
          <div className="flex items-center gap-3">
            <div className="flex-1 h-px bg-gray-200" />
            <span className="text-xs text-gray-400 font-medium">o con el Excel de asignación</span>
            <div className="flex-1 h-px bg-gray-200" />
          </div>

          {/* Dropzone Excel de asignación → se sacan las cédulas de IDENTIFICACION */}
          <div
            onClick={() => excelRef.current?.click()}
            className={`border-2 border-dashed rounded-xl p-4 text-center cursor-pointer transition-colors ${
              excel ? 'border-blue-400 bg-blue-50' : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
            }`}
          >
            <input ref={excelRef} type="file" accept=".xlsx,.xls,.csv" className="hidden"
              onChange={(e) => { if (e.target.files?.[0]) handleExcel(e.target.files[0]); }} />
            <p className="text-sm font-medium text-gray-600">
              📄 Excel de asignación <span className="text-gray-400 font-normal">(.xlsx — columna IDENTIFICACION)</span>
            </p>
            <p className="text-xs text-blue-600 mt-1 font-medium">
              {excel ? excel.name : 'Sin Excel seleccionado'}
            </p>
          </div>

          {error && (
            <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm">{error}</div>
          )}

          {result && (
            <div className="p-3 rounded-xl bg-gray-50 border border-gray-200 text-sm space-y-2 max-h-56 overflow-y-auto">
              <p className="font-medium text-gray-800">
                {result.ok}/{result.total} descargada{result.ok !== 1 ? 's' : ''} correctamente
              </p>
              <ul className="space-y-1">
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
                  Descargando…
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  Descargar del SAC
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
