/**
 * services/finandina/garantia/poderes.js — Campos del PODER del trámite de PAGO
 * DIRECTO (garantía mobiliaria, Ley 1676/2013).
 *
 * El motor que arma el documento es común (services/comun/poderes.js); aquí solo
 * vive lo que distingue a este poder del ejecutivo singular: otros marcadores,
 * sin obligaciones y con los datos del vehículo dado en garantía.
 */

'use strict';

// Hueco visible para quien revise el documento (misma convención que la demanda).
const FALTA = '#####';

/**
 * PODER DE TRÁMITE DE PAGO DIRECTO (garantía mobiliaria): aprehensión y entrega
 * del vehículo. Sin cuantía ni obligaciones; el bien se identifica con
 * marca/modelo/placa. Ojo con los nombres: esta plantilla dice «CIUDAD_JUZGADO»
 * (sin "DE"), a diferencia de la del ejecutivo singular.
 *
 * item: { cedula, nombre, tipoJuzgado, ciudadJuzgado, placa, marca, modelo }
 */
function camposPagoDirecto(item) {
  const cedula = String(item.cedula || '').trim();
  if (!cedula) return null;
  const nombre = String(item.nombre || '').trim();
  const placa  = String(item.placa  || '').trim().toUpperCase();
  const marca  = String(item.marca  || '').trim();
  const modelo = String(item.modelo || '').trim();

  return {
    fieldMap: {
      TIPO_DE_JUZGADO: String(item.tipoJuzgado   || '').trim(),
      CIUDAD_JUZGADO:  String(item.ciudadJuzgado || '').trim(),
      // Decisión del despacho: en "CONTRA:" va SOLO el nombre del garante.
      DEMANDADO_1:     nombre,
      // El dato del banco viene como "CHEVROLET ONIX" (marca + línea) y se usa
      // completo: identifica mejor el bien a aprehender.
      MARCA:           marca  || FALTA,
      MODELO:          modelo || FALTA,
      PLACA:           placa  || FALTA,
    },
    cliente: { cedula, nombre, placa, marca, modelo },
  };
}

module.exports = { camposPagoDirecto };
