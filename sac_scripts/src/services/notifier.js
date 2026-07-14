/**
 * services/notifier.js — Avisa al backend el fin de pasos del motor.
 *
 * POST {SAC_NOTIFY_URL} con el secreto compartido (x-engine-secret). El backend
 * lo retransmite por SSE a los usuarios logueados. Es BEST-EFFORT: si falla o no
 * está configurado (faltan SAC_NOTIFY_URL / SAC_NOTIFY_SECRET), no rompe el flujo.
 * Usa fetch global (Node 18+), sin dependencias nuevas.
 */
'use strict';

const config = require('../config');

async function notificarBackend(evento) {
  if (!config.NOTIFY_URL || !config.NOTIFY_SECRET) return; // notificaciones desactivadas
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    await fetch(config.NOTIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-engine-secret': config.NOTIFY_SECRET },
      body: JSON.stringify(evento),
      signal: ctrl.signal,
    });
    clearTimeout(t);
  } catch (e) {
    console.warn(`[NOTIFY] no se pudo avisar al backend: ${e.message}`);
  }
}

module.exports = { notificarBackend };
