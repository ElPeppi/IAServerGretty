/**
 * services/comun/sijin.js — A qué SIJIN debe oficiar el juzgado.
 *
 * La demanda de pago directo pide al juez que oficie a la POLICÍA NACIONAL para
 * inmovilizar el vehículo. El correo sale del directorio que mantiene la oficina
 * en el Drive (config.DIRECTORIO_SIJIN).
 *
 * POR QUÉ SE BUSCA POR DEPARTAMENTO Y NO POR CIUDAD: el directorio tiene 32
 * filas, una por CAPITAL de departamento — no hay municipios. Un garante de
 * Luruaco no aparece, pero su SIJIN sí existe: es la del Atlántico. Buscando solo
 * por ciudad, cualquier garante de un municipio pequeño se quedaría sin correo y
 * su demanda no se podría generar, teniendo el dato correcto a mano.
 *
 * Se intenta en este orden:
 *   1. ciudad exacta (cubre a los que viven en la capital)
 *   2. departamento → su capital → correo
 *
 * NO se adivina por patrón. Los códigos no siguen una regla deducible: Santa
 * Marta es `mesan.sijin@`, pero Medellín es `meval.sijin-jefat@` y Cartagena
 * `mecar.geo@`. Si la ciudad y el departamento fallan, se devuelve null y el
 * llamador decide — que para la demanda significa no generarla.
 */
'use strict';

const fs = require('fs');
const XLSX = require('xlsx');

const config = require('../../config');

/** Capital de cada departamento. Es lo que convierte un municipio en una fila
 *  del directorio. Fijo por definición administrativa: no cambia. */
const CAPITALES = {
  'AMAZONAS': 'LETICIA',
  'ANTIOQUIA': 'MEDELLIN',
  'ARAUCA': 'ARAUCA',
  'ATLANTICO': 'BARRANQUILLA',
  'BOGOTA D C': 'BOGOTA',
  'BOLIVAR': 'CARTAGENA',
  'BOYACA': 'TUNJA',
  'CALDAS': 'MANIZALES',
  'CAQUETA': 'FLORENCIA',
  'CASANARE': 'YOPAL',
  'CAUCA': 'POPAYAN',
  'CESAR': 'VALLEDUPAR',
  'CHOCO': 'QUIBDO',
  'CORDOBA': 'MONTERIA',
  'CUNDINAMARCA': 'BOGOTA',
  'GUAINIA': 'INIRIDA',
  'GUAVIARE': 'SAN JOSE DEL GUAVIARE',
  'HUILA': 'NEIVA',
  'LA GUAJIRA': 'RIOHACHA',
  'MAGDALENA': 'SANTA MARTA',
  'META': 'VILLAVICENCIO',
  'NARINO': 'PASTO',
  'NORTE DE SANTANDER': 'CUCUTA',
  'PUTUMAYO': 'MOCOA',
  'QUINDIO': 'ARMENIA',
  'RISARALDA': 'PEREIRA',
  'SAN ANDRES Y PROVIDENCIA': 'SAN ANDRES',
  'SANTANDER': 'BUCARAMANGA',
  'SUCRE': 'SINCELEJO',
  'TOLIMA': 'IBAGUE',
  'VALLE DEL CAUCA': 'CALI',
  'VAUPES': 'MITU',
  'VICHADA': 'PUERTO CARRENO',
};

// Sinónimos con los que los documentos nombran un mismo departamento.
const ALIAS_DEPTO = {
  'BOGOTA': 'BOGOTA D C',
  'BOGOTA DC': 'BOGOTA D C',
  'BOGOTA D.C.': 'BOGOTA D C',
  'DISTRITO CAPITAL': 'BOGOTA D C',
  'VALLE': 'VALLE DEL CAUCA',
  'GUAJIRA': 'LA GUAJIRA',
  'NORTE SANTANDER': 'NORTE DE SANTANDER',
  'SAN ANDRES': 'SAN ANDRES Y PROVIDENCIA',
  'ARCHIPIELAGO DE SAN ANDRES': 'SAN ANDRES Y PROVIDENCIA',
};

function norm(s) {
  return String(s || '')
    .toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

// Tabla ciudad→correo, cacheada con el mtime del Excel: si la oficina sube una
// versión nueva (el backend la repone desde Drive), se relee sola.
let _tabla = null;
let _sello = '';

function cargarTabla() {
  const ruta = config.DIRECTORIO_SIJIN;
  let sello;
  try {
    const st = fs.statSync(ruta);
    sello = `${st.mtimeMs}:${st.size}`;
  } catch (e) {
    throw new Error(`No está el directorio SIJIN (${ruta}). El backend lo repone desde Drive antes de generar.`);
  }
  if (_tabla && _sello === sello) return _tabla;

  const wb = XLSX.readFile(ruta);
  const filas = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' });

  // Las columnas se localizan por su ENCABEZADO, no por posición. La hoja tiene
  // la columna A vacía y los datos empiezan en B; con índices fijos, que alguien
  // escriba cualquier cosa en A correría todo una casilla y la tabla pasaría a
  // asociar números de fila con nombres de ciudad. No fallaría con estrépito:
  // simplemente ninguna búsqueda encontraría nada y ninguna demanda se generaría.
  const cab = filas.findIndex((f) => f.some((c) => norm(c) === 'CIUDAD'));
  if (cab < 0) throw new Error(`El directorio SIJIN (${ruta}) no tiene columna CIUDAD.`);
  const iCiudad = filas[cab].findIndex((c) => norm(c) === 'CIUDAD');
  const iCorreo = filas[cab].findIndex((c) => norm(c) === 'CORREO');
  if (iCorreo < 0) throw new Error(`El directorio SIJIN (${ruta}) no tiene columna CORREO.`);

  const tabla = new Map();
  for (const fila of filas.slice(cab + 1)) {
    const crudo  = String(fila[iCiudad] || '').trim();
    const ciudad = norm(crudo);
    const correo = String(fila[iCorreo] || '').trim();
    // La columna CIUDAD trae a veces un correo en vez del nombre (la fila de
    // Montería). Sin nombre de ciudad la fila no sirve para buscar: se salta en
    // vez de meterla con una clave que nadie va a consultar.
    // Se mira el valor CRUDO, no el normalizado: norm() borra la arroba y una
    // fila con correo en la columna de ciudad pasaría el filtro sin más.
    if (!ciudad || !correo || crudo.includes('@') || !correo.includes('@')) continue;
    if (!tabla.has(ciudad)) tabla.set(ciudad, correo);
  }
  if (!tabla.size) throw new Error(`El directorio SIJIN (${ruta}) no tiene filas usables.`);

  _tabla = tabla;
  _sello = sello;
  return tabla;
}

/**
 * @param {string} ciudad      municipio del garante
 * @param {string} departamento  su departamento (del formulario de ejecución o del Excel)
 * @returns {{correo: string, via: 'ciudad'|'departamento'} | null}
 */
function correoSijin(ciudad, departamento) {
  const tabla = cargarTabla();

  const c = norm(ciudad);
  if (c && tabla.has(c)) return { correo: tabla.get(c), via: 'ciudad' };

  let d = norm(departamento);
  if (ALIAS_DEPTO[d]) d = ALIAS_DEPTO[d];
  const capital = CAPITALES[d];
  if (capital && tabla.has(norm(capital))) {
    return { correo: tabla.get(norm(capital)), via: 'departamento' };
  }
  return null;
}

/** Ciudades del directorio (para diagnóstico). */
function ciudadesConocidas() {
  return [...cargarTabla().keys()].sort();
}

module.exports = { correoSijin, ciudadesConocidas, CAPITALES };
