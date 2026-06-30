/**
 * routes/ocr.routes.js — OCR de PDFs escaneados.
 *
 *   POST /ocr  (multipart, campo "file")  → { text, pages[], campos }
 *   Opcional: body.scale (DPI relativo, def. 3)
 */
'use strict';

const express = require('express');
const multer  = require('multer');
const fs      = require('fs');

const config = require('../config');
const { ocrPdf, extraerCamposPagare } = require('../services/ocr');

const router = express.Router();
const upload = multer({ dest: config.TEMP_DIR });

router.post('/ocr', upload.single('file'), async (req, res) => {
  const tmp = req.file?.path;
  if (!tmp) {
    return res.status(400).json({ success: false, error: 'Falta el PDF (campo: file)' });
  }
  try {
    const buf = fs.readFileSync(tmp);
    try { fs.unlinkSync(tmp); } catch (_) {}
    const scale = parseInt(req.body.scale || '3', 10);
    const r = await ocrPdf(buf, { scale: Number.isFinite(scale) ? scale : 3 });
    res.json({
      success:  true,
      numPages: r.numPages,
      pages:    r.pages,
      text:     r.text,
      campos:   extraerCamposPagare(r.text),
    });
  } catch (e) {
    if (tmp && fs.existsSync(tmp)) { try { fs.unlinkSync(tmp); } catch (_) {} }
    console.error(`[OCR] ${e.message}`);
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
