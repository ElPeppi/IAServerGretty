/**
 * services/comun/pdfFormulario.js — Lee formularios PDF con estructura de tabla.
 *
 * Pensado para los del Registro de Garantías Mobiliarias (Confecámaras): los de
 * INSCRIPCIÓN INICIAL y EJECUCIÓN, de donde salen la dirección y el correo del
 * garante, el monto garantizado y la fecha de inscripción.
 *
 * CÓMO: en esos formularios la etiqueta y su valor comparten la MISMA x y están
 * en filas contiguas —"Municipio" arriba, "CUCUTA" justo debajo, ambos en x=354.7—.
 * Emparejar por posición es mucho más firme que buscar en el texto plano, donde
 * tres columnas quedan en una línea ("Colombia NORTE DE SANTANDER CUCUTA") sin
 * forma de saber dónde acaba cada una.
 *
 * POR SECCIONES: el formulario repite las mismas etiquetas para el DEUDOR (A.1)
 * y para el ACREEDOR (B.1). País, Departamento, Municipio y Dirección Electrónica
 * salen dos veces. Por eso no se devuelve un mapa etiqueta→valor —el acreedor
 * pisaría al garante y la demanda saldría con la dirección del banco— sino la
 * lista en orden, y se consulta acotando a una sección.
 */
'use strict';

const { fragmentosDePdf } = require('./pdfTexto');

// Tolerancia horizontal para considerar que etiqueta y valor son de la misma
// columna. Los formularios alinean al píxel; 2 puntos absorben el redondeo.
const TOLERANCIA_X = 2;
// Cuántos altos de letra puede haber entre la etiqueta y su valor. Más que esto
// y ya no es "la fila de abajo" sino otro bloque del formulario.
const DISTANCIA_MAX = 3;

