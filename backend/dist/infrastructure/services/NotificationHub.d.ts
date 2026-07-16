import { Response } from 'express';
export type NotificationLevel = 'success' | 'error' | 'info' | 'warning';
export interface Notification {
    id: string;
    type: string;
    level: NotificationLevel;
    title: string;
    message: string;
    at: string;
    meta?: Record<string, unknown>;
}
/**
 * Hub de notificaciones en tiempo real (Server-Sent Events). Mantiene la lista de
 * clientes conectados (las pestañas de los usuarios logueados) y les RETRANSMITE
 * los eventos de tareas en segundo plano (generación de demandas, extracción de
 * ZIPs, …). En memoria: si el backend se reinicia, los clientes se reconectan
 * solos (EventSource reintenta) y reciben las notificaciones recientes.
 */
declare class NotificationHub {
    private clients;
    private recent;
    addClient(res: Response): void;
    removeClient(res: Response): void;
    clientCount(): number;
    /** Emite una notificación a TODOS los clientes conectados. */
    broadcast(input: Omit<Notification, 'id' | 'at'> & Partial<Pick<Notification, 'id' | 'at'>>): Notification;
    private write;
}
export declare const notificationHub: NotificationHub;
export {};
//# sourceMappingURL=NotificationHub.d.ts.map