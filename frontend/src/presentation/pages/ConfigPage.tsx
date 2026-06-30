import { useEffect, useState, type FormEvent } from 'react';
import { configApi, type AppConfig, type TransitoEntry } from '../../infrastructure/api/configApi';

const cop = (n: number) => '$' + (n || 0).toLocaleString('es-CO');

export function ConfigPage() {
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [smmv, setSmmv] = useState('');
  const [transito, setTransito] = useState<TransitoEntry[]>([]);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // Accesible para administradores y abogados (todos los usuarios autenticados).
  useEffect(() => {
    configApi.get().then((c) => {
      setCfg(c); setSmmv(String(c.smmv)); setTransito(c.transito ?? []);
    }).catch(() => {});
  }, []);

  // Previsualización de umbrales según lo que el usuario teclea
  const smmvNum = Number(smmv) || 0;
  const minimaMax = smmvNum * 40;
  const menorMax = smmvNum * 150;

  const saveSmmv = async (e: FormEvent) => {
    e.preventDefault();
    const n = Number(smmv);
    if (!Number.isFinite(n) || n <= 0) { setMsg('❌ Ingresa un SMMV válido'); return; }
    setSaving(true); setMsg(null);
    try {
      const c = await configApi.update({ smmv: n });
      setCfg(c); setMsg('✅ SMMV guardado');
    } catch (err: unknown) {
      const m = (err as { response?: { data?: { message?: string } } }).response?.data?.message;
      setMsg('❌ ' + (m ?? 'No se pudo guardar'));
    } finally { setSaving(false); }
  };

  const setRow = (i: number, field: keyof TransitoEntry, value: string) =>
    setTransito((rows) => rows.map((r, j) => (j === i ? { ...r, [field]: value } : r)));
  const addRow = () => setTransito((rows) => [...rows, { ciudad: '', entidad: '', correo: '' }]);
  const removeRow = (i: number) => setTransito((rows) => rows.filter((_, j) => j !== i));

  const saveTransito = async () => {
    setSaving(true); setMsg(null);
    try {
      const limpio = transito.filter((t) => t.ciudad || t.entidad || t.correo);
      const c = await configApi.update({ transito: limpio });
      setCfg(c); setTransito(c.transito ?? []); setMsg('✅ Directorio de tránsito guardado');
    } catch (err: unknown) {
      const m = (err as { response?: { data?: { message?: string } } }).response?.data?.message;
      setMsg('❌ ' + (m ?? 'No se pudo guardar'));
    } finally { setSaving(false); }
  };

  return (
    <div className="p-6 lg:p-8 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Configuración</h1>
      <p className="text-gray-500 text-sm mb-6">Parámetros del sistema — administradores y abogados.</p>
      {msg && <div className="mb-4 text-sm text-gray-700">{msg}</div>}

      {/* SMMV / cuantía */}
      <form onSubmit={saveSmmv} className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 mb-6">
        <h2 className="text-sm font-semibold text-gray-700 mb-1">Cuantía — Salario Mínimo (SMMV)</h2>
        <p className="text-xs text-gray-400 mb-4">
          Los umbrales de cuantía se calculan automáticamente: MÍNIMA hasta 40 SMMV · MENOR hasta 150 SMMV · MAYOR más de eso.
        </p>
        <label className="block text-sm font-medium text-gray-700 mb-1.5">Salario mínimo mensual vigente (SMMV)</label>
        <div className="flex items-center gap-2 max-w-xs">
          <span className="text-gray-500">$</span>
          <input
            type="number" min={1} value={smmv}
            onChange={(e) => setSmmv(e.target.value)}
            className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
          />
        </div>

        <div className="grid grid-cols-3 gap-3 mt-4">
          <div className="rounded-xl bg-blue-50 border border-blue-100 p-3">
            <p className="text-xs text-blue-700 font-medium">MÍNIMA (≤ 40 SMMV)</p>
            <p className="text-sm font-semibold text-gray-900 mt-0.5">hasta {cop(minimaMax)}</p>
          </div>
          <div className="rounded-xl bg-amber-50 border border-amber-100 p-3">
            <p className="text-xs text-amber-700 font-medium">MENOR (≤ 150 SMMV)</p>
            <p className="text-sm font-semibold text-gray-900 mt-0.5">hasta {cop(menorMax)}</p>
          </div>
          <div className="rounded-xl bg-pink-50 border border-pink-100 p-3">
            <p className="text-xs text-pink-700 font-medium">MAYOR</p>
            <p className="text-sm font-semibold text-gray-900 mt-0.5">más de {cop(menorMax)}</p>
          </div>
        </div>

        <div className="flex items-center gap-3 mt-5">
          <button type="submit" disabled={saving}
            className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-xl text-sm font-semibold transition-colors disabled:opacity-50">
            {saving ? 'Guardando…' : 'Guardar SMMV'}
          </button>
          {cfg && <span className="text-xs text-gray-400 ml-auto">Actual: SMMV {cop(cfg.smmv)}</span>}
        </div>
      </form>

      {/* Directorio de tránsito */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-sm font-semibold text-gray-700">Direcciones de tránsito</h2>
          <button onClick={addRow}
            className="text-xs px-2.5 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">
            + Agregar fila
          </button>
        </div>
        <p className="text-xs text-gray-400 mb-4">
          Por ciudad, la entidad de tránsito y su correo. Se usan para llenar el oficio de tránsito cuando el Excel no los trae.
        </p>

        {transito.length === 0 ? (
          <p className="text-sm text-gray-400 py-4 text-center">Sin direcciones. Agrega una fila o cárgalas desde el Excel.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                  <th className="py-2 pr-2 font-medium">Ciudad</th>
                  <th className="py-2 pr-2 font-medium">Entidad de tránsito</th>
                  <th className="py-2 pr-2 font-medium">Correo electrónico</th>
                  <th className="py-2 w-8"></th>
                </tr>
              </thead>
              <tbody>
                {transito.map((row, i) => (
                  <tr key={i} className="border-b border-gray-50">
                    <td className="py-1.5 pr-2">
                      <input value={row.ciudad} onChange={(e) => setRow(i, 'ciudad', e.target.value)}
                        placeholder="BARRANQUILLA"
                        className="w-full px-2 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-purple-400" />
                    </td>
                    <td className="py-1.5 pr-2">
                      <input value={row.entidad} onChange={(e) => setRow(i, 'entidad', e.target.value)}
                        placeholder="Secretaría Distrital de Tránsito de Barranquilla"
                        className="w-full px-2 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-purple-400" />
                    </td>
                    <td className="py-1.5 pr-2">
                      <input value={row.correo} onChange={(e) => setRow(i, 'correo', e.target.value)}
                        placeholder="correo@transito.gov.co"
                        className="w-full px-2 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-purple-400" />
                    </td>
                    <td className="py-1.5 text-center">
                      <button onClick={() => removeRow(i)} title="Eliminar"
                        className="text-gray-300 hover:text-red-500 text-lg leading-none">×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-4">
          <button onClick={saveTransito} disabled={saving}
            className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-xl text-sm font-semibold transition-colors disabled:opacity-50">
            {saving ? 'Guardando…' : 'Guardar tránsito'}
          </button>
        </div>
      </div>
    </div>
  );
}
