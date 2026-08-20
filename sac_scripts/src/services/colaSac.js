/**
 * services/colaSac.js — Cola de ejecución Puppeteer contra el SAC
 *
 * El servidor puede recibir varios lotes de ZIPs simultáneamente. Históricamente
 * la cola dejaba correr Chromium DE A UNO por dos motivos distintos:
 *   1. evitar conflictos de sesión en el portal del banco,
 *   2. no saturar la RAM (cada ejecución levanta su propio Chromium).
 *
 * El (1) es una suposición que nunca se comprobó, y es cara: medido en producción,
 * una demanda tarda ~104 s y casi todo es espera del portal, así que dos sesiones
 * simultáneas partirían el tiempo de un lote grande casi por la mitad. El (2) sí
 * es real y por eso el límite se mantiene bajo.
 *
 * Por eso la concurrencia es configurable y el valor por defecto SIGUE SIENDO 1:
 * el comportamiento no cambia salvo que alguien lo suba a propósito con
 * SAC_CONCURRENCIA. Si el banco resulta intolerante a sesiones paralelas, se
 * vuelve a 1 sin desplegar código.
 *
 * Exporta una instancia única compartida por todo el servidor.
 */

'use strict';

class SacQueue {
  constructor(limite = 1) {
    this.limite = Math.max(1, Number(limite) || 1);
    this.size = 0;        // pendientes + en curso (lo usa la web para la posición)
    this._activas = 0;
    this._espera = [];
  }

  run(task) {
    this.size++;
    return new Promise((resolve, reject) => {
      const lanzar = () => {
        this._activas++;
        // La cadena nunca se rompe aunque una tarea falle: pase lo que pase se
        // libera el turno para la siguiente.
        Promise.resolve()
          .then(task)
          .then(
            (v) => { this._liberar(); this.size--; resolve(v); },
            (e) => { this._liberar(); this.size--; reject(e); },
          );
      };
      if (this._activas < this.limite) lanzar();
      else this._espera.push(lanzar);
    });
  }

  _liberar() {
    this._activas--;
    const siguiente = this._espera.shift();
    if (siguiente) siguiente();
  }
}

const limite = Number(process.env.SAC_CONCURRENCIA) || 1;
if (limite > 1) {
  console.log(`[colaSac] concurrencia SAC = ${limite} (experimental: el portal podría rechazar sesiones simultáneas)`);
}

module.exports = new SacQueue(limite);
module.exports.SacQueue = SacQueue;
