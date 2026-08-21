/**
 * services/comun/juzgadosConfig.js — Configuración manual de juzgados por ciudad
 *
 * La Rama Judicial desmontó el directorio público de correos (la página existe
 * pero llega vacía), así que la fuente PRIMARIA de especialidades y correos de
 * juzgados es este archivo, mantenido por el despacho:
 *
 *   {SAC_OUT_DIR}/juzgados_config.json
 *
 * Formato por ciudad (claves en MAYÚSCULAS sin tildes):
 *   "CERETE": {
 *     "hasSmallClaims": false,        // ¿tiene Juzgado de Pequeñas Causas?
 *     "hasPromiscuo":   false,        // ¿solo tiene Promiscuo Municipal (sin Civil)?
 *     "correoMunicipal": "j01cmpalcerete@cendoj.ramajudicial.gov.co",
 *     "correoCircuito":  ""           // para cuantía MAYOR
 *   }
 *
 * Si la ciudad no está en el archivo, se intenta el scraping de la Rama
 * Judicial (por si la página vuelve a publicarse) y el default es CIVIL MUNICIPAL.
 */

'use strict';

const path = require('path');
const fs   = require('fs');

const config = require('../../config');

let _cfg = null;
let _cfgPath = null;

function normCiudad(s) {
  return String(s || '').toUpperCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function configPath() {
  return process.env.JUZGADOS_CONFIG || path.join(config.OUT_DIR, 'juzgados_config.json');
}

// Plantilla inicial del archivo: estructura + ciudades frecuentes del despacho
// (especialidades en null = sin efecto hasta que el despacho las confirme).
const PLANTILLA_INICIAL = {
  _instrucciones: [
    'OVERRIDE manual de juzgados por ciudad (OPCIONAL).',
    'El sistema consulta automaticamente el directorio Power BI de la Rama Judicial;',
    'use este archivo solo para corregir o fijar una ciudad especifica.',
    'hasSmallClaims: true si la ciudad tiene Juzgado Civil Municipal de Pequeñas Causas.',
    'hasPromiscuo: true si la ciudad NO tiene juzgado civil y usa Promiscuo Municipal.',
    'Para que el override de especialidades aplique, AMBOS campos deben ser true/false (no null).',
    'correoMunicipal / correoCircuito: si se llenan, tienen prioridad sobre el directorio.',
    'Las claves de ciudad van en MAYUSCULAS y sin tildes.',
  ],
  _ejemplo: { hasSmallClaims: false, hasPromiscuo: true, correoMunicipal: 'reparto@cendoj.ramajudicial.gov.co', correoCircuito: '' },
};

function loadJuzgadosConfig() {
  const p = configPath();
  if (_cfg && _cfgPath === p) return _cfg;
  _cfgPath = p;
  _cfg = {};
  try {
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      for (const [k, v] of Object.entries(raw)) {
        if (k.startsWith('_')) continue;
        _cfg[normCiudad(k)] = v;
      }
      console.error(`[JUZGADOS] Config cargada: ${Object.keys(_cfg).length} ciudad(es) (${p})`);
    } else {
      // Crear plantilla inicial para que el despacho la complete
      fs.writeFileSync(p, JSON.stringify(PLANTILLA_INICIAL, null, 2), 'utf8');
      console.error(`[JUZGADOS] Config inicial creada en ${p} — completar especialidades y correos`);
      for (const [k, v] of Object.entries(PLANTILLA_INICIAL)) {
        if (!k.startsWith('_')) _cfg[normCiudad(k)] = v;
      }
    }
  } catch (e) {
    console.error(`[JUZGADOS] Error leyendo config: ${e.message}`);
  }
  return _cfg;
}

/**
 * Busca la ciudad en la configuración manual.
 * Devuelve { encontrado, hasSmallClaims, hasPromiscuo, email } donde
 * hasSmallClaims/hasPromiscuo solo se reportan si están confirmados (boolean).
 */
function buscarEnConfig(ciudad, cuantia) {
  const cfg = loadJuzgadosConfig();
  const entry = cfg[normCiudad(ciudad)];
  if (!entry) return { encontrado: false };

  const email = cuantia === 'MAYOR'
    ? (entry.correoCircuito || entry.correoMunicipal || '')
    : (entry.correoMunicipal || '');

  return {
    encontrado:     true,
    hasSmallClaims: entry.hasSmallClaims === true,
    hasPromiscuo:   entry.hasPromiscuo   === true,
    // null/undefined = sin confirmar → el caller puede complementar con scraping
    confirmado:     typeof entry.hasSmallClaims === 'boolean' && typeof entry.hasPromiscuo === 'boolean',
    email,
  };
}

module.exports = { buscarEnConfig, loadJuzgadosConfig };
