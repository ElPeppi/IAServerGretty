/**
 * services/finandina/garantia/anexos.js — ANEXOS.pdf del TRÁMITE DE PAGO DIRECTO.
 *
 * Une en un solo PDF los DIEZ anexos que enumera la SOLICITUD DE APREHENSIÓN,
 * cada uno tras su carátula numerada. El orden y los textos salen literalmente
 * del acápite "ANEXOS:" de la demanda: si ahí se reordena algo, aquí hay que
 * reordenarlo igual, porque la demanda se remite a esos números.
 *
 * SON DIEZ, NO ONCE. El ANEXO 4 es UNO de dos —el certificado de tradición si el
 * banco lo mandó, y si no el del RUNT—, nunca los dos; de ahí los dos modelos de
 * demanda del Drive ("MODELO 1 CTL" y "MODELO 2 RUNT"). El resto de la lista es
 * fija: a diferencia del ejecutivo singular, aquí la numeración no baila según
 * haya vehículos o empleador, porque los documentos que faltan bloquean la
 * generación antes de llegar hasta aquí (ver garantia/documentos.js).
 *
 * LOS TEXTOS SE COPIAN TAL CUAL, erratas incluidas ("INCRIPCION", "envió",
 * "requisito para actual"). No son descuidos de este archivo: son las carátulas
 * que la oficina lleva radicando, y el encargo era que lo generado saliera igual
 * que lo radicado. Corregirlas es una decisión del despacho, no del motor.
 *
 * La carátula va SIEMPRE, aunque el documento no esté. Los cuatro certificados
 * compartidos pueden faltar sin que sea grave —se insertan a mano después—, y
 * dejar el hueco numerado es justo lo que permite hacerlo sin recontar nada.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { PDFDocument, StandardFonts } = require('pdf-lib');

const config = require('../../../config');
const {
  resolverCompartidos, archivoMasRecienteRec, caratula, anexarPdf,
  extraerParrafosDocx, paginaPoderOverlay,
} = require('../../comun/anexosPdf');

/**
 * Correo de otorgamiento del poder DE PAGO DIRECTO.
 *
 * No vale el `correoPoder` de resolverCompartidos(): ese busca en la carpeta del
 * ejecutivo singular y además excluye explícitamente los de pago directo. Usarlo
 * aquí metería en la demanda de aprehensión el correo del proceso equivocado —un
 * documento que dice otra cosa y va dirigido a otro trámite.
 */
function correoPoderPagoDirecto() {
  return archivoMasRecienteRec(
    config.ANEXOS_DIR_PODERES_PAGO_DIRECTO,
    (f) => /PODER/i.test(f),
  );
}

// Textos de carátula, transcritos de las radicadas (ver cabecera: las erratas
// van a propósito). {PLACA}, {CIUDAD} y {NOMBRE} se reemplazan con los datos del
// cliente, igual que los MERGEFIELD de la demanda.
const DESC = {
  poder: 'Poder especial para obrar conferido a la sociedad J RAMOS ABOGADOS Y ASOCIADOS S.A.S por el acreedor garantizado BANCO FINANDINA BIC conforme a la ley 2213 del 13 de junio de 2022',
  prenda: 'Copia del Contrato de prenda sin Tenencia debidamente suscrito por el garante Sr(a). {NOMBRE} y donde consta la aceptación por parte del garante, al procedimiento de PAGO DIRECTO, contemplado en la Ley 1676 de 2013',
  formularios: 'Formularios de INCRIPCION INICIAL y de EJECUCIÓN POR PAGO DIRECTO expedido por el Registro de Garantías Mobiliarias',
  tradicion: 'Certificado de Tradición del vehículo de placa {PLACA} expedido por la secretaria de transporte y transito de {CIUDAD}',
  runt: 'Certificado del vehículo de placa {PLACA}, expedido por RUNT',
  requerimiento: 'Copia del Requerimiento de entrega voluntaria del vehículo enviada la dirección electrónica del garante, señor(a) {NOMBRE}',
  servientrega: 'Constancia de envió correo electrónico requerimiento entrega voluntaria a la dirección del garante, señor(a) {NOMBRE}, expedido por Servientrega',
  ccoJRamos: 'Certificado de existencia y representación legal de la sociedad J RAMOS ABOGADOS Y ASOCIADOS S.A.S, expedido por la cámara de comercio de Barranquilla',
  sirna: 'Certificado de registro Nacional de abogados del abogado JAIRO ENRIQUE RAMOS LAZARO para demostrar el requisito para actual de la Sociedad J RAMOS ABOGADOS S.A.S. de conformidad con el inciso primero del artículo 75 del C.G.P.',
  superfin: 'Certificado de existencia y representación legal de BANCO FINANDINA BIC expedido por Superintendencia Financiera de Colombia',
  ccoFin: 'Certificado de Cámara de Comercio de BANCO FINANDINA BIC. expedido por la Cámara de Comercio de Bogotá',
};

/** El poder .docx del cliente, si el motor lo dejó en su carpeta. */
function buscarPoderDocx(dir) {
  try {
    const f = fs.readdirSync(dir).find((n) => /^PODER .*\.docx$/i.test(n) && !n.startsWith('~$'));
    return f ? path.join(dir, f) : null;
  } catch (e) {
    return null;
  }
}

