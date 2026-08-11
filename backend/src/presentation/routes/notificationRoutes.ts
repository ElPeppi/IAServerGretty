import { Router } from 'express';
import { JwtService } from '../../infrastructure/services/JwtService';
import { notificationHub } from '../../infrastructure/services/NotificationHub';
import { subirSacDeCedula } from '../../infrastructure/storage/sacSync';

const router = Router();
const jwtService = new JwtService();

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
  } catch {
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

  notificationHub.addClient(res);

  // Heartbeat: comentario SSE cada 25 s para que proxies no corten la conexión.
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* el close lo limpia */ }
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    notificationHub.removeClient(res);
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
  const n = notificationHub.broadcast({
    type: type || 'engine',
    level: level || 'info',
    title: title || 'Motor',
    message: message || '',
    meta,
  });

  // El motor avisa por cédula cuando terminó de bajar su SAC (a SU disco). Al recibirlo,
  // subimos esos archivos a Drive para que el SAC también quede en el servidor, no solo
  // en local. En segundo plano (no bloquea la respuesta del aviso).
  if (type === 'sac' && meta && meta.fase === 'cedula' && meta.success && meta.cedula) {
    void subirSacDeCedula(String(meta.cedula));
  }

  res.json({ ok: true, id: n.id, clients: notificationHub.clientCount() });
});

export default router;
