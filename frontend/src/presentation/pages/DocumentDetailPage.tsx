import { useState, useEffect, useRef, lazy, Suspense } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { renderAsync } from 'docx-preview';
import * as XLSX from 'xlsx';
import { useDocument } from '../../application/hooks/useDocuments';
import { DocumentStatusBadge } from '../components/Documents/DocumentStatusBadge';
import { SignatureModal } from '../components/Documents/SignatureModal';

// SuperDoc es pesado (~5 MB): se carga solo al abrir una demanda, no en el bundle inicial.
const DemandEditor = lazy(() =>
  import('../components/Documents/DemandEditor').then((m) => ({ default: m.DemandEditor }))
);
import type { Document, DocumentNote } from '../../domain/types/document';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';

type RightTab = 'anexos' | 'antecedentes' | 'asignacion' | 'notas';

/** Renderiza un .docx en el navegador (funciona en localhost y desplegado). */
function DocxViewer({ url }: { url: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setErr(null);
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then((buf) => {
        if (cancelled || !ref.current) return;
        ref.current.innerHTML = '';
        return renderAsync(buf, ref.current, undefined, {
          className: 'docx',
          inWrapper: true,
          breakPages: true,          // separa en hojas
          renderHeaders: true,       // encabezado (membrete JRamos)
          renderFooters: true,
          ignoreLastRenderedPageBreak: false,
          experimental: true,
          // useBase64URL desactivado: con blob URLs la imagen del membrete
          // conserva su MIME correcto (data:application/* la rompía → width 0).
        });
      })
      .then(() => {
        // El membrete es una imagen de fondo de página completa que docx-preview
        // no posiciona bien (la mete en un contenedor 0×0 fuera de la hoja). La
        // detectamos (tamaño ≈ página) y la aplicamos como fondo de cada hoja.
        if (cancelled || !ref.current) return;
        const wrapper = ref.current.querySelector('.docx-wrapper');
        if (!wrapper) return;
        let bgUrl: string | null = null;
        wrapper.querySelectorAll<HTMLImageElement>('header img, footer img').forEach((img) => {
          const w = parseFloat(img.style.width) || 0;   // pt
          const h = parseFloat(img.style.height) || 0;
          if (w > 400 && h > 600) {                      // imagen del tamaño de la hoja → membrete
            bgUrl = img.getAttribute('src');
            img.style.display = 'none';                  // ocultar la copia mal posicionada
          }
        });
        if (bgUrl) {
          wrapper.querySelectorAll<HTMLElement>('section.docx').forEach((sec) => {
            sec.style.backgroundImage = `url("${bgUrl}")`;
            sec.style.backgroundSize = '100% 100%';
            sec.style.backgroundRepeat = 'no-repeat';
          });
        }
      })
      .catch((e) => { if (!cancelled) setErr(e instanceof Error ? e.message : 'error'); });
    return () => { cancelled = true; };
  }, [url]);

  if (err) {
    return (
      <div className="h-full flex items-center justify-center text-center text-gray-500 text-sm p-6">
        No se pudo mostrar el Word ({err}). Usa <span className="font-medium">&nbsp;Abrir / descargar</span>.
      </div>
    );
  }
  return <div ref={ref} className="w-full h-full overflow-auto bg-gray-100 py-4" />;
}

