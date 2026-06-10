/**
 * services/colaSac.js — Cola de ejecución Puppeteer (una sesión SAC a la vez)
 *
 * El servidor puede recibir varios lotes de ZIPs simultáneamente; la cola
 * garantiza que Chromium corre de a uno para evitar conflictos de sesión
 * en el SAC y no saturar la RAM.
 *
 * Exporta una instancia única compartida por todo el servidor.
 */

'use strict';

class SacQueue {
  constructor() { this._chain = Promise.resolve(); this.size = 0; }
  run(task) {
    this.size++;
    return new Promise((resolve, reject) => {
      // Cada tarea se encadena; la cadena nunca se rompe aunque falle una tarea
      this._chain = this._chain.then(
        () => task().then(
          v => { this.size--; resolve(v); },
          e => { this.size--; reject(e); }
        )
      );
    });
  }
}

module.exports = new SacQueue();
module.exports.SacQueue = SacQueue;
