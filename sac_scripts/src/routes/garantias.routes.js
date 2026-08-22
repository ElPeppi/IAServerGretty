/**
 * routes/garantias.routes.js — Generación de demandas del TRÁMITE DE PAGO DIRECTO
 * (garantía mobiliaria).
 *
 *   POST /generar-garantias → recibe el Excel de la asignación (multipart, campo
 *                             excelFile) y genera la SOLICITUD DE APREHENSIÓN Y
 *                             ENTREGA de cada cliente marcado como pago directo.
 *
 * Es el gemelo de singular.routes.js, pero con menos entradas: aquí no hay
 * cuantía que calcular (no aplica) ni Excel intermedio que devolver. Los datos
 * salen de los documentos que el banco dejó en la carpeta de cada cliente, no
 * del Excel.
 *
 * El correo de otorgamiento SÍ va, igual que en el singular: es el cuerpo sobre
 * el que se sobrepone el poder en el ANEXO 1. El que se elija tiene que ser el
 * de PAGO DIRECTO —los de ejecutivas singulares dicen otra cosa y van dirigidos
 * a otro trámite—; de eso se encarga quien llama (ver correosPoder.ts).
 */

'use strict';

const express = require('express');
const multer = require('multer');
const fs = require('fs');

const config = require('../config');
const { procesarGarantias } = require('../services/finandina/garantia');

const router = express.Router();
const upload = multer({ dest: config.TEMP_DIR });

// Body (multipart/form-data):
//   excelFile      – Excel de la asignación (obligatorio)
//   correoPoder?   – correo PDF del banco (pago directo) para el ANEXO 1
//   plantillaPath? – ruta server-side de la plantilla
//   soloCedulas?   – JSON ["123","456"] o "123,456" para regenerar solo esas
router.post(
  '/generar-garantias',
  upload.fields([{ name: 'excelFile', maxCount: 1 }, { name: 'correoPoder', maxCount: 1 }]),
  async (req, res) => {
    const tmpPath = req.files && req.files.excelFile && req.files.excelFile[0].path;
    const correoPath = req.files && req.files.correoPoder && req.files.correoPoder[0].path;
    const borrarTemporales = () => {
      for (const p of [tmpPath, correoPath]) {
        if (p) { try { fs.unlinkSync(p); } catch (e) { /* ya estaba borrado */ } }
      }
    };
    if (!tmpPath) {
      borrarTemporales();
      return res.status(400).json({ success: false, error: 'No se recibió el archivo Excel (campo: excelFile)' });
    }

    try {
      const excelBuffer = fs.readFileSync(tmpPath);
      const correoPoderBuffer = correoPath ? fs.readFileSync(correoPath) : null;
      borrarTemporales();

      let soloCedulas;
      if (req.body.soloCedulas) {
        try { soloCedulas = JSON.parse(req.body.soloCedulas); } catch (e) { soloCedulas = String(req.body.soloCedulas).split(','); }
        soloCedulas = (Array.isArray(soloCedulas) ? soloCedulas : [soloCedulas])
          .map((s) => String(s).trim()).filter(Boolean);
      }

      const resultado = await procesarGarantias(excelBuffer, {
        plantillaPath: req.body.plantillaPath || undefined,
        correoPoderBuffer,
        soloCedulas,
      });
      res.json(resultado);
    } catch (error) {
      console.error(`[/generar-garantias] ${error.message}`);
      borrarTemporales();
      res.status(500).json({ success: false, error: error.message });
    }
  },
);

module.exports = router;
