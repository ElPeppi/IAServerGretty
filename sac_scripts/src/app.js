/**
 * app.js — Ensamblado de la aplicación Express
 *
 * Middlewares globales + registro de rutas. No contiene lógica de negocio.
 */

'use strict';

const express = require('express');

const config = require('./config');

const app = express();

// CORS — permite llamadas desde file:// y cualquier origen local (test_singular.html)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Permite recibir JSON grande (base64 de varios ZIPs)
app.use(express.json({ limit: '100mb' }));

// ─── Rutas ────────────────────────────────────────────────────────────────────

app.use(require('./routes/zips.routes'));
app.use(require('./routes/singular.routes'));
app.use(require('./routes/ocr.routes'));

app.get('/health', (_, res) => res.json({ status: 'ok', port: config.PORT, outDir: config.OUT_DIR }));

module.exports = app;
