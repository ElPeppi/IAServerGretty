/**
 * services/finandina/garantia/demandas.js — Arma la SOLICITUD DE APREHENSIÓN Y
 * ENTREGA (trámite de pago directo, Ley 1676/2013).
 *
 * Rellena los 20 marcadores de PLANTILLA MODELO DEMANDA PAGO DIRECTO. A
 * diferencia de la demanda del ejecutivo singular, esta plantilla NO tiene
 * secciones condicionales: no hay bloques que repetir por vehículo ni que
 * borrar. Es un llenado directo, y por eso aquí no hay nada parecido a
 * transformarSecciones().
 *
 * NO GENERA CON HUECOS. El singular deja "#####" donde falta un dato para que se
 * vea al revisar; aquí no vale: casi todos estos campos son afirmaciones de
 * hecho ante un juez —cuándo se firmó el contrato, cuánto garantiza, cuándo se
 * requirió la entrega— y un documento al que le falte uno no se puede radicar.
 * Se prefiere no producirlo y decir qué faltó.
 *
 * Las excepciones son SERIE y MOTOR: hay vehículos que no tienen uno u otro, y el
 * RUNT los deja en blanco. En las demandas hechas a mano la oficina no escribe la
 * casilla vacía: BORRA el renglón entero. Aquí se hace igual (ver quitarRenglones),
 * que además borra el ANEXO 4 que no aplica —el certificado de tradición o el del
 * RUNT— para que la lista de anexos quede en diez, como en las radicadas.
 */
'use strict';

const fs = require('fs');
const AdmZip = require('adm-zip');

const { reemplazarCampos, aplanarCamposWord, desactivarMailMerge, estamparFirma } = require('../../comun/docx');

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
               'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/**
 * "04/08/2021" → "4 de agosto de 2021".
 *
 * OJO con el "de": utils/fechas.formatDate escribe "del 2021", que es como lo
 * pone la demanda del ejecutivo singular. Esta plantilla usa "de 2021" y el día
 * SIN cero delante, como en las demandas ya radicadas.
 */
