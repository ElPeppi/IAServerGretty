#!/usr/bin/env node
/**
 * probe_vision.js — Comprueba que Google Cloud Vision está listo para usarse.
 *
 * Valida en un solo golpe las tres cosas que fallan al estrenar el proyecto:
 * que la clave sea legible y del proyecto correcto, que la Vision API esté
 * HABILITADA, y que el proyecto tenga FACTURACIÓN activa (hace falta aunque te
 * quedes dentro de la capa gratuita). Manda una imagen mínima generada aquí, así
 * que no consume cuota apreciable ni necesita un pagaré.
 *
 * Uso (en sac_scripts, en el servidor):
 *   node probe_vision.js
 *
 * Para probar sobre un pagaré de verdad, usa probe_ocr.js con OCR_MOTOR=vision:
 *   OCR_MOTOR=vision node probe_ocr.js "/docs/DEMANDAS/.../pagare.pdf"
 */

'use strict';

const fs = require('fs');
const config = require('./src/config');
const { ocrImagenes } = require('./src/services/visionOcr');

// PNG válido de 1x1 px. Vision devolverá "sin texto", que es exactamente lo que
// se quiere: la respuesta 200 prueba credencial + API + facturación.
const PNG_MINIMO = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

(async () => {
  console.log('— Sonda Vision —');
  console.log(`OCR_MOTOR     : ${config.OCR_MOTOR}`);
  console.log(`VISION_SA_KEY : ${config.VISION_SA_KEY || '(sin configurar)'}`);

  if (!config.VISION_SA_KEY) {
    console.log('\n✗ Falta VISION_SA_KEY en el .env del motor (sac_scripts/.env).');
    process.exit(2);
  }
  if (!fs.existsSync(config.VISION_SA_KEY)) {
    console.log('\n✗ Esa ruta no existe. Revisa que la clave esté donde dice el .env.');
    process.exit(2);
  }

  // Se leen SOLO los campos identificativos; la clave privada nunca se imprime.
  let clave;
  try {
    clave = JSON.parse(fs.readFileSync(config.VISION_SA_KEY, 'utf8'));
  } catch (e) {
    console.log(`\n✗ El JSON no se puede leer (${e.message}).`);
    console.log('  Suele ser un pegado truncado: vuelve a crear el archivo con nano.');
    process.exit(2);
  }
  console.log(`proyecto      : ${clave.project_id}`);
  console.log(`cuenta        : ${clave.client_email}`);
  console.log(`id de clave   : ${clave.private_key_id}`);

  if (config.OCR_MOTOR !== 'vision') {
    console.log('\n⚠ OCR_MOTOR no es "vision": la generación seguirá usando Tesseract.');
    console.log('  La prueba de conexión se hace igual.');
  }

  const t0 = Date.now();
  try {
    await ocrImagenes([PNG_MINIMO]);
  } catch (e) {
    console.log(`\n✗ Vision rechazó la petición: ${e.message}`);
    process.exit(3);
  }
  console.log(`\n✓ Vision respondió en ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
  console.log('  Credencial válida, API habilitada y facturación activa.');
  console.log('  Siguiente paso: probe_ocr.js sobre un pagaré escaneado real.');
})().catch((e) => {
  console.error('sonda rota:', e);
  process.exit(1);
});