function norm(s) {
  return String(s || '')
    .toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Agrupa los fragmentos de una página en filas, de arriba abajo. */
function filas(frags) {
  const orden = [...frags].sort((a, b) => (Math.abs(a.y - b.y) > 1 ? b.y - a.y : a.x - b.x));
  const out = [];
  for (const f of orden) {
    const ultima = out[out.length - 1];
    if (ultima && Math.abs(ultima[0].y - f.y) <= Math.max(1, f.alto * 0.5)) ultima.push(f);
    else out.push([f]);
  }
  return out;
}

/**
 * @returns {Promise<{campos: Array<{etiqueta:string,valor:string,pagina:number,orden:number}>}>}
 *   `campos` va en orden de lectura, que es lo que permite acotar por sección.
 */
async function leerFormulario(buffer, opts = {}) {
  const { paginas } = await fragmentosDePdf(buffer, opts);
  const campos = [];
  let orden = 0;

  paginas.forEach((frags, i) => {
    const fs = filas(frags);
    for (let r = 0; r < fs.length; r++) {
      for (let c = 0; c < fs[r].length; c++) {
        const etiqueta = fs[r][c];
        // Límites de la COLUMNA de esta etiqueta: desde su x hasta donde empieza
        // la etiqueta de al lado. Sin este tope el valor se cortaría al primer
        // fragmento: la dirección "[CL 7   13 A 83   ]" viene partida en tres, y
        // un nombre con espacio delante (" ALBERTO") ni siquiera caería en la x
        // exacta de su etiqueta.
        const desde = etiqueta.x - TOLERANCIA_X;
        const hasta = c + 1 < fs[r].length ? fs[r][c + 1].x - TOLERANCIA_X : Infinity;

        // Se guardan VARIAS filas candidatas, no solo la primera: algunas
        // etiquetas ocupan dos renglones ("Monto máximo de la obligación
        // Garantizada (Peso" / "colombiano)" / "$ 68.000.000,00") y entonces el
        // valor real está una fila más abajo. Quien consulta decide cuál sirve.
        const candidatos = [];
        for (let k = r + 1; k < fs.length && candidatos.length < 3; k++) {
          const dy = etiqueta.y - fs[k][0].y;
          if (dy > etiqueta.alto * DISTANCIA_MAX) break;
          const trozos = fs[k].filter((f) => f.x >= desde && f.x < hasta);
          if (trozos.length) candidatos.push(trozos.map((t) => t.str).join(' ').replace(/\s+/g, ' ').trim());
        }
        // Muchos formularios no ponen el valor DEBAJO sino A LA DERECHA, en la
        // misma fila: el certificado del RUNT es todo así ("MARCA:" y "FORD"), y
        // en el de inscripción el monto también.
        //
        // Se descarta el vecino que acabe en ":": es otra etiqueta, no un valor.
        // Pasa cuando el campo viene VACÍO — en el RUNT de Emily, a la derecha de
        // "NÚMERO DE SERIE:" está "NÚMERO DE MOTOR:" porque ese vehículo no tiene
        // serie. Sin esta guarda, la demanda llevaría un nombre de etiqueta en el
        // hueco de la serie.
        const vecino = c + 1 < fs[r].length ? fs[r][c + 1].str.trim() : '';
        const derecha = vecino && !/:$/.test(vecino) ? vecino : '';
        if (derecha) candidatos.push(derecha);

        campos.push({
          etiqueta: etiqueta.str.trim(),
          valor: candidatos[0] || '',
          valores: candidatos,
          derecha,
          pagina: i + 1,
          orden: orden++,
        });
      }
    }
  });

  return { campos };
}

/**
 * Valor de una etiqueta DENTRO de una sección.
 *
 * @param {Array} campos     de leerFormulario
 * @param {RegExp} reSeccion encabezado que abre la sección (p. ej. /A\.1.*DEUDOR/i)
 * @param {RegExp} reEtiqueta etiqueta buscada
 * @param {RegExp} [reFin]   encabezado que la cierra; por defecto, la siguiente
 *                           sección con la misma forma (letra + punto + número)
 */
function valorEnSeccion(campos, reSeccion, reEtiqueta, reFin = /^[A-Z]\.\d/) {
  const ini = campos.findIndex((c) => reSeccion.test(c.etiqueta));
  if (ini < 0) return '';
  let fin = campos.length;
  for (let i = ini + 1; i < campos.length; i++) {
    if (reFin.test(campos[i].etiqueta) && !reSeccion.test(campos[i].etiqueta)) { fin = i; break; }
  }
  const hit = campos.slice(ini + 1, fin).find((c) => reEtiqueta.test(norm(c.etiqueta)));
  return hit ? hit.valor : '';
}

/**
 * Como valor(), pero devuelve el primer candidato que CUMPLA `rePatron`.
 * Sirve para las etiquetas que se parten en dos renglones: se pide "el de abajo
 * que parezca un importe" en vez de "el de abajo", sin codificar cuántas filas
 * hay que saltar en cada formulario.
 */
function valorComo(campos, reEtiqueta, rePatron) {
  const hit = campos.find((c) => reEtiqueta.test(norm(c.etiqueta)));
  if (!hit) return '';
  return (hit.valores || [hit.valor]).find((v) => rePatron.test(v)) || '';
}

/**
 * Valor que está A LA DERECHA de la etiqueta, en su misma fila. Es la
 * disposición del certificado del RUNT. Cadena vacía si ahí no hay un valor
 * (campo sin rellenar).
 */
function valorDerecha(campos, reEtiqueta) {
  const hit = campos.find((c) => reEtiqueta.test(norm(c.etiqueta)));
  return hit ? (hit.derecha || '') : '';
}

/** Valor de la primera etiqueta que coincida, sin acotar por sección. */
function valor(campos, reEtiqueta) {
  const hit = campos.find((c) => reEtiqueta.test(norm(c.etiqueta)));
  return hit ? hit.valor : '';
}

module.exports = { leerFormulario, valorEnSeccion, valor, valorComo, valorDerecha };
