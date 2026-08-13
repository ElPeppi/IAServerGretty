import { createContext, useContext, useEffect, useRef, useState, useCallback, type ReactNode } from 'react';
import { useAuth } from './AuthContext';

export type NotificationLevel = 'success' | 'error' | 'info' | 'warning';

export interface AppNotification {
  id: string;
  type: string;
  level: NotificationLevel;
  title: string;
  message: string;
  at: string;
  meta?: Record<string, unknown>;
  read?: boolean;
}

interface NotificationContextValue {
  items: AppNotification[];
  unread: number;
  connected: boolean;
  markAllRead: () => void;
  clearAll: () => void;
}

const NotificationContext = createContext<NotificationContextValue | null>(null);

/**
 * Escucha el canal SSE del backend (/api/notifications/stream) y reparte a la
 * página las notificaciones de tareas en segundo plano (generación de demandas,
 * extracción de ZIPs). Muestra toasts y mantiene la lista para la campana.
 * Se conecta a TODOS los logueados (cada pestaña abre su propia conexión).
 */
export function NotificationProvider({ children }: { children: ReactNode }) {
  const { token } = useAuth();
  const [items, setItems] = useState<AppNotification[]>([]);
  const [toasts, setToasts] = useState<AppNotification[]>([]);
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const seen = useRef<Set<string>>(new Set());

  const dismissToast = useCallback((id: string) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  // Si pasa este tiempo sin recibir NADA (ni latido), la conexión se da por muerta
  // y se rehace. El backend late cada 25 s.
  const SIN_SENAL_MS = 70000;
  const REVISION_MS = 15000;

  useEffect(() => {
    if (!token) {
      esRef.current?.close();
      esRef.current = null;
      setConnected(false);
      return;
    }

    let cerrado = false;               // el efecto se desmontó → no reconectar más
    let es: EventSource | null = null;
    let ultimaSenal = Date.now();
    let reintentos = 0;

    const conectar = () => {
      if (cerrado) return;
      es?.close();
      // EventSource no permite headers → el token va por query (lo valida el backend).
      es = new EventSource(`/api/notifications/stream?token=${encodeURIComponent(token)}`);
      esRef.current = es;
      ultimaSenal = Date.now();

      es.onopen = () => { reintentos = 0; ultimaSenal = Date.now(); setConnected(true); };

      es.onerror = () => {
        setConnected(false);
        // EventSource solo reintenta ante errores de RED. Si el servidor CONTESTA
        // con algo que no sea 200 text/event-stream (p. ej. el 502 que devuelve el
        // proxy de Vite mientras el backend reinicia), el navegador cierra el canal
        // para siempre → hay que reconectar a mano.
        if (es && es.readyState === EventSource.CLOSED) reconectarConEspera();
      };

      es.onmessage = (ev) => {
        ultimaSenal = Date.now();       // cualquier mensaje, incluido el latido
        setConnected(true);
        try {
          const n = JSON.parse(ev.data) as AppNotification;
          if (!n?.id || seen.current.has(n.id)) return; // de-dup (incluye reenvíos al reconectar)
          seen.current.add(n.id);
          setItems((prev) => [{ ...n, read: false }, ...prev].slice(0, 100));
          setToasts((prev) => [n, ...prev].slice(0, 4));
          window.setTimeout(() => dismissToast(n.id), 6000);
        } catch {
          /* mensaje no-JSON: ignorar */
        }
      };
    };

    let tempReconexion: number | undefined;
    const reconectarConEspera = () => {
      if (cerrado || tempReconexion) return;
      const espera = Math.min(30000, 1000 * 2 ** reintentos++); // 1s, 2s, 4s… máx 30s
      tempReconexion = window.setTimeout(() => { tempReconexion = undefined; conectar(); }, espera);
    };

    // Vigilante: el proxy de Vite puede dejar el socket ABIERTO aunque el backend
    // se haya caído. Ahí el navegador nunca lanza `onerror` y la pestaña se queda
    // en silencio creyendo que está conectada. Se detecta por falta de latidos.
    const vigilante = window.setInterval(() => {
      if (cerrado) return;
      if (Date.now() - ultimaSenal > SIN_SENAL_MS) {
        setConnected(false);
        reintentos = 0;
        conectar();                     // reconexión inmediata: la anterior está muerta
      }
    }, REVISION_MS);

    conectar();

    return () => {
      cerrado = true;
      window.clearInterval(vigilante);
      if (tempReconexion) window.clearTimeout(tempReconexion);
      es?.close();
      esRef.current = null;
    };
  }, [token, dismissToast]);

  const unread = items.filter((i) => !i.read).length;
  const markAllRead = () => setItems((prev) => prev.map((i) => ({ ...i, read: true })));
  const clearAll = () => setItems([]);

  return (
    <NotificationContext.Provider value={{ items, unread, connected, markAllRead, clearAll }}>
      {children}
      <ToastStack toasts={toasts} onClose={dismissToast} />
    </NotificationContext.Provider>
  );
}

export function useNotifications() {
  const ctx = useContext(NotificationContext);
  if (!ctx) throw new Error('useNotifications must be used within NotificationProvider');
  return ctx;
}

/**
 * Llama a `onRefresh` cuando llega una notificación NUEVA de los tipos indicados
 * (por defecto las tareas de fondo: generación, ZIPs, motor). Sirve para que las
 * vistas (dashboard, observaciones) se actualicen solas cuando el backend avisa
 * que terminó una tarea, sin tener que recargar la página. El backlog que llega
 * al conectar (replay buffer) NO dispara refresco.
 */
export function useRefreshOnNotification(
  onRefresh: () => void,
  types: string[] = ['generacion', 'zips', 'engine'],
) {
  const { items } = useNotifications();
  const cb = useRef(onRefresh);
  cb.current = onRefresh;
  const typesRef = useRef(types);
  typesRef.current = types;
  const lastSeen = useRef<string | null>(null);

  useEffect(() => {
    const latest = items[0];
    if (!latest) return;
    // Primera ejecución: marcar el backlog como visto, no refrescar.
    if (lastSeen.current === null) { lastSeen.current = latest.id; return; }
    if (latest.id === lastSeen.current) return;
    lastSeen.current = latest.id;
    if (typesRef.current.includes(latest.type)) cb.current();
  }, [items]);
}

// ─── Estilos por nivel ────────────────────────────────────────────────────────
export const LEVEL_STYLES: Record<NotificationLevel, { bar: string; chip: string; icon: string }> = {
  success: { bar: 'border-l-green-500',  chip: 'bg-green-100 text-green-700',   icon: '✓' },
  error:   { bar: 'border-l-red-500',    chip: 'bg-red-100 text-red-700',       icon: '✕' },
  warning: { bar: 'border-l-amber-500',  chip: 'bg-amber-100 text-amber-700',   icon: '!' },
  info:    { bar: 'border-l-purple-500', chip: 'bg-purple-100 text-purple-700', icon: 'i' },
};

// ─── Toasts (esquina inferior derecha) ────────────────────────────────────────
function ToastStack({ toasts, onClose }: { toasts: AppNotification[]; onClose: (id: string) => void }) {
  if (!toasts.length) return null;
  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 w-80 max-w-[calc(100vw-2rem)]">
      {toasts.map((t) => {
        const s = LEVEL_STYLES[t.level] ?? LEVEL_STYLES.info;
        return (
          <div
            key={t.id}
            className={`bg-white rounded-xl shadow-lg border border-gray-100 border-l-4 ${s.bar} p-3 flex gap-3 animate-[fadeIn_0.2s_ease-out]`}
          >
            <span className={`flex-shrink-0 w-6 h-6 rounded-full grid place-items-center text-xs font-bold ${s.chip}`}>
              {s.icon}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-gray-900 truncate">{t.title}</p>
              <p className="text-xs text-gray-600 break-words">{t.message}</p>
            </div>
            <button
              onClick={() => onClose(t.id)}
              className="flex-shrink-0 text-gray-300 hover:text-gray-500 text-lg leading-none"
              aria-label="Cerrar"
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
