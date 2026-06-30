import { useEffect, useId, useRef, useState } from 'react';
import { SuperDoc } from '@harbour-enterprises/superdoc';
import '@harbour-enterprises/superdoc/style.css';
import { documentApi } from '../../../infrastructure/api/documentApi';

/**
 * Editor de la demanda (.docx) embebido. A diferencia del visor docx-preview,
 * SuperDoc renderiza el documento con fidelidad de Word (la numeración multinivel
 * sale 1.1 / 1.2, no 0.1) y permite EDITARLO. Al guardar, exporta el .docx y
 * sobreescribe el archivo original en el NAS (PUT /api/documents/:id/file).
 */
export function DemandEditor({ url, documentId, canEdit }: { url: string; documentId: string; canEdit: boolean }) {
  const editorRef = useRef<HTMLDivElement>(null);
  // SuperDoc espera selectores string para el toolbar → id único y estable por instancia.
  const uid = useId().replace(/[:]/g, '');
  const toolbarId = `sd-toolbar-${uid}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdRef = useRef<any>(null);
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setErr(null);
    setMsg(null);

    (async () => {
      try {
        // Traer el .docx desde el NAS (servido en /docs) como File para SuperDoc.
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const name = decodeURIComponent(url.split('/').pop() || 'demanda.docx');
        const file = new File([blob], name, {
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        });
        if (cancelled || !editorRef.current) return;

        sdRef.current = new SuperDoc({
          selector: editorRef.current,
          toolbar: `#${toolbarId}`,
          document: file,
          documentMode: canEdit ? 'editing' : 'viewing',
          pagination: true,
          onReady: () => { if (!cancelled) setReady(true); },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : 'error');
      }
    })();

    return () => {
      cancelled = true;
      try { sdRef.current?.destroy?.(); } catch { /* noop */ }
      sdRef.current = null;
    };
  }, [url, canEdit]);

  const handleSave = async () => {
    if (!sdRef.current) return;
    setSaving(true);
    setMsg(null);
    try {
      const blob: Blob = await sdRef.current.export();
      const name = decodeURIComponent(url.split('/').pop() || 'demanda.docx');
      await documentApi.saveFile(documentId, new File([blob], name, { type: blob.type || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }));
      setMsg('✅ Cambios guardados (archivo sobrescrito)');
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
        No se pudo abrir el editor ({err}). Usa <span className="font-medium">&nbsp;Abrir / descargar</span>.
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-gray-100 bg-white flex-shrink-0">
        <div id={toolbarId} className="flex-1 min-w-0 overflow-x-auto" />
        {canEdit && (
          <button
            onClick={handleSave}
            disabled={saving || !ready}
            className="px-3 py-1.5 bg-purple-600 hover:bg-purple-700 text-white rounded-lg text-xs font-semibold transition-colors disabled:opacity-50 whitespace-nowrap"
          >
            {saving ? 'Guardando…' : 'Guardar cambios'}
          </button>
        )}
      </div>
      {msg && <div className="px-3 py-1 text-xs text-gray-600 bg-white border-b border-gray-100">{msg}</div>}
      <div className="flex-1 min-h-0 overflow-auto bg-gray-100">
        <div ref={editorRef} className="superdoc-editor" />
        {!ready && (
          <div className="p-6 text-center text-gray-400 text-sm">Cargando editor…</div>
        )}
      </div>
    </div>
  );
}
