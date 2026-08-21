/**
 * services/finandina/garantia/extraccion.js — De los documentos del banco a los
 * datos que pide la demanda de pago directo.
 *
 * Cada campo tiene UNA fuente decidida, no la primera que lo tenga:
 *
 *   garante (nombre, cédula, dirección, correo, municipio, depto)
 *        → formulario de EJECUCIÓN, sección A.1. Es lo que la propia demanda
 *          declara como origen de las notificaciones al garante.
 *   vehículo (marca, línea, modelo, serie, motor, chasis)
 *        → RUNT. Es el registro oficial. Los formularios de Confecámaras traen
 *          los mismos datos en su campo "Descripción" y se usan de RESPALDO,
 *          porque el PDF del RUNT parte a veces un valor entre dos páginas.
 *   fecha de inscripción
 *        → formulario de INSCRIPCIÓN INICIAL.
 *   monto garantizado
 *        → contrato de PRENDA, cláusula SEGUNDA, que es lo que la demanda cita.
 *          El formulario de inscripción trae un "monto máximo garantizado" que
 *          coincide a menudo pero NO siempre: el de Vera dice 44.890.000 y su
 *          contrato —y su demanda ya radicada— 47.090.000.
 *   fecha de la carta al garante
 *        → acta de SERVIENTREGA, fecha de ENVÍO. NO la de la carta: la de Jorge
 *          está fechada "Febrero de 2025" y su demanda dice 3 de marzo, que es
 *          cuando se envió. Tampoco la cabecera del acta, que es de cuando se
 *          expidió (un día después en los dos casos comprobados).
 *   fecha de suscripción
 *        → contrato de PRENDA, por OCR. Es el único escaneado, pero está
 *          mecanografiado y el parser de fechas del pagaré lo lee sin cambios.
 *
 * Nada se inventa: lo que no se pueda leer sale vacío y el llamador decide.
 */
'use strict';

const fs = require('fs');

const { leerFormulario, valor, valorEnSeccion, valorComo, valorDerecha } = require('../../comun/pdfFormulario');
const { ocrPdf, extraerCamposPagare } = require('../../ocr');

const SECCION_DEUDOR = /A\.1.*DEUDOR/i;

// Campos del vehículo para los que solo vale el RUNT (ver más abajo el porqué).
const SIN_RESPALDO = new Set(['serie', 'motor']);

const limpio = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** "[CL 7   13 A 83   ]" → "CL 7 13 A 83". Los corchetes son del formulario. */
function direccionLimpia(s) {
  return limpio(s).replace(/^\[|\]$/g, '').trim();
}

/**
 * "SANTA MARTA" → "Santa Marta". La demanda escribe la ciudad pegada a la
 * dirección con mayúscula en CADA palabra, no solo en la primera: las radicadas
 * dicen "Santa Marta", no "Santa marta".
 */
function enCapital(s) {
  // Sin expresión regular a propósito: partir por espacios es más claro y no
  // deja sitio a que una barra perdida pase inadvertida.
  return limpio(s).toLowerCase().split(' ')
    .map((p) => (p ? p.charAt(0).toUpperCase() + p.slice(1) : p))
    .join(' ');
}

/** "18/04/2022 15:34:38" → "18/04/2022" */
const soloFecha = (s) => (String(s || '').match(/(\d{2}\/\d{2}\/\d{4})/) || [, ''])[1];

/**
 * Fecha de ENVÍO del acta de Servientrega.
 *
 * El acta trae varias fechas: la de expedición en la cabecera y las del ciclo de
 * envío. La buena es la que acompaña a "envió el mensaje de datos". Se toma la
 * MÁS TEMPRANA de las que aparecen como "Fecha: aaaa/mm/dd", que es el momento
 * del envío; las posteriores son acuses.
 */
function fechaEnvioServientrega(texto) {
  const fechas = [...String(texto || '').matchAll(/Fecha:\s*(\d{4})\/(\d{2})\/(\d{2})/g)]
    .map((m) => `${m[1]}-${m[2]}-${m[3]}`)
    .sort();
  if (!fechas.length) return '';
  const [a, mes, d] = fechas[0].split('-');
  return `${d}/${mes}/${a}`;
}

/**
 * Datos del vehículo del certificado del RUNT.
 *
 * El RUNT sale en DOS disposiciones según cómo se imprimiera la consulta: ancha,
 * con el valor a la derecha de su rótulo ("MARCA:" | "FORD"), o estrecha, con el
 * valor debajo. Se prueban las dos.
 *
 * Y se exige la FORMA del dato en vez de fiarse de la posición: en el impreso
 * estrecho, debajo de "LÍNEA:" puede caer el encabezado de la página siguiente
 * ("11/3/25, 11:28Consulta Ciudadano - RUNT"). Un patrón por campo lo descarta;
 * la alternativa sería meter la cabecera del navegador en una demanda.
 */
