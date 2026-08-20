/**
 * config.js — Configuración central del SAC Processor
 *
 * Única fuente de verdad para variables de entorno y rutas.
 * Todos los módulos leen configuración desde aquí (nunca process.env directo).
 *
 * Variables de entorno (ver .env):
 *   SAC_PORT, SAC_TEMP_DIR, SAC_OUT_DIR, SAC_URL, SAC_USER, SAC_PASS,
 *   SAC_ZIP_PASS, PLANTILLA_SINGULAR, PLANTILLA_DEMANDA
 */

'use strict';

const path = require('path');
const fs   = require('fs');

// Raíz del proyecto (sac_scripts/), donde viven .env y sac_puppeteer.js
const RAIZ = path.join(__dirname, '..');

// Cargar .env: primero el del directorio de trabajo, luego el de la raíz
// del proyecto, luego el archivo "env" (sin punto) como último recurso.
require('dotenv').config();
if (!process.env.SAC_PORT) require('dotenv').config({ path: path.join(RAIZ, '.env') });
if (!process.env.SAC_PORT) require('dotenv').config({ path: path.join(RAIZ, 'env') });

// ─── Servidor ─────────────────────────────────────────────────────────────────

const PORT     = process.env.SAC_PORT     || 3456;
const TEMP_DIR = process.env.SAC_TEMP_DIR || 'C:/temp/sac_temp';

// ─── Rutas de salida y plantillas ────────────────────────────────────────────

const OUT_DIR = process.env.SAC_OUT_DIR
  || '\\\\10.0.10.10\\compartida\\DOCUMENTOS ACTUALIZADOS 2019\\DEMANDAS\\FINANDINA\\EJECUTIVAS SINGULARES\\GARANTIAS';

const PLANTILLA_SINGULAR = process.env.PLANTILLA_SINGULAR
  || path.join(OUT_DIR, 'PLANTILLA SINGULAR GRETTY.xlsx');

const PLANTILLA_DEMANDA = process.env.PLANTILLA_DEMANDA
  || '\\\\10.0.10.10\\compartida\\DOCUMENTOS ACTUALIZADOS 2019\\DEMANDAS\\FINANDINA\\EJECUTIVAS SINGULARES\\PLANTILLAS\\PLANTILLA DEMANDA SINGULAR AI.docx';

const PLANTILLA_PODER = process.env.PLANTILLA_PODER
  || '\\\\10.0.10.10\\compartida\\DOCUMENTOS ACTUALIZADOS 2019\\DEMANDAS\\FINANDINA\\EJECUTIVAS SINGULARES\\PLANTILLAS\\PLANTILLA PODER SINGULAR AI.docx';

// Poder del TRÁMITE DE PAGO DIRECTO (garantía mobiliaria, Ley 1676/2013): pide la
// APREHENSIÓN Y ENTREGA del vehículo dado en garantía. Otros marcadores que el
// ejecutivo singular (sin cuantía ni obligaciones; con placa/marca/modelo).
// Por defecto, junto a las demás plantillas.
const PLANTILLA_PODER_PAGO_DIRECTO = process.env.PLANTILLA_PODER_PAGO_DIRECTO
  || path.join(path.dirname(PLANTILLA_PODER), 'PLANTILLA PODER BANCO FINANDINA PAGO DIRECTO.docx');

// Imagen de la firma del abogado (PNG) — se estampa en la demanda. Por defecto
// en la misma carpeta PLANTILLAS que las plantillas, archivo "Firma.png".
const FIRMA_PATH = process.env.SAC_FIRMA_PATH
  || path.join(path.dirname(PLANTILLA_DEMANDA), 'Firma.png');

// Carpetas con los certificados compartidos de los ANEXOS (se toma el más reciente):
//   DEMANDAS  → ANEXO 4 (CCO J Ramos) y ANEXO 5 (SIRNA)
//   FINANDINA → ANEXO 6 (Super Financiera) y ANEXO 7 (CCO Finandina comprimida)
const ANEXOS_DIR_DEMANDAS = process.env.ANEXOS_DEMANDAS
  || '\\\\10.0.10.10\\compartida\\DOCUMENTOS ACTUALIZADOS 2019\\DEMANDAS';
const ANEXOS_DIR_FINANDINA = process.env.ANEXOS_FINANDINA
  || '\\\\10.0.10.10\\compartida\\DOCUMENTOS ACTUALIZADOS 2019\\DEMANDAS\\FINANDINA';

