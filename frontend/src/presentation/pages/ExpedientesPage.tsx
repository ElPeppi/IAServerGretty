import { useState, useEffect, useCallback, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  expedienteApi,
  type Expediente,
  type ArchivoExpediente,
} from '../../infrastructure/api/expedienteApi';

/**
 * Visor del expediente de un cliente: los documentos que tiene en el servidor
 * (SAC, contactos, pagaré, demanda…). Permite verlos y BORRARLOS —cosa que desde
 * Drive no se puede, porque los archivos los sube la cuenta del sistema y a un
 * editor solo le ofrece "quitar de la vista", que no borra nada.
 */

const COLOR_TIPO: Record<string, string> = {
  SAC: 'bg-blue-100 text-blue-700',
  CONTACTOS: 'bg-cyan-100 text-cyan-700',
  PAGARE: 'bg-emerald-100 text-emerald-700',
  DATACREDITO: 'bg-amber-100 text-amber-700',
  RUNT: 'bg-violet-100 text-violet-700',
  DEMANDA: 'bg-indigo-100 text-indigo-700',
  ANEXOS: 'bg-slate-100 text-slate-700',
  ANTECEDENTES: 'bg-slate-100 text-slate-700',
  PODER: 'bg-rose-100 text-rose-700',
  OTRO: 'bg-gray-100 text-gray-600',
};

const esPdf = (n: string) => /\.pdf$/i.test(n);
const esImagen = (n: string) => /\.(png|jpe?g|gif|webp)$/i.test(n);
// Solo se puede previsualizar dentro de la página lo que el navegador sabe pintar.
const sePuedeVer = (n: string) => esPdf(n) || esImagen(n);