function fechaLarga(dmy) {
  const m = String(dmy || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return '';
  const dia = parseInt(m[1], 10);
  const mes = MESES[parseInt(m[2], 10) - 1];
  return mes ? `${dia} de ${mes} de ${m[3]}` : '';
}

/** Hoy, en el mismo formato. Es la FECHA_DE_CREACION_: el día en que se genera. */
function hoyLargo(ahora = new Date()) {
  return `${ahora.getDate()} de ${MESES[ahora.getMonth()]} de ${ahora.getFullYear()}`;
}

// Campos sin los cuales la demanda no se puede radicar. SERIE queda fuera a
// propósito (ver cabecera).
const OBLIGATORIOS = [
  'TIPO_DE_JUZGADO', 'CIUDAD_JUZGADO', 'DEMANDADO_1', 'CEDULA',
  'PLACA', 'MARCA', 'LINEA', 'MODELO', 'CHASIS',
  'CORREO_SUJN', 'FECHA_DE_SUSCRIPCION', 'MONTO_GARANTIZADO',
  'DIAS_DE_MORA', 'FECHA_DE_CREACION_', 'FECHA_CARTA_DE_NOTIFICACION',
  'DIRECCION_GARANTE', 'correo_GARANTE',
];

// Etiqueta legible de cada marcador, para que el aviso diga "falta la fecha de
// suscripción del contrato" y no "falta FECHA_DE_SUSCRIPCION".
const ETIQUETAS = {
  TIPO_DE_JUZGADO: 'tipo de juzgado',
  CIUDAD_JUZGADO: 'ciudad del juzgado',
  DEMANDADO_1: 'nombre del garante',
  CEDULA: 'cédula del garante',
  PLACA: 'placa', MARCA: 'marca', LINEA: 'línea', MODELO: 'año del vehículo',
  MOTOR: 'número de motor', CHASIS: 'número de chasis',
  CORREO_SUJN: 'correo de la SIJIN',
  FECHA_DE_SUSCRIPCION: 'fecha de suscripción del contrato de prenda',
  MONTO_GARANTIZADO: 'monto garantizado',
  DIAS_DE_MORA: 'días de mora',
  FECHA_DE_CREACION_: 'fecha de corte',
  FECHA_CARTA_DE_NOTIFICACION: 'fecha del requerimiento de entrega',
  DIRECCION_GARANTE: 'dirección del garante',
  correo_GARANTE: 'correo del garante',
};

/**
 * @param {Object} entrada
 * @param {Object} entrada.datos        de garantia/extraccion.extraer
 * @param {string} entrada.tipoJuzgado  resuelto por ciudad (ver domain/cuantia)
 * @param {string} entrada.correoSijin  de comun/sijin
 * @param {number|string} entrada.diasMora  del SAC
 * @param {Date}   [entrada.ahora]      para poder fijar la fecha en las pruebas
 * @returns {{fieldMap: Object, faltantes: string[]}}
 */
function construirCampos({ datos, tipoJuzgado, correoSijin, diasMora, ahora }) {
  const g = datos.garante || {};
  const v = datos.vehiculo || {};

  const fieldMap = {
    TIPO_DE_JUZGADO: String(tipoJuzgado || '').trim().toUpperCase(),
    CIUDAD_JUZGADO:  String(g.municipio || '').trim().toUpperCase(),

    DEMANDADO_1: g.nombre || '',
    CEDULA:      g.cedula || '',

    PLACA:  (v.placa || '').toUpperCase(),
    MARCA:  v.marca  || '',
    LINEA:  v.linea  || '',
    MODELO: v.modelo || '',
    SERIE:  v.serie  || '',
    MOTOR:  v.motor  || '',
    CHASIS: v.chasis || '',

    CORREO_SUJN: correoSijin || '',

    FECHA_DE_SUSCRIPCION:        fechaLarga(datos.fechaSuscripcion),
    MONTO_GARANTIZADO:           datos.montoGarantizado || '',
    DIAS_DE_MORA:                diasMora == null || diasMora === '' ? '' : String(diasMora),
    FECHA_DE_CREACION_:          hoyLargo(ahora),
    FECHA_CARTA_DE_NOTIFICACION: fechaLarga(datos.fechaCarta),

    DIRECCION_GARANTE: g.direccion || '',
    correo_GARANTE:    g.correo || '',
  };

  const faltantes = OBLIGATORIOS
    .filter((c) => !String(fieldMap[c] || '').trim())
    .map((c) => ETIQUETAS[c] || c);

  return { fieldMap, faltantes };
}

/**
 * Rellena la plantilla. Devuelve el .docx como Buffer.
 *
 * La plantilla viene de un combinar correspondencia, así que hay que APLANAR los
 * MERGEFIELD y cortar el vínculo con el origen de datos: si no, al abrirla Word
 * intenta reconectarse y, si actualiza los campos, borra lo que pusimos.
 */
function generarDemanda(plantillaPath, fieldMap, opts = {}) {
  if (!fs.existsSync(plantillaPath)) {
    throw new Error(`Plantilla de pago directo no encontrada: ${plantillaPath}`);
  }
  const zip = new AdmZip(fs.readFileSync(plantillaPath));
  let xml = zip.readAsText('word/document.xml');

  xml = reemplazarCampos(xml, fieldMap);
  xml = aplanarCamposWord(xml);
  xml = quitarRenglones(xml, opts);
  zip.updateFile('word/document.xml', Buffer.from(xml, 'utf8'));
  desactivarMailMerge(zip);
  if (opts.firmar !== false) {
    try { estamparFirma(zip); } catch (e) { console.error(`[GARANTIA] firma no estampada: ${e.message}`); }
  }
  return zip.toBuffer();
}

// Los dos renglones que se disputan el ANEXO 4 en el acápite "ANEXOS:". Van uno
// O el otro, nunca los dos: ver quitarRenglones.
const ANEXO_TRADICION = /^Certificado de Tradici[oó]n del veh[ií]culo de placa\b/i;
const ANEXO_RUNT = /^Certificado del veh[ií]culo de placa\b[\s\S]*\bRUNT\b/i;

/**
 * Borra del documento ya rellenado los renglones que no van.
 *
 * DOS CASOS, los dos "lo que hace la oficina a mano":
 *
 * 1) SERIE y MOTOR sin valor. El bloque del vehículo aparece TRES veces
 *    (peticiones, oficio a la Policía y hechos), y no todos los vehículos tienen
 *    número de serie o de motor: el RUNT los deja en blanco. Dejar "Motor:" con
 *    el hueco detrás sería peor que quitarlo —parece un dato que se olvidó de
 *    rellenar—, así que se borra el renglón entero, como en las radicadas de
 *    Emily (sin Serie) y de Isaac (sin Serie ni Motor).
 *
 * 2) EL ANEXO 4 SOBRANTE. La lista de anexos de las demandas radicadas tiene
 *    DIEZ entradas, y la cuarta es el certificado de tradición o el del RUNT
 *    según cuál mandó el banco. La plantilla trae los dos renglones; por eso en
 *    el Drive hay un "DEMANDA MODELO 1 CTL" y un "DEMANDA MODELO 2 RUNT": son
 *    esta misma demanda con uno u otro quitado. Se quita aquí en vez de mantener
 *    dos plantillas en paralelo, que se desincronizarían a la primera corrección
 *    de redacción. La lista es numerada de Word, así que el resto se renumera
 *    solo y los "numeral 2 del acápite de pruebas" del cuerpo siguen cuadrando.
 *
 * Se hace DESPUÉS de aplanar los MERGEFIELD, cuando el párrafo ya contiene el
 * texto final y no el código del campo.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.conTradicion]  el banco mandó el certificado de tradición
 */
function quitarRenglones(xml, { conTradicion = false } = {}) {
  const VACIO = /^(?:Serie|Motor)\s*:\s*$/i;
  const sobrante = conTradicion ? ANEXO_RUNT : ANEXO_TRADICION;
  return xml.replace(/<w:p\b[\s\S]*?<\/w:p>/g, (parrafo) => {
    const texto = (parrafo.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) || [])
      .map((t) => t.replace(/<[^>]+>/g, ''))
      .join('')
      .trim();
    if (VACIO.test(texto)) return '';
    return sobrante.test(texto) ? '' : parrafo;
  });
}

module.exports = { construirCampos, generarDemanda, fechaLarga, hoyLargo, OBLIGATORIOS };
