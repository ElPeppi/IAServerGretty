import { useEffect, useRef, useState, type MouseEvent } from 'react';
import * as XLSX from 'xlsx';

/**
 * Visor de la ASIGNACIÓN (.xlsx/.xls) embebido. Muestra cada hoja como una tabla
 * de SOLO LECTURA; al hacer clic en una fila, ésta se resalta.
 *
 * El resaltado existe para no perder el renglón: la asignación es el Excel del
 * LOTE completo (decenas de clientes, muchas columnas) y hay que leer a lo ancho
 * la fila de un cliente concreto.
 *
 * NO se edita a propósito. Este mismo archivo es el del lote entero, compartido
 * por todas las demandas de la asignación, y guardarlo desde aquí obligaba a
 * reconstruir el libro desde el DOM, perdiendo fórmulas y formato.
 */
export function AsignacionEditor({ url }: { url: string }) {
  const [sheets, setSheets] = useState<{ name: string; html: string }[]>([]);
  const [active, setActive] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [filaActiva, setFilaActiva] = useState<HTMLTableRowElement | null>(null);
  const hojasRef = useRef<Record<string, HTMLDivElement | null>>({});

  useEffect(() => {
    let cancelled = false;
    setErr(null);
    setSheets([]);
    setFilaActiva(null);
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

  /**
   * El HTML de las tablas se inyecta A MANO, no con dangerouslySetInnerHTML.
   *
   * Con dangerouslySetInnerHTML, React 19 reescribe el <table> en CADA re-render
   * aunque el string no haya cambiado. Eso borraría el resaltado en cuanto otro
   * estado cambiara (p. ej. al cambiar de hoja). Así, `sheets` solo cambia de
   * identidad al cargar un archivo: el efecto corre una vez por carga y los
   * re-renders normales no tocan las tablas.
   */
  useEffect(() => {
    for (const s of sheets) {
      const el = hojasRef.current[s.name];
      if (el) el.innerHTML = s.html;
    }
  }, [sheets]);

  /** Resalta solo la fila indicada (null = ninguna). */
  const seleccionarFila = (fila: HTMLTableRowElement | null) => {
    if (filaActiva && filaActiva !== fila) filaActiva.classList.remove('fila-activa');
    if (fila) fila.classList.add('fila-activa');
    setFilaActiva(fila);
  };

  const handleClick = (e: MouseEvent<HTMLDivElement>) => {
    const fila = (e.target as HTMLElement).closest('tr') as HTMLTableRowElement | null;
    if (!fila) return;
    // Volver a pulsar la fila resaltada la deselecciona.
    seleccionarFila(fila === filaActiva ? null : fila);
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
      {/* Toolbar: pestañas de hoja */}
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-gray-100 bg-white flex-shrink-0">
        <div className="flex gap-1 flex-1 min-w-0 overflow-x-auto">
          {sheets.map((s, i) => (
            // Cambiar de hoja suelta el resaltado: quedaría en una hoja que no se ve.
            <button key={s.name} onClick={() => { seleccionarFila(null); setActive(i); }}
              className={`px-3 py-1 rounded-lg text-xs font-medium whitespace-nowrap ${i === active ? 'bg-emerald-100 text-emerald-700' : 'text-gray-500 hover:bg-gray-100'}`}>
              {s.name}
            </button>
          ))}
        </div>
        <span className="text-[11px] text-gray-400 whitespace-nowrap">
          {filaActiva ? 'Clic de nuevo para quitar el resaltado' : 'Clic en una fila para resaltarla'}
        </span>
      </div>

      {/* Tablas: solo la activa visible */}
      <div className="flex-1 overflow-auto bg-white xlsx-view filas-seleccionables" onClick={handleClick}>
        {sheets.map((s, i) => (
          // Sin dangerouslySetInnerHTML a propósito: el contenido lo pone el
          // efecto de arriba. React solo gestiona el div y su `display`.
          <div
            key={s.name}
            ref={(el) => { hojasRef.current[s.name] = el; }}
            style={{ display: i === active ? 'block' : 'none' }}
            className="p-3"
          />
        ))}
      </div>
    </div>
  );
}