/** Renderiza un .xlsx/.xls como tabla en el navegador (una pestaña por hoja). */
function XlsxViewer({ url }: { url: string }) {
  const [sheets, setSheets] = useState<{ name: string; html: string }[]>([]);
  const [active, setActive] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setErr(null);
    setSheets([]);
    fetch(url)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })
      .then((buf) => {
        if (cancelled) return;
        const wb = XLSX.read(buf, { type: 'array' });
        setSheets(wb.SheetNames.map((name) => ({
          name,
          html: XLSX.utils.sheet_to_html(wb.Sheets[name], { editable: false }),
        })));
        setActive(0);
      })
      .catch((e) => { if (!cancelled) setErr(e instanceof Error ? e.message : 'error'); });
    return () => { cancelled = true; };
  }, [url]);

  if (err) {
    return (
      <div className="h-full flex items-center justify-center text-center text-gray-500 text-sm p-6">
        No se pudo mostrar el Excel ({err}). Usa <span className="font-medium">&nbsp;Abrir / descargar</span>.
      </div>
    );
  }
  if (!sheets.length) return <div className="h-full flex items-center justify-center text-gray-400 text-sm">Cargando…</div>;

  return (
    <div className="h-full flex flex-col">
      {sheets.length > 1 && (
        <div className="flex gap-1 px-2 py-1.5 border-b border-gray-100 bg-gray-50 flex-shrink-0">
          {sheets.map((s, i) => (
            <button key={s.name} onClick={() => setActive(i)}
              className={`px-3 py-1 rounded-lg text-xs font-medium ${i === active ? 'bg-emerald-100 text-emerald-700' : 'text-gray-500 hover:bg-gray-100'}`}>
              {s.name}
            </button>
          ))}
        </div>
      )}
      <div className="flex-1 overflow-auto p-3 bg-white xlsx-view"
        dangerouslySetInnerHTML={{ __html: sheets[active].html }} />
    </div>
  );
}

/** Visor embebido de un archivo por URL: .docx y .xlsx en el navegador, PDF en iframe. */
function FileViewer({ url, label }: { url?: string | null; label: string }) {
  if (!url) {
    return (
      <div className="h-full flex items-center justify-center text-gray-400 text-sm">
        No hay {label} para esta demanda.
      </div>
    );
  }
  if (/\.docx?(\?|$)/i.test(url)) return <DocxViewer url={url} />;
  if (/\.xlsx?(\?|$)/i.test(url)) return <XlsxViewer url={url} />;
  // PDF y demás → iframe directo (los PDF sí se renderizan).
  return <iframe title={label} src={url} className="w-full h-full border-0 bg-white" />;
}

