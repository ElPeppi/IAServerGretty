/**
 * routes/poderes.routes.js — Generación del Word COMBINADO de poderes por asignación
 *
 *   POST /generar-poderes → recibe las filas de la asignación y arma UN solo Word
 *     con todos los poderes (uno por cliente, salto de página), como el consolidado
 *     que la oficina hace a mano. Lo guarda en la carpeta PODERES y lo devuelve en
 *     base64 para que el backend lo referencie/sirva.
 *
 *   Nº de pagaré del poder («OBLIGACION» de la plantilla):
 *     - docsEnServidor = true  → se lee del certificado DECEVAL del cliente. Si el
 *       cliente no tiene documentos en el servidor, o son ANTERIORES a la fecha de
 *       asignación (docs viejos), se EXCLUYE (su demanda tampoco debería generarse).
 *     - docsEnServidor = false → se usa la OBLIGACION del Excel para todos.
 */

'use strict';

const express = require('express');
const fs      = require('fs');
const path    = require('path');

const config = require('../config');
const { generarPoderesCombinado } = require('../services/singular/poderes');
const { leerDatosDeDeceval } = require('../services/singular/carpetaCliente');
const { resolverCarpetaLectura, mkdirpSync } = require('../utils/carpetas');

const router = express.Router();

// "DD/MM/YYYY" o ISO → Date (o null).
function parseFechaAsig(s) {
  if (!s) return null;
  const str = String(s).trim();
  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

// Documentos (PDFs) del cliente en su carpeta + fecha de modificación más reciente.
function docsDelCliente(outBase, cedula) {
  const dir = resolverCarpetaLectura(outBase, cedula);
  if (!fs.existsSync(dir)) return { existe: false, mtimeMax: 0 };
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => /\.pdf$/i.test(f)); } catch { /* noop */ }
  if (!files.length) return { existe: false, mtimeMax: 0 };
  let mtimeMax = 0;
  for (const f of files) {
    try { const st = fs.statSync(path.join(dir, f)); if (st.mtimeMs > mtimeMax) mtimeMax = st.mtimeMs; } catch { /* noop */ }
  }
  return { existe: true, mtimeMax };
}

// ─── POST /generar-poderes ────────────────────────────────────────────────────
// Body: { filas:[...], docsEnServidor?, fechaAsignacion?, nombre?, outputBaseDir? }
router.post('/generar-poderes', async (req, res) => {
  const filas = Array.isArray(req.body.filas) ? req.body.filas : [];
  if (!filas.length) {
    return res.status(400).json({ success: false, error: 'No se recibieron filas de asignación.' });
  }

  const docsEnServidor = !!req.body.docsEnServidor;
  const fechaAsig      = parseFechaAsig(req.body.fechaAsignacion);
  const fechaAsigMin   = fechaAsig ? new Date(fechaAsig.getFullYear(), fechaAsig.getMonth(), fechaAsig.getDate()).getTime() : null;
  const outBase        = req.body.outputBaseDir || config.OUT_DIR;
  const nombreLote     = String(req.body.nombre || 'ASIGNACION').replace(/[<>:"/\\|?*]/g, ' ').trim();

  console.log(`[${new Date().toISOString()}] /generar-poderes: ${filas.length} fila(s), docsEnServidor=${docsEnServidor}`);

  const items     = [];   // → generarPoderesCombinado
  const metaPorCedula = new Map();
  const excluidos = [];

  for (const fila of filas) {
    const cedula = String(fila['IDENTIFICACION'] || '').trim();
    if (!cedula) continue;
    const nombre = String(fila['NOMBRE'] || '').trim();

    let pagare = String(fila['OBLIGACION'] || '').trim(); // por defecto: OBLIGACION del Excel
    let pagareDesdeDocs = false;

    if (docsEnServidor) {
      const info = docsDelCliente(outBase, cedula);
      if (!info.existe) {
        excluidos.push({ cedula, nombre, motivo: 'sin documentos en el servidor' });
        continue;
      }
      if (fechaAsigMin != null && info.mtimeMax < fechaAsigMin) {
        excluidos.push({ cedula, nombre, motivo: 'los documentos son anteriores a la fecha de asignación' });
        continue;
      }
      try {
        const deceval = await leerDatosDeDeceval(cedula, outBase);
        if (deceval.certificadoValido && deceval.numeroPagare) {
          pagare = String(deceval.numeroPagare).trim();
          pagareDesdeDocs = true;
        }
      } catch (e) {
        console.error(`[/generar-poderes] ${cedula}: no se pudo leer DECEVAL: ${e.message}`);
      }
    }

    items.push({ fila, pagare });
    metaPorCedula.set(cedula, {
      nombre,
      ciudadJuzgado: String(fila['CIUDAD DE JUZGADO'] || '').trim(),
      tipoJuzgado:   String(fila['TIPO DE JUZGADO']   || '').trim(),
      numeroPagare:  pagare,
      pagareDesdeDocs,
    });
  }

  if (!items.length) {
    return res.status(422).json({
      success: false,
      error: 'Ningún cliente quedó válido para generar poderes.',
      excluidos,
    });
  }

  let buffer, clientesGen;
  try {
    ({ buffer, clientes: clientesGen } = generarPoderesCombinado(items, config.PLANTILLA_PODER));
  } catch (e) {
    console.error(`[/generar-poderes] error armando el Word: ${e.message}`);
    return res.status(500).json({ success: false, error: e.message });
  }

  // Guardar el Word combinado en la carpeta PODERES/{año}.
  const anio   = fechaAsig ? fechaAsig.getFullYear() : new Date().getFullYear();
  const poderDir = path.join(config.ANEXOS_DIR_PODERES, String(anio));
  const filename = `PODERES EJECUTIVOS ${nombreLote}.docx`;
  let savedPath = null;
  try {
    mkdirpSync(poderDir);
    savedPath = path.join(poderDir, filename);
    fs.writeFileSync(savedPath, buffer);
    console.log(`[/generar-poderes] Word guardado: ${savedPath}`);
  } catch (e) {
    console.error(`[/generar-poderes] no se pudo guardar en PODERES: ${e.message}`);
  }

  // Enriquecer los clientes generados con la metadata (ciudad/juzgado, origen del pagaré).
  const clientes = clientesGen.map(c => ({ ...c, ...(metaPorCedula.get(c.cedula) || {}) }));

  const ok = clientes.length;
  console.log(`[/generar-poderes] completado: ${ok} poder(es), ${excluidos.length} excluido(s)`);
  return res.json({
    success: true,
    poderFilename: filename,
    poderPath: savedPath,
    poderBase64: buffer.toString('base64'),
    docsEnServidor,
    clientes,
    excluidos,
  });
});

module.exports = router;
