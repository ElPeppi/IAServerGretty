import { useEffect, useState } from 'react';
import { configApi, type Plantilla } from '../../../infrastructure/api/configApi';
import { useAuth } from '../../../application/context/AuthContext';

function fmtPeso(bytes?: number): string {
  if (!bytes) return '—';
  return bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fmtFecha(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? '—'
    : d.toLocaleString('es-CO', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function mensajeDeError(err: unknown, fallback: string): string {
  const m = (err as { response?: { data?: { message?: string; error?: string } } }).response?.data;
  return m?.message ?? m?.error ?? fallback;
}

export function PlantillasCard() {
  const { user } = useAuth();
  const esAdmin = user?.role === 'ADMIN';

  const [plantillas, setPlantillas] = useState<Plantilla[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [sincronizando, setSincronizando] = useState(false);
  const [ocupada, setOcupada] = useState<string | null>(null); // clave restaurándose
  const [abierta, setAbierta] = useState<string | null>(null); // clave con respaldos desplegados

  const cargar = () =>
    configApi
      .plantillas()
      .then((p) => { setPlantillas(p); setError(null); })
      .catch((err) => setError(mensajeDeError(err, 'No se pudieron leer las plantillas')));

  useEffect(() => { void cargar(); }, []);

  const onSincronizar = async () => {
    setSincronizando(true); setMsg(null); setError(null);
    try {
      const r = await configApi.sincronizarPlantillas();
      setPlantillas(r.plantillas);
      if (r.revisados === 0) {
        // Sin candidatos NO es "todo al día": es que no se encontró la carpeta en
        // Drive (movida, renombrada o sin permiso). Decirlo, o parecería un éxito.
        setError('⚠️ No se encontró ningún archivo en Drive. Revisa que las carpetas '
               + 'DEMANDAS/FINANDINA (certificados) y …/EJECUTIVAS SINGULARES/PLANTILLAS existan y estén compartidas.');
      } else {
        setMsg(r.repuestos.length
          ? `✅ Actualizado desde Drive: ${r.repuestos.join(', ')}`
          : `✅ Todo al día — ${r.omitidos} archivo(s) ya coinciden con Drive.`);
      }
      if (r.errores.length) setError('⚠️ ' + r.errores.join(' | '));
    } catch (err) {
      setError('❌ ' + mensajeDeError(err, 'No se pudo sincronizar desde Drive'));
    } finally {
      setSincronizando(false);
    }
  };

  const onRestaurar = async (p: Plantilla, archivo: string) => {
    setOcupada(p.clave); setMsg(null); setError(null);
    try {
      await configApi.restaurarPlantilla(p.clave, archivo);
      await cargar();
      setMsg(`✅ "${p.etiqueta}" restaurada a la versión anterior. `
           + 'Ojo: la próxima generación vuelve a traer la de Drive si allí sigue la nueva.');
    } catch (err) {
      setError('❌ ' + mensajeDeError(err, 'No se pudo restaurar'));
    } finally {
      setOcupada(null);
    }
  };

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 mt-6">
      <div className="flex items-start justify-between gap-4 mb-1">
        <h2 className="text-sm font-semibold text-gray-700">Plantillas de documentos</h2>
        {esAdmin && (
          <button
            onClick={() => void onSincronizar()}
            disabled={sincronizando}
            className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50 whitespace-nowrap">
            {sincronizando ? 'Sincronizando…' : 'Sincronizar con Drive'}
          </button>
        )}
      </div>
      <p className="text-xs text-gray-400 mb-4">
        Se copian de Drive al servidor <strong>automáticamente antes de cada generación</strong>, junto
        con los certificados del mes. Para cambiar una plantilla, súbela a Drive: aquí no hay nada que hacer.
        El botón solo sirve para adelantar esa copia y comprobar que quedó bien.
      </p>

      {msg && <div className="mb-3 p-2.5 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-700 text-sm">{msg}</div>}
      {error && <div className="mb-3 p-2.5 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm">{error}</div>}

      {plantillas === null ? (
        <div className="space-y-2">{[...Array(3)].map((_, i) => <div key={i} className="animate-pulse bg-gray-100 rounded-lg h-12" />)}</div>
      ) : (
        <div className="divide-y divide-gray-100">
          {plantillas.map((p) => (
            <div key={p.clave} className="py-3">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900">{p.etiqueta}</p>
                  <p className="text-xs text-gray-400 truncate" title={p.ruta}>{p.archivo}</p>
                  <p className="text-xs mt-1">
                    {p.existe ? (
                      <span className="text-gray-500">
                        {fmtPeso(p.tamano)} · copiada {fmtFecha(p.modificado)}
                      </span>
                    ) : (
                      <span className="text-red-600 font-medium">
                        ⚠ Falta en el servidor — súbela a Drive y sincroniza
                      </span>
                    )}
                  </p>
                </div>

                {p.respaldos.length > 0 && esAdmin && (
                  <button
                    onClick={() => setAbierta((c) => (c === p.clave ? null : p.clave))}
                    className="text-xs px-2.5 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 shrink-0">
                    Versiones ({p.respaldos.length})
                  </button>
                )}
              </div>

              {abierta === p.clave && esAdmin && (
                <div className="mt-3 ml-1 border-l-2 border-gray-100 pl-3 space-y-1.5">
                  {p.respaldos.map((r) => (
                    <div key={r.archivo} className="flex items-center justify-between gap-3 text-xs">
                      <span className="text-gray-500">
                        {fmtFecha(r.fecha)} · {fmtPeso(r.tamano)}
                      </span>
                      <button
                        onClick={() => void onRestaurar(p, r.archivo)}
                        disabled={ocupada !== null}
                        className="px-2 py-1 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50">
                        Restaurar
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
