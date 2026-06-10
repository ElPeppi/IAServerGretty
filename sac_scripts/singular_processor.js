/**
 * singular_processor.js — Shim de compatibilidad
 *
 * El procesador de Plantilla Singular se movió a src/services/singular/
 * (ver ARQUITECTURA.md). Este archivo existe solo para no romper
 * referencias antiguas; importar directamente desde src/ en código nuevo.
 */

'use strict';

module.exports = require('./src/services/singular');