const FORMA = {
  placa:  /^[A-Z]{3}\d{2,3}[A-Z]?$/,
  marca:  /^[A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ .-]{1,}$/i,
  linea:  /^[A-ZÁÉÍÓÚÑ0-9][A-ZÁÉÍÓÚÑ0-9 .-]{1,}$/i,
  modelo: /^(19|20)\d{2}$/,
  serie:  /^[A-Z0-9-]{5,}$/i,
  motor:  /^[A-Z0-9-]{5,}$/i,
  chasis: /^[A-Z0-9-]{5,}$/i,
};

const ROTULO = {
  placa:  /^PLACA DEL VEH/,
  marca:  /^MARCA:?$/,
  linea:  /^L[IÍ]NEA:?$/,
  modelo: /^MODELO:?$/,
  serie:  /^N[UÚ]MERO DE SERIE/,
  motor:  /^N[UÚ]MERO DE MOTOR/,
  chasis: /^N[UÚ]MERO DE CHASIS/,
};

function vehiculoDeRunt(campos, texto) {
  const lineas = String(texto || '').split('\n').map((l) => l.trim());
  const out = {};
  for (const [campo, rotulo] of Object.entries(ROTULO)) {
    const forma = FORMA[campo];
    const derecha = limpio(valorDerecha(campos, rotulo));
    out[campo] = forma.test(derecha)
      ? derecha
      : limpio(valorComo(campos, rotulo, forma)) || porLineas(lineas, rotulo, forma);
  }
  return out;
}

/**
 * Último recurso: recorrer el texto por líneas desde el rótulo hasta dar con una
 * que tenga la forma del dato.
 *
 * Hace falta para el impreso de una sola columna, donde el valor queda muy
 * separado de su rótulo y a veces en la PÁGINA SIGUIENTE — "LÍNEA:" cierra una
 * página y "HILUX" abre la otra, con el encabezado del navegador en medio.
 * Ninguna lectura por posición puede cruzar ese salto; una por forma, sí.
 */
function porLineas(lineas, rotulo, forma) {
  for (let i = 0; i < lineas.length; i++) {
    if (!rotulo.test(lineas[i].toUpperCase())) continue;
    for (let k = i + 1; k < Math.min(i + 5, lineas.length); k++) {
      if (forma.test(lineas[k])) return lineas[k];
    }
  }
  return '';
}

/**
 * Respaldo: el campo "Descripción" de los formularios de Confecámaras trae todo
 * el vehículo en una cadena —"Vehiculo:FORD Placa:JJM898 … Linea:ECOSPORT"—.
 * Solo rellena lo que el RUNT no dio: el registro oficial manda.
 */
// Etiquetas que usa esa cadena, en el orden en que aparecen. Se necesitan TODAS,
// también las que no interesan (Vin, T.Servicio): son las que marcan dónde acaba
// el valor anterior.
const ETIQUETAS_DESCR = ['Vehiculo', 'Placa', 'Modelo', 'Chasis', 'Vin', 'Motor', 'Serie', 'T.Servicio', 'Linea'];

function vehiculoDeDescripcion(texto) {
  // Se PARTE por las etiquetas en vez de buscar cada una por separado. Con una
  // búsqueda suelta, un campo vacío se come la etiqueta siguiente: en el vehículo
  // de Isaac, que no tiene número de motor, "Motor:" capturaba la palabra "Serie".
  const t = String(texto || '');
  const trozos = t.split(new RegExp('(' + ETIQUETAS_DESCR.map((e) => e.replace('.', '\\.')).join('|') + ')\\s*:', 'i'));
  const mapa = {};
  for (let i = 1; i < trozos.length; i += 2) {
    const clave = trozos[i].toLowerCase();
    if (mapa[clave] === undefined) mapa[clave] = String(trozos[i + 1] || '').trim();
  }
  const dato = (k) => (mapa[k] || '').split(/\s/)[0] || '';
  return {
    placa:  dato('placa'),
    marca:  dato('vehiculo'),
    linea:  dato('linea'),
    modelo: dato('modelo'),
    serie:  dato('serie'),
    motor:  dato('motor'),
    chasis: dato('chasis'),
  };
}

/**
 * Días de mora de la consulta del SAC.
 *
 * El SAC los publica dos veces: dentro de la fila corrida de la tabla de cuentas
 * (pegados a otras cifras, imposibles de aislar con seguridad) y como campo con
 * su rótulo en el detalle. Se toma el rotulado, que es el único inequívoco.
 */
function diasMoraDeSac(texto) {
  const m = String(texto || '').match(/D[ií]as\s*Mora\s*:?\s*(\d{1,5})/i);
  return m ? m[1] : '';
}

