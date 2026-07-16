"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const JwtService_1 = require("../../infrastructure/services/JwtService");
const NotificationHub_1 = require("../../infrastructure/services/NotificationHub");
const router = (0, express_1.Router)();
const jwtService = new JwtService_1.JwtService();
/**
 * GET /api/notifications/stream?token=JWT
 * Canal SSE: el navegador (EventSource) se suscribe aquí y recibe en vivo las
 * notificaciones de tareas en segundo plano. EventSource NO permite mandar el
 * header Authorization → el token va por query string.
 */
router.get('/stream', (req, res) => {
    const token = String(req.query.token || '');
    try {
        jwtService.verify(token);
    }
    catch {
        res.status(401).end();
        return;
    }
    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no', // evita el buffering de nginx
    });
    res.flushHeaders?.();
    res.write(': connected\n\n');
    NotificationHub_1.notificationHub.addClient(res);
    // Heartbeat: comentario SSE cada 25 s para que proxies no corten la conexión.
    const ping = setInterval(() => {
        try {
            res.write(': ping\n\n');
        }
        catch { /* el close lo limpia */ }
    }, 25000);
    req.on('close', () => {
        clearInterval(ping);
        NotificationHub_1.notificationHub.removeClient(res);
    });
});
/**
 * POST /api/notifications/engine
 * Endpoint INTERNO para que el MOTOR (sac_scripts, otro proceso) avise el fin de
 * sus pasos (p. ej. extracción de ZIPs). Autorizado con un secreto compartido
 * (ENGINE_NOTIFY_SECRET), no con el JWT de un usuario.
 */
router.post('/engine', (req, res) => {
    const secret = process.env.ENGINE_NOTIFY_SECRET || '';
    if (!secret || req.headers['x-engine-secret'] !== secret) {
        res.status(401).json({ message: 'no autorizado' });
        return;
    }
    const { type, level, title, message, meta } = req.body || {};
    const n = NotificationHub_1.notificationHub.broadcast({
        type: type || 'engine',
        level: level || 'info',
        title: title || 'Motor',
        message: message || '',
        meta,
    });
    res.json({ ok: true, id: n.id, clients: NotificationHub_1.notificationHub.clientCount() });
});
exports.default = router;
//# sourceMappingURL=notificationRoutes.js.map