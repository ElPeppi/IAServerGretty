/**
 * domain/vehiculos.js — Parseo de descripciones de vehículos
 *
 * Entrada: texto tipo "AUTOMOVIL MAZDA 3 MODELO 2020 PLACA ABC123 ... & CAMIONETA ..."
 * (varios vehículos separados por "&"). Salida: objetos con campos estructurados.
 */

'use strict';

const VH_KW = ['MODELO', 'PLACA', 'SERVICIO', 'COLOR', 'SERIE', 'MOTOR', 'CHASIS',
               'CARROCERIA', 'TIPO'];

function getVhField(text, keyword, skipKws) {
  const allKw = VH_KW.filter(k => k !== keyword && !skipKws?.includes(k));
  const alt   = allKw.map(k => k.replace(/\s+/g, '\\s+')).join('|');
  const re    = new RegExp(
    `\\b${keyword.replace(/\s+/g, '\\s+')}\\s+(.+?)(?=\\s+(?:${alt})\\b|$)`, 'i'
  );
  const m = text.match(re);
  return m ? m[1].trim() : '';
}

function parsearVehiculo(raw) {
  const texto = (raw || '').trim().replace(/\s{2,}/g, ' ');
  if (!texto) return null;

  const tokens = texto.split(/\s+/);
  const clase  = tokens[0] || '';
  const marca  = tokens[1] || '';

  // LINEA: desde token 3 hasta "MODELO"
  const lineaM = texto.match(/^(?:\S+\s+){2}(.*?)\s+MODELO\b/i);
  const linea  = lineaM ? lineaM[1].trim() : tokens.slice(2).join(' ');

  const modelo  = getVhField(texto, 'MODELO',    []);
  // Placa: capturar el texto completo después de "PLACA" (código + "MATRICULADA EN...").
  // Ejemplo: "LAM20F MATRICULADA EN EL ORGAN TRANSI DE INST TTOYTTE DE CERETE"
  // Se detiene en el siguiente keyword de vehículo si lo hubiera, o al final del texto.
  const placaStartM = texto.match(/\bPLACA\s+([\s\S]+?)(?=\s+(?:SERVICIO|COLOR|SERIE|MOTOR|CHASIS|TIPO)\b|$)/i);
  const placa       = placaStartM ? placaStartM[1].trim() : '';
  const servicio = getVhField(texto, 'SERVICIO', []);
  const color   = getVhField(texto, 'COLOR',     []);
  const serie   = getVhField(texto, 'SERIE',     []);
  const motor   = getVhField(texto, 'MOTOR',     []);
  const chasis  = getVhField(texto, 'CHASIS',    []);

  // Tipo de carrocería (puede venir como "TIPO CARROCERIA" o "TIPO DE CARROCERIA")
  const tipoCarroceriaM = texto.match(
    /\bTIPO\s+(?:DE\s+)?CARROCERIA\s+(.+?)(?=\s+(?:CHASIS|MOTOR|SERIE|COLOR|SERVICIO|PLACA|MODELO)\b|$)/i
  );
  const tipoCarroceria = tipoCarroceriaM ? tipoCarroceriaM[1].trim() : '';

  return { clase, marca, linea, modelo, placa, servicio, color, serie, motor, chasis, tipoCarroceria };
}

function parsearVehiculos(descripcion) {
  if (!descripcion) return [];
  return descripcion
    .split(/\s*&\s*/)
    .map(v => parsearVehiculo(v))
    .filter(Boolean);
}

module.exports = { parsearVehiculo, parsearVehiculos };