// Carpeta de los correos de otorgamiento de poderes (ANEXO 1). Si la web no
// envía el correo, se toma el más reciente de aquí como respaldo.
const ANEXOS_DIR_PODERES = process.env.ANEXOS_PODERES
  || '\\\\10.0.10.10\\compartida\\DOCUMENTOS ACTUALIZADOS 2019\\DEMANDAS\\FINANDINA\\EJECUTIVAS SINGULARES\\PODERES';

// Poderes del TRÁMITE DE PAGO DIRECTO. En la oficina cuelgan de otro árbol
// (…\FINANDINA\GARANTIA MOBILIARIAS\PODERES), no del de ejecutivas singulares.
// Se mantiene aparte también en disco para no mezclarlos con el origen del
// ANEXO 1 (correo de otorgamiento) del ejecutivo singular.
const ANEXOS_DIR_PODERES_PAGO_DIRECTO = process.env.ANEXOS_PODERES_PAGO_DIRECTO
  || path.join(ANEXOS_DIR_PODERES, 'PAGO DIRECTO');

// ─── Ollama (LLM local para mapeo de columnas del Excel) ─────────────────────

const OLLAMA_URL     = process.env.OLLAMA_URL     || 'http://localhost:11434';
const OLLAMA_MODEL   = process.env.OLLAMA_MODEL   || 'qwen2.5:3b';
const OLLAMA_TIMEOUT = parseInt(process.env.OLLAMA_TIMEOUT || '300000', 10);

// ─── Conexión SAC Finandina ──────────────────────────────────────────────────

const SAC_URL  = process.env.SAC_URL  || 'https://servicios.bancofinandina.com/Sac';
const SAC_USER = process.env.SAC_USER || 'jairramo';
const SAC_PASS = process.env.SAC_PASS || '';

// Contraseña por defecto de los ZIPs que llegan por correo
const SAC_ZIP_PASS = process.env.SAC_ZIP_PASS || null;

// ─── Notificaciones al backend (SSE) ─────────────────────────────────────────
// El motor avisa al backend el fin de sus pasos (extracción de ZIPs) y éste lo
// retransmite a los usuarios logueados. Desactivado si falta alguna de las dos.
const NOTIFY_URL    = process.env.SAC_NOTIFY_URL    || null; // p.ej. http://localhost:3001/api/notifications/engine
const NOTIFY_SECRET = process.env.SAC_NOTIFY_SECRET || null; // = ENGINE_NOTIFY_SECRET del backend

// ─── OCR del pagaré escaneado ───────────────────────────────────────

// Motor de OCR: 'tesseract' (local, gratis, NO lee caligrafía) o 'vision'
// (Google Cloud, de pago por página, sí lee manuscrito). Vision cae a Tesseract
// si falla, para que un problema de red o de facturación no pare la generación.
const OCR_MOTOR = (process.env.OCR_MOTOR || 'tesseract').toLowerCase();

// Clave JSON de la cuenta de servicio de Vision. Es OTRA cuenta, distinta de la
// de Drive del backend: sin delegación de dominio y sin acceso a los documentos.
const VISION_SA_KEY = process.env.VISION_SA_KEY || '';

// ─── Worker Puppeteer (proceso hijo) ─────────────────────────────────────────

const SCRIPT_PUPPETEER = path.join(RAIZ, 'sac_puppeteer.js');

// Asegurar carpeta temporal al cargar la configuración
fs.mkdirSync(TEMP_DIR, { recursive: true });

module.exports = {
  PORT,
  TEMP_DIR,
  OUT_DIR,
  PLANTILLA_SINGULAR,
  PLANTILLA_DEMANDA,
  PLANTILLA_PODER,
  PLANTILLA_PODER_PAGO_DIRECTO,
  FIRMA_PATH,
  ANEXOS_DIR_DEMANDAS,
  ANEXOS_DIR_FINANDINA,
  ANEXOS_DIR_PODERES,
  ANEXOS_DIR_PODERES_PAGO_DIRECTO,
  OLLAMA_URL,
  OLLAMA_MODEL,
  OLLAMA_TIMEOUT,
  SAC_URL,
  SAC_USER,
  SAC_PASS,
  SAC_ZIP_PASS,
  NOTIFY_URL,
  NOTIFY_SECRET,
  OCR_MOTOR,
  VISION_SA_KEY,
  SCRIPT_PUPPETEER,
};