/**
 * Monto garantizado, del CONTRATO DE PRENDA.
 *
 * Es lo que dice la propia demanda: "el PARÁGRAFO de la cláusula SEGUNDA" del
 * contrato. NO vale el "Monto máximo de la obligación Garantizada" del formulario
 * de inscripción: coincide en muchos casos, pero no siempre —el de Vera dice
 * 44.890.000 y su contrato (y su demanda radicada) 47.090.000—.
 *
 * La cláusula reza "...asciende a la suma de <en letras> (47,090,000)". Se ancla
 * en esa frase y se busca el primer número con separadores de millar en lo que
 * sigue, sin exigir cómo venga envuelto: en el contrato de Angie el OCR devuelve
 * los paréntesis y el signo de peso hechos un desastre, pero los dígitos intactos.
 */
function montoDePrenda(texto) {
  const t = String(texto || '');
  const ancla = t.search(/asciende a la suma de/i);
  if (ancla < 0) return '';
  const m = t.slice(ancla, ancla + 200).match(/(\d{1,3}(?:[\.,]\d{3})+)/);
  if (!m) return '';
  // Los contratos alternan "47,090,000" y "94.990.000"; la demanda escribe puntos.
  const digitos = m[1].replace(/[\.,]/g, '');
  return digitos.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/**
 * @param {{documentos: Object, textos: Object}} halladas  de documentos.localizar
 * @returns {Promise<Object>} datos crudos; los huecos van como cadena vacía
 */
async function extraer(halladas) {
  const { documentos, textos } = halladas;

  const eje = (await leerFormulario(fs.readFileSync(documentos.ejecucion.ruta))).campos;
  const ini = (await leerFormulario(fs.readFileSync(documentos.inscripcion.ruta))).campos;
  const runt = (await leerFormulario(fs.readFileSync(documentos.runt.ruta))).campos;

  const v = (re) => valorEnSeccion(eje, SECCION_DEUDOR, re);
  const nombre = [v(/^PRIMER NOMBRE/), v(/^SEGUNDO NOMBRE/), v(/^PRIMER APELLIDO/), v(/^SEGUNDO APELLIDO/)]
    .map(limpio).filter(Boolean).join(' ');

  const municipio = limpio(v(/^MUNICIPIO/));
  const direccion = direccionLimpia(v(/^DIRECCION$/));

  const delRunt = vehiculoDeRunt(runt, textos.runt);
  const respaldo = vehiculoDeDescripcion(`${textos.inscripcion || ''}\n${textos.ejecucion || ''}`);
  const vehiculo = {};
  for (const k of Object.keys(delRunt)) {
    // SERIE y MOTOR NO admiten respaldo. Hay vehículos que sencillamente no los
    // tienen, y el RUNT —el registro oficial— los deja en blanco a propósito. El
    // formulario de Confecámaras, en cambio, rellena "Serie:0", y usar eso metería
    // en la demanda un número de serie que el registro no reconoce. Las radicadas
    // de Emily y de Isaac no traen ese renglón siquiera.
    //
    // Para los otros cinco el respaldo sí vale: el PDF del RUNT parte a veces un
    // valor entre dos páginas (la LÍNEA de Jorge).
    vehiculo[k] = SIN_RESPALDO.has(k) ? delRunt[k] : (delRunt[k] || respaldo[k] || '');
  }

  // Un solo OCR del contrato de prenda (es el único escaneado): de ahí salen la
  // fecha de firma Y el monto garantizado.
  let fechaSuscripcion = '';
  let montoGarantizado = '';
  try {
    const r = await ocrPdf(fs.readFileSync(documentos.prenda.ruta), { scale: 3, maxPages: 6 });
    fechaSuscripcion = extraerCamposPagare(r.text).fechaCorta || '';
    montoGarantizado = montoDePrenda(r.text);
  } catch (e) {
    console.error(`[GARANTIA] OCR del contrato de prenda falló: ${e.message}`);
  }

  return {
    garante: {
      nombre,
      cedula: limpio(v(/^NUMERO DE IDENTIFICACION/)),
      municipio,
      departamento: limpio(v(/^DEPARTAMENTO/)),
      // Como la escribe la demanda: dirección + ciudad.
      direccion: direccion && municipio ? `${direccion}, ${enCapital(municipio)}` : direccion,
      correo: limpio(v(/^DIRECCION ELECTRONICA/)),
    },
    vehiculo,
    montoGarantizado,
    fechaInscripcion: soloFecha(valor(ini, /^FECHA Y HORA INSCRIPCION/)),
    diasMora: diasMoraDeSac(textos.sac),
    fechaCarta: fechaEnvioServientrega(textos.servientrega),
    fechaSuscripcion,
  };
}

module.exports = { extraer, fechaEnvioServientrega, montoDePrenda, vehiculoDeRunt, diasMoraDeSac };
