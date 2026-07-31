import { useEffect, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { documentApi } from '../../../infrastructure/api/documentApi';

/**
 * Editor de la ASIGNACIÓN (.xlsx/.xls) embebido, análogo al editor de la demanda.
 * Muestra cada hoja como una tabla EDITABLE (celdas contentEditable) y, al guardar,
 * reconstruye el libro desde el DOM y sobreescribe el archivo en el NAS
 * (PUT /api/documents/:id/asignacion).
 *
 * OJO: la asignación es el Excel del LOTE completo (compartido por todas las
 * demandas de esa asignación). Editarlo afecta a todas → banner de advertencia.
 * Al reconstruir desde HTML se pierden fórmulas y formato; los valores se guardan
 * como texto tal cual se escriben (raw), para no reinterpretar fechas/números.
 */
export function AsignacionEditor({ url, documentId, canEdit }: { url: string; documentId: string; canEdit: boolean }) {
  const [sheets, setSheets] = useState<{ name: string; html: string }[]>([]);
  const [active, setActive] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const contRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setErr(null);
    setMsg(null);
    setDirty(false);
    setSheets([]);
    fetch(url)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })
      .then((buf) => {
        if (cancelled) return;
        const wb = XLSX.read(buf, { type: 'array' });
        setSheets(wb.SheetNames.map((name) => ({
          name,
          // editable:true → celdas contentEditable; el usuario edita en el navegador.
          html: XLSX.utils.sheet_to_html(wb.Sheets[name], { editable: canEdit }),
        })));
        setActive(0);
      })
      .catch((e) => { if (!cancelled) setErr(e instanceof Error ? e.message : 'error'); });
    return () => { cancelled = true; };
  }, [url, canEdit]);

  const handleSave = async () => {
    if (!contRef.current) return;
    setSaving(true);
    setMsg(null);
    try {
      // Reconstruir el libro leyendo las tablas del DOM en el mismo orden que las hojas.
      const tables = contRef.current.querySelectorAll('table');
      const wb = XLSX.utils.book_new();
      sheets.forEach((s, i) => {
        const table = tables[i] as HTMLTableElement | undefined;
        const ws = table
          ? XLSX.utils.table_to_sheet(table, { raw: true })
          : XLSX.utils.aoa_to_sheet([[]]);
        // Los nombres de hoja de Excel están limitados a 31 caracteres.
        XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 31));
      });
      const isXls = /\.xls(\?|$)/i.test(url);
      const out = XLSX.write(wb, { type: 'array', bookType: isXls ? 'xls' : 'xlsx' });
      const name = decodeURIComponent(url.split('/').pop() || 'asignacion.xlsx');
      const mime = isXls
        ? 'application/vnd.ms-excel'
        : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      const file = new File([out], name, { type: mime });
      await documentApi.saveAsignacion(documentId, file);
      setMsg('✅ Asignación guardada (Excel del lote sobrescrito en el NAS)');
      setDirty(false);
    } catch (e) {
      const m = (e as { response?: { data?: { message?: string } } }).response?.data?.message;
      setMsg('❌ ' + (m ?? (e instanceof Error ? e.message : 'No se pudo guardar')));
    } finally {
      setSaving(false);
    }
  };

  if (err) {
    return (
      <div className="h-full flex items-center justify-center text-center text-gray-500 text-sm p-6">
        No se pudo abrir la asignación ({err}). Usa <span className="font-medium">&nbsp;Abrir / descargar</span>.
      </div>
    );
  }
  if (!sheets.length) {
    return <div className="h-full flex items-center justify-center text-gray-400 text-sm">Cargando…</div>;
  }

  return (
    <div className="h-full flex flex-col">
      {/* Toolbar: pestañas de hoja + guardar */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-gray-100 bg-white flex-shrink-0">
        <div className="flex gap-1 flex-1 min-w-0 overflow-x-auto">
          {sheets.map((s, i) => (
            <button key={s.name} onClick={() => setActive(i)}
              className={`px-3 py-1 rounded-lg text-xs font-medium whitespace-nowrap ${i === active ? 'bg-emerald-100 text-emerald-700' : 'text-gray-500 hover:bg-gray-100'}`}>
              {s.name}
            </button>
          ))}
        </div>
        {canEdit && (
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-3 py-1.5 bg-purple-600 hover:bg-purple-700 text-white rounded-lg text-xs font-semibold transition-colors disabled:opacity-50 whitespace-nowrap"
          >
            {saving ? 'Guardando…' : dirty ? 'Guardar cambios •' : 'Guardar cambios'}
          </button>
        )}
      </div>

      {/* Advertencia: es el Excel del lote completo */}
      {canEdit && (
        <div className="px-3 py-1.5 text-[11px] text-amber-800 bg-amber-50 border-b border-amber-200 flex-shrink-0">
          ⚠️ Editas el Excel del <b>lote completo</b>: afecta a todas las demandas de esta asignación. Se pierden fórmulas/formato al guardar.
        </div>
      )}
      {msg && <div className="px-3 py-1 text-xs text-gray-600 bg-white border-b border-gray-100 flex-shrink-0">{msg}</div>}

      {/* Tablas: todas en el DOM (para reconstruir el libro), solo la activa visible */}
      <div ref={contRef} className="flex-1 overflow-auto bg-white xlsx-view" onInput={() => { if (!dirty) setDirty(true); }}>
        {sheets.map((s, i) => (
          <div key={s.name} style={{ display: i === active ? 'block' : 'none' }} className="p-3"
            dangerouslySetInnerHTML={{ __html: s.html }} />
        ))}
      </div>
    </div>
  );
}
