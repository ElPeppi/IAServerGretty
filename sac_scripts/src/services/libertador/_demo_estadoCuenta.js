/**
 * DEMO: genera un estado de cuenta de El Libertador a partir de la plantilla en
 * blanco, con datos ILUSTRATIVOS (no reales), para validar el generador.
 *   node _demo_estadoCuenta.js <plantilla.xls> <salida.xlsx>
 */
const { generarEstadoCuenta } = require('./estadoCuenta');

const [,, plantilla, salida] = process.argv;
if (!plantilla || !salida) {
  console.error('Uso: node _demo_estadoCuenta.js <plantilla.xls> <salida.xlsx>');
  process.exit(1);
}

const mes = (y, m) => new Date(y, m - 1, 1);
const datos = {
  elaboro: 'GRETTY AI (DEMO)',
  fechaElaboracion: new Date(),
  ocupado: 'JUAN PÉREZ (ARRENDATARIO DE PRUEBA)',
  pol: 'DEMO-POL',
  solicitud: '9999999',
  meses: [
    { mes: mes(2025, 1), deuda: { canon: 1500000, adm: 200000 }, abono: { canon: 0, adm: 0 } },
    { mes: mes(2025, 2), deuda: { canon: 1500000, adm: 200000 }, abono: { canon: 500000, adm: 0 } },
    { mes: mes(2025, 3), deuda: { canon: 1500000, adm: 200000 }, abono: { canon: 0, adm: 0 } },
    { mes: mes(2025, 4), deuda: { canon: 1500000, adm: 200000 }, abono: { canon: 0, adm: 0 } },
    { mes: mes(2025, 5), deuda: { canon: 1500000, adm: 200000 }, abono: { canon: 0, adm: 0 } },
    { mes: mes(2025, 6), deuda: { canon: 1500000, adm: 200000 }, abono: { canon: 0, adm: 0 } },
  ],
  indemnizacion: 0,
  tramiteConciliacion: 250000,
};

const buf = generarEstadoCuenta(datos, plantilla);
require('fs').writeFileSync(salida, buf);
console.log(`✅ Estado de cuenta DEMO generado: ${salida} (${buf.length} bytes)`);
console.log('   Ábrelo en Excel/LibreOffice para ver los totales calculados por las fórmulas.');