/**
 * @param {string} carpeta   carpeta del cliente
 * @param {Object} halladas  { documentos } de garantia/documentos.localizar
 * @param {Object} datos     de garantia/extraccion.extraer (placa y ciudad)
 * @param {Buffer|null} correoPoderBuffer  correo de otorgamiento del banco
 * @returns {Promise<string>} ruta del ANEXOS.pdf, o '' si no se pudo armar
 */
async function generarAnexos(carpeta, halladas, datos, correoPoderBuffer = null) {
  const d = halladas.documentos || {};
  const placa = ((datos.vehiculo && datos.vehiculo.placa) || '').toUpperCase();
  const ciudad = ((datos.garante && datos.garante.municipio) || '').toUpperCase();
  const nombre = (datos.garante && datos.garante.nombre) || '';
  const comp = resolverCompartidos();

  const leer = (p) => fs.readFileSync(p);
  const texto = (s) => s
    .replace('{PLACA}', placa || '#####')
    .replace('{CIUDAD}', ciudad || '#####')
    .replace('{NOMBRE}', nombre || '#####');

  try {
    const out = await PDFDocument.create();
    const fontB = await out.embedFont(StandardFonts.HelveticaBold);
    const font = await out.embedFont(StandardFonts.Helvetica);

    let n = 0;
    const car = (desc) => caratula(out, fontB, font, ++n, texto(desc));

    // Pega el PDF si existe; si no, deja solo la carátula y lo dice en el log.
    const anexar = async (etiqueta, ruta) => {
      if (!ruta) { console.error(`[ANEXOS-GAR] ANEXO ${n} (${etiqueta}) solo carátula: no está el documento`); return; }
      try {
        await anexarPdf(out, leer(ruta));
      } catch (e) {
        console.error(`[ANEXOS-GAR] ANEXO ${n} (${etiqueta}) no se pudo pegar: ${e.message}`);
      }
    };

    // 1 — Poder. Igual que en el singular: el poder del cliente se SOBREPONE en el
    // cuerpo en blanco del correo de otorgamiento del banco. Si falta el correo,
    // no hay dónde sobreponerlo y queda la carátula.
    car(DESC.poder);
    const poderDocx = buscarPoderDocx(carpeta);
    let correo = correoPoderBuffer;
    if (!correo) {
      const respaldo = correoPoderPagoDirecto();
      if (respaldo) {
        try { correo = leer(respaldo); } catch (e) { correo = null; }
      }
    }
    try {
      if (correo && poderDocx) {
        await paginaPoderOverlay(out, correo, extraerParrafosDocx(leer(poderDocx)));
      } else if (correo) {
        await anexarPdf(out, correo);
        console.error(`[ANEXOS-GAR] ANEXO ${n} (Poder): correo sin poder .docx`);
      } else {
        console.error(`[ANEXOS-GAR] ANEXO ${n} (Poder) solo carátula: no hay correo de otorgamiento`);
      }
    } catch (e) {
      console.error(`[ANEXOS-GAR] ANEXO ${n} (Poder) falló: ${e.message}`);
    }

    // 2 — Contrato de prenda.
    car(DESC.prenda);
    await anexar('Prenda', d.prenda && d.prenda.ruta);

    // 3 — Los DOS formularios de Confecámaras bajo una sola carátula, como los
    // enumera la demanda ("Formularios de INCRIPCION INICIAL y de EJECUCIÓN").
    car(DESC.formularios);
    await anexar('Inscripción', d.inscripcion && d.inscripcion.ruta);
    await anexar('Ejecución', d.ejecucion && d.ejecucion.ruta);

    // 4 — El certificado de tradición SI llegó; si no, el del RUNT. Uno de los
    // dos, nunca los dos: es el mismo criterio con el que garantia/demandas.js
    // borra de la lista de anexos el renglón que no aplica, y los dos tienen que
    // decidir igual o la demanda se remitiría a un número que no existe.
    if (d.tradicion) {
      car(DESC.tradicion);
      await anexar('Tradición', d.tradicion.ruta);
    } else {
      car(DESC.runt);
      await anexar('RUNT', d.runt && d.runt.ruta);
    }

    // 5 y 6 — Requerimiento al garante y su constancia de envío.
    car(DESC.requerimiento);
    await anexar('Carta', d.carta && d.carta.ruta);
    car(DESC.servientrega);
    await anexar('Servientrega', d.servientrega && d.servientrega.ruta);

    // 7 a 10 — Certificados compartidos, los mismos del ejecutivo singular.
    car(DESC.ccoJRamos);
    await anexar('CCO J Ramos', comp.ccoJRamos);
    car(DESC.sirna);
    await anexar('SIRNA', comp.sirna);
    car(DESC.superfin);
    await anexar('Superfinanciera', comp.superfin);
    car(DESC.ccoFin);
    await anexar('CCO Finandina', comp.ccoFin);

    const destino = path.join(carpeta, 'ANEXOS.pdf');
    fs.writeFileSync(destino, await out.save());
    console.error(`[ANEXOS-GAR] ${path.basename(carpeta)}: ${n} anexo(s) → ANEXOS.pdf`);
    return destino;
  } catch (e) {
    console.error(`[ANEXOS-GAR] ${path.basename(carpeta)}: no se pudo armar (${e.message})`);
    return '';
  }
}

module.exports = { generarAnexos, DESC };
