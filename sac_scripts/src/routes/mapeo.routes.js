/**
 * routes/mapeo.routes.js — Mapeo inteligente de columnas, expuesto por HTTP.
 *
 *   POST /mapear-columnas  { headers: string[], filas: any[][] }
 *     → { success, mapeo: { CAMPO: idx }, porNombre: { CAMPO: "ENCABEZADO" } }
 *
 * Es un envoltorio delgado sobre services/singular/mapeoColumnas.js — la misma
 * lógica que usa el motor al generar (heurística + Ollama local, con validación
 * de contenido y caché por firma de encabezados). Existe para que el BACKEND no
 * duplique su propia versión ingenua: una sola fuente de verdad de "qué columna
 * es qué".
 *
 * `porNombre` devuelve el ENCABEZADO además del índice: el backend guarda las
 * filas como objetos en Postgres (jsonb), que NO conserva el orden original de
 * las claves, así que un índice no le sirve.
 */
'use strict';

const express = require('express');
const { mapearColumnas } = require('../services/singular/mapeoColumnas');

const router = express.Router();

router.post('/mapear-columnas', async (req, res) => {
  const headers = Array.isArray(req.body?.headers) ? req.body.headers : null;
  const filas = Array.isArray(req.body?.filas) ? req.body.filas : [];
  if (!headers || headers.length === 0) {
    return res.status(400).json({ success: false, error: 'Falta headers: string[]' });
  }

  try {
    const mapeo = await mapearColumnas(headers, filas);
    const porNombre = {};
    for (const [campo, idx] of Object.entries(mapeo)) {
      const h = headers[idx];
      if (h != null && String(h).trim() !== '') porNombre[campo] = String(h);
    }
    return res.json({ success: true, mapeo, porNombre });
  } catch (e) {
    console.error(`[/mapear-columnas] ${e.message}`);
    return res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
