/**
 * server.js — SAC Processor HTTP Server (punto de entrada)
 *
 * Recibe ZIPs desde n8n, extrae la cédula, organiza archivos
 * y lanza Puppeteer para automatizar el SAC.
 *
 * Inicio:  node server.js
 * Puerto:  http://localhost:3456
 *
 * Arquitectura (ver ARQUITECTURA.md):
 *   src/config.js   → variables de entorno y rutas
 *   src/app.js      → ensamblado Express (middlewares + rutas)
 *   src/routes/     → capa HTTP
 *   src/services/   → lógica de negocio
 *   src/domain/     → reglas puras del dominio
 *   src/utils/      → helpers genéricos
 */

'use strict';

const config = require('./src/config');
const app    = require('./src/app');

// Atado a 127.0.0.1: el motor NO tiene autenticación y dispara sesiones del SAC
// con las credenciales del banco. Solo el backend (misma máquina) debe llamarlo.
const HOST = process.env.HOST || '127.0.0.1';

app.listen(config.PORT, HOST, () => {
  console.log(`SAC Processor Server corriendo en http://${HOST}:${config.PORT}`);
  console.log(`  Carpeta salida : ${config.OUT_DIR}`);
  console.log(`  SAC URL        : ${config.SAC_URL}`);
  console.log(`  SAC usuario    : ${config.SAC_USER}`);
});
