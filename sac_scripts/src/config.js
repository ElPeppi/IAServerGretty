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
  OLLAMA_URL,
  OLLAMA_MODEL,
  OLLAMA_TIMEOUT,
  SAC_URL,
  SAC_USER,
  SAC_PASS,
  SAC_ZIP_PASS,
  SCRIPT_PUPPETEER,
};
