"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.notificationHub = void 0;
/**
 * Hub de notificaciones en tiempo real (Server-Sent Events). Mantiene la lista de
 * clientes conectados (las pestañas de los usuarios logueados) y les RETRANSMITE
 * los eventos de tareas en segundo plano (generación de demandas, extracción de
 * ZIPs, …). En memoria: si el backend se reinicia, los clientes se reconectan
 * solos (EventSource reintenta) y reciben las notificaciones recientes.
 */
class NotificationHub {
    constructor() {
        this.clients = new Set();
        this.recent = []; // buffer para clientes que se conectan tarde
    }
    addClient(res) {
        this.clients.add(res);
        // Reenviar las recientes al conectar (para no perder lo que pasó hace un momento).
        for (const n of this.recent)
            this.write(res, n);
    }
    removeClient(res) {
        this.clients.delete(res);
    }
    clientCount() {
        return this.clients.size;
    }
    /** Emite una notificación a TODOS los clientes conectados. */
    broadcast(input) {
        const n = {
            id: input.id ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            at: input.at ?? new Date().toISOString(),
            type: input.type,
            level: input.level,
            title: input.title,
            message: input.message,
            meta: input.meta,
        };
        this.recent.push(n);
        if (this.recent.length > 50)
            this.recent.shift();
        for (const res of [...this.clients])
            this.write(res, n);
        return n;
    }
    write(res, n) {
        try {
            res.write(`data: ${JSON.stringify(n)}\n\n`);
        }
        catch {
            this.clients.delete(res);
        }
    }
}
// Singleton compartido por todo el backend.
exports.notificationHub = new NotificationHub();
//# sourceMappingURL=NotificationHub.js.map