function NotesPanel({ notes }: { notes?: DocumentNote[] | null }) {
  if (!notes || notes.length === 0) {
    return (
      <div className="p-6 text-sm text-gray-400">
        Sin notas: el motor no reportó faltantes ni avisos para esta demanda.
      </div>
    );
  }
  return (
    <ul className="p-4 space-y-2 overflow-auto h-full">
      {notes.map((n, i) => {
        const warn = n.nivel === 'warning';
        return (
          <li
            key={i}
            className={`flex gap-2.5 p-3 rounded-xl border text-sm ${
              warn
                ? 'bg-amber-50 border-amber-200 text-amber-800'
                : 'bg-sky-50 border-sky-200 text-sky-800'
            }`}
          >
            <span className="mt-0.5">{warn ? '⚠️' : 'ℹ️'}</span>
            <div>
              <p className="font-medium leading-snug">{n.mensaje}</p>
              <p className="text-xs opacity-60 mt-0.5">{n.campo}</p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

const RIGHT_TABS: { id: RightTab; label: string }[] = [
  { id: 'anexos', label: 'Anexos' },
  { id: 'antecedentes', label: 'Antecedentes' },
  { id: 'asignacion', label: 'Asignación' },
  { id: 'notas', label: 'Notas' },
];

function rightUrl(doc: Document, tab: RightTab): string | null | undefined {
  if (tab === 'anexos') return doc.anexosUrl;
  if (tab === 'antecedentes') return doc.antecedentesUrl;
  if (tab === 'asignacion') return doc.asignacionUrl;
  return null;
}

export function DocumentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { document, isLoading, error, sign } = useDocument(id!);
  const [showSignModal, setShowSignModal] = useState(false);
  const [tab, setTab] = useState<RightTab>('anexos');

  if (isLoading) {
    return (
      <div className="p-8">
        <div className="animate-pulse grid grid-cols-2 gap-4">
          <div className="h-[70vh] bg-gray-200 rounded-xl" />
          <div className="h-[70vh] bg-gray-200 rounded-xl" />
        </div>
      </div>
    );
  }

  if (error || !document) {
    return (
      <div className="p-8 flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-500 mb-3">{error ?? 'Documento no encontrado'}</p>
          <button onClick={() => navigate('/documents')} className="text-purple-600 text-sm hover:underline">
            ← Volver a documentos
          </button>
        </div>
      </div>
    );
  }

  const canSign = document.status === 'GENERATED';
  const warnings = (document.notes ?? []).filter((n) => n.nivel === 'warning').length;

  return (
    <div className="p-4 lg:p-6 h-[calc(100vh-1rem)] flex flex-col">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-4">
        <div className="min-w-0">
          <button
            onClick={() => navigate('/documents')}
            className="flex items-center gap-1.5 text-gray-500 hover:text-gray-700 text-sm mb-2 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Volver a documentos
          </button>
          <h1 className="text-xl font-bold text-gray-900 truncate">{document.title}</h1>
          <p className="text-gray-500 text-xs mt-0.5">
            {document.clientCedula ? `CC ${document.clientCedula} · ` : ''}
            Creado el {format(new Date(document.createdAt), "d 'de' MMMM 'de' yyyy", { locale: es })}
          </p>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          <DocumentStatusBadge status={document.status} />
          {canSign && (
            <button
              onClick={() => setShowSignModal(true)}
              className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-xl text-sm font-semibold transition-colors"
            >
              Firmar
            </button>
          )}
        </div>
      </div>

      {/* Visor de 2 paneles: demanda (izq) | anexos/antecedentes/asignación/notas (der) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 flex-1 min-h-0">
        {/* IZQUIERDA — la demanda */}
        <div className="flex flex-col border border-gray-200 rounded-xl overflow-hidden bg-gray-50">
          <div className="flex items-center justify-between px-4 py-2.5 bg-white border-b border-gray-100">
            <span className="text-sm font-semibold text-gray-700">Demanda</span>
            {document.fileUrl && (
              <a href={document.fileUrl} target="_blank" rel="noopener noreferrer"
                 className="text-xs text-purple-600 hover:underline">Abrir / descargar</a>
            )}
          </div>
          <div className="flex-1 min-h-0">
            {document.fileUrl && /\.docx?(\?|$)/i.test(document.fileUrl) ? (
              <Suspense fallback={<div className="h-full flex items-center justify-center text-gray-400 text-sm">Cargando editor…</div>}>
                <DemandEditor
                  url={document.fileUrl}
                  documentId={document.id}
                  canEdit={document.status !== 'SIGNED'}
                />
              </Suspense>
            ) : (
              <FileViewer url={document.fileUrl} label="demanda" />
            )}
          </div>
        </div>

        {/* DERECHA — anexos / antecedentes / asignación / notas */}
        <div className="flex flex-col border border-gray-200 rounded-xl overflow-hidden bg-gray-50">
          <div className="flex items-center gap-1 px-2 py-1.5 bg-white border-b border-gray-100 overflow-x-auto">
            {RIGHT_TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
                  tab === t.id ? 'bg-purple-100 text-purple-700' : 'text-gray-500 hover:bg-gray-100'
                }`}
              >
                {t.label}
                {t.id === 'notas' && warnings > 0 && (
                  <span className="ml-1.5 inline-flex items-center justify-center w-4 h-4 text-[10px] font-bold text-white bg-amber-500 rounded-full">
                    {warnings}
                  </span>
                )}
              </button>
            ))}
          </div>
          <div className="flex-1 min-h-0 bg-white">
            {tab === 'notas' ? (
              <NotesPanel notes={document.notes} />
            ) : (
              <FileViewer url={rightUrl(document, tab)} label={tab} />
            )}
          </div>
        </div>
      </div>

      {showSignModal && (
        <SignatureModal
          document={document}
          onConfirm={async () => { await sign(); setShowSignModal(false); }}
          onClose={() => setShowSignModal(false)}
        />
      )}
    </div>
  );
}
