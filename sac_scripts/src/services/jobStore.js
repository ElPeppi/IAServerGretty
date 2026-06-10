/**
 * services/jobStore.js — Estado de jobs de procesamiento
 *
 * Guarda el estado de cada job para que n8n pueda hacer polling a
 * GET /job-status/:id hasta que status == 'done' | 'failed'.
 */

'use strict';

const jobStore = new Map();

// Limpia jobs con más de 4 horas cada 30 min para no acumular memoria
setInterval(() => {
  const cutoff = Date.now() - 4 * 60 * 60 * 1000;
  for (const [id, job] of jobStore) {
    if ((job.createdAt || 0) < cutoff) jobStore.delete(id);
  }
}, 30 * 60 * 1000);

module.exports = jobStore;