export function ExpedientesPage() {
  // La cédula vive en la URL (?cedula=…): así recargar la página —o que Vite
  // recargue el módulo en desarrollo— no borra lo buscado, y el enlace se puede
  // compartir o guardar.
  const [params, setParams] = useSearchParams();
  const cedulaUrl = (params.get('cedula') ?? '').replace(/\D/g, '');

  const [busqueda, setBusqueda] = useState(cedulaUrl);
  const [exp, setExp] = useState<Expediente | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verArchivo, setVerArchivo] = useState<ArchivoExpediente | null>(null);
  const [borrando, setBorrando] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  const cargar = useCallback(async (cedula: string) => {
    setCargando(true);
    setError(null);
    setAviso(null);
    setVerArchivo(null);
    try {
      setExp(await expedienteApi.ver(cedula));
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } }).response?.data?.message;
      setError(msg ?? (err instanceof Error ? err.message : 'Error al buscar el expediente'));
      setExp(null);
    } finally {
      setCargando(false);
    }
  }, []);

  // Buscar sola al entrar con ?cedula= en la URL (o al cambiarla).
  useEffect(() => {
    if (!/^\d{5,12}$/.test(cedulaUrl)) return;
    setBusqueda(cedulaUrl);
    void cargar(cedulaUrl);
  }, [cedulaUrl, cargar]);

  const buscar = (e?: FormEvent) => {
    e?.preventDefault();
    const cedula = busqueda.replace(/\D/g, '');
    if (!/^\d{5,12}$/.test(cedula)) {
      setError('Escribe una cédula válida (5 a 12 dígitos).');
      return;
    }
    // Cambiar la URL dispara la carga (efecto de arriba); si es la MISMA cédula
    // el efecto no se vuelve a lanzar, así que se recarga a mano.
    if (cedula === cedulaUrl) void cargar(cedula);
    else setParams({ cedula });
  };

  const borrar = async (a: ArchivoExpediente) => {
    if (!exp) return;
    if (!window.confirm(`¿Borrar "${a.nombre}"?\n\nSe elimina del servidor y no se puede deshacer.`)) return;
    setBorrando(a.relPath);
    setError(null);
    try {
      await expedienteApi.borrarArchivo(exp.cedula, a.relPath);
      if (verArchivo?.relPath === a.relPath) setVerArchivo(null);
      setExp(await expedienteApi.ver(exp.cedula));
      setAviso(`"${a.nombre}" borrado.`);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } }).response?.data?.message;
      setError(msg ?? (err instanceof Error ? err.message : 'Error al borrar'));
    } finally {
      setBorrando(null);
    }
  };

  return (
    // Mismo contenedor que el resto de páginas (Asignaciones, Documentos…) para
    // que el contenido quede centrado y con el mismo ancho.
    <div className="p-6 lg:p-8 max-w-7xl mx-auto space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Expediente del cliente</h1>
        <p className="text-gray-500 text-sm mt-0.5">
          Documentos guardados en el servidor: SAC, contactos, pagaré, demanda y anexos.
        </p>
      </div>

      <form onSubmit={buscar} className="flex gap-2 max-w-md">
        <input
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
          placeholder="Cédula del cliente"
          inputMode="numeric"
          className="flex-1 px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          type="submit"
          disabled={cargando}
          className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-semibold disabled:opacity-50"
        >
          {cargando ? 'Buscando…' : 'Buscar'}
        </button>
      </form>

      {error && <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm">{error}</div>}
      {aviso && <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-700 text-sm">{aviso}</div>}

      {exp && exp.total === 0 && (
        <div className="p-4 rounded-xl bg-gray-50 border border-gray-200 text-sm text-gray-600">
          No hay documentos para <b>{exp.cedula}</b> en el servidor. Si aún no le has descargado el
          SAC, hazlo desde <b>Documentos → Descargar SAC</b>.
        </div>
      )}

      {exp && exp.total > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {/* Lista de archivos, agrupada por la carpeta real del servidor */}
          <div className="space-y-4">
            {exp.carpetas.map((c) => (
              <div key={c.relPath} className="border border-gray-200 rounded-xl overflow-hidden">
                <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-200">
                  <p className="text-sm font-semibold text-gray-800">{c.nombre}</p>
                  <p className="text-xs text-gray-500">
                    {c.procesoNombre} · {c.archivos.length} archivo(s)
                  </p>
                </div>
                <ul className="divide-y divide-gray-100">
                  {c.archivos.map((a) => (
                    <li key={a.relPath} className="flex items-center gap-2 px-3 py-2 hover:bg-gray-50">
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${COLOR_TIPO[a.tipo] ?? COLOR_TIPO.OTRO}`}>
                        {a.tipo}
                      </span>
                      <span className="flex-1 text-sm text-gray-700 truncate" title={a.nombre}>
                        {a.nombre}
                      </span>
                      {sePuedeVer(a.nombre) && (
                        <button
                          type="button"
                          onClick={() => setVerArchivo(a)}
                          className="text-xs text-blue-600 hover:text-blue-700 font-medium"
                        >
                          Ver
                        </button>
                      )}
                      <a
                        href={a.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-gray-500 hover:text-gray-700 font-medium"
                      >
                        Descargar
                      </a>
                      <button
                        type="button"
                        onClick={() => borrar(a)}
                        disabled={borrando === a.relPath}
                        className="text-xs text-red-600 hover:text-red-700 font-medium disabled:opacity-50"
                      >
                        {borrando === a.relPath ? '…' : 'Borrar'}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          {/* Previsualización */}
          <div className="border border-gray-200 rounded-xl min-h-[28rem] flex flex-col">
            {verArchivo ? (
              <>
                <div className="px-4 py-2.5 border-b border-gray-200 flex items-center justify-between gap-2">
                  <p className="text-sm font-medium text-gray-800 truncate">{verArchivo.nombre}</p>
                  <button onClick={() => setVerArchivo(null)} className="text-gray-400 hover:text-gray-600 text-sm">
                    ✕
                  </button>
                </div>
                {esImagen(verArchivo.nombre) ? (
                  <img src={verArchivo.url} alt={verArchivo.nombre} className="flex-1 object-contain p-3" />
                ) : (
                  <iframe src={verArchivo.url} title={verArchivo.nombre} className="flex-1 w-full rounded-b-xl" />
                )}
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-sm text-gray-400 p-6 text-center">
                Elige “Ver” en un PDF o imagen para previsualizarlo aquí.
                <br />
                Los .docx y .zip se abren con “Descargar”.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
