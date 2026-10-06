const XLSX = require('xlsx');
const { construirMeses } = require('./src/services/libertador/estadoCuentaDesdePortal');
const { escribirPlantilla } = require('./src/services/libertador/plantillaXlsx');
const { evaluador } = require('./src/services/libertador/_evaluarHoja');
const PLANT = 'D:/Repositories/n8n/backend/_descargas/LIBERTADOR__ESTADO DE CUENTA IA.xls';
const cop = n => '$' + Math.round(n).toLocaleString('es-CO');

function mov(concepto, periodo, agencia, inquilino) {
  return { Concepto: concepto, Periodo: periodo,
    'Pgdo a la Agencia': '$ ' + agencia.toLocaleString('en-US'),
    'Pagos del Inquilino': '$ ' + inquilino.toLocaleString('en-US') };
}

async function probar(nombre, movs) {
  const r = construirMeses(movs);
  const buf = await escribirPlantilla(r, PLANT, { solicitud: 'TEST' });
  const ws = XLSX.read(buf, { type: 'buffer', cellFormula: true }).Sheets['Formato'];
  const v = evaluador(ws);

  const n = r.meses.length;
  const filaTotal = 17 + Math.max(0, (10 + n) - 16);
  const off = filaTotal - 17;

  const esperadoDeuda = r.totales.deuda.canon + r.totales.deuda.adm;
  const totalB = v('B' + filaTotal), totalC = v('C' + filaTotal);
  const totalI = v('I' + filaTotal), totalJ = v('J' + filaTotal);
  const capital = v('B' + (19 + off));
  const totalDeuda = v('B' + (25 + off));
  const saldoEsperado = r.totales.saldo.canon + r.totales.saldo.adm;

  const ok = (a, b) => Math.abs(a - b) < 0.5;
  const checks = [
    ['meses escritos', n, n],
    ['TOTAL deuda (B+C)', totalB + totalC, esperadoDeuda],
    ['TOTAL abonos (I+J)', totalI + totalJ, r.totales.abono.canon + r.totales.abono.adm],
    ['Capital = saldo', capital, saldoEsperado],
    ['TOTAL DEUDA = capital+250000+19%+honorarios+19%',
      totalDeuda,
      capital + 250000 + 250000 * 0.19
        + ((totalB + totalC + v('D'+filaTotal) + v('F'+filaTotal) + v('G'+filaTotal) + v('H'+filaTotal) + v('B'+(20+off))) * 0.25 - v('P'+filaTotal)) * 1.19],
    ['K7 = TOTAL DEUDA', v('K7'), totalDeuda],
  ];
  console.log('### ' + nombre + '  (' + n + ' meses, fila TOTAL = ' + filaTotal + ')');
  let todo = true;
  for (const [etiqueta, got, exp] of checks) {
    const bien = ok(got, exp); if (!bien) todo = false;
    console.log('   ', bien ? 'OK  ' : 'MAL ', etiqueta.padEnd(42), cop(got), bien ? '' : '≠ ' + cop(exp));
  }
  console.log('    →', todo ? 'TODO CUADRA' : 'HAY FALLOS');
  return todo;
}

// Caso real (5 meses)
const real = [
  mov('01','01/05/2026 a 30/06/2026',3712500,0), mov('01','01/07/2026 a 31/07/2026',1856250,0),
  mov('01','TD REIN',0,1437082), mov('01','01/08/2026 a 31/08/2026',1856250,0),
  mov('01','01/08/2026 a 31/08/2026',94670,0), mov('01','TD REIN',0,880000),
  mov('01','01/09/2026 a 30/09/2026',1950920,0),
];


// 9 meses + administración: obliga a ampliar la plantilla
const largo = [];
for (let i = 0; i < 9; i++) {
  const m = String(i + 1).padStart(2, '0');
  largo.push(mov('01', `01/${m}/2026 a 28/${m}/2026`, 1000000, 0));
  largo.push(mov('02', `01/${m}/2026 a 28/${m}/2026`, 200000, 0));
}
largo.push(mov('01','TD REIN',0,2500000));
largo.push(mov('02','TD REIN',0,500000));


// 2 meses: menos de los que trae la plantilla
const corto = [mov('01','01/01/2026 a 28/02/2026',2000000,0), mov('01','TD REIN',0,300000)];

(async () => {
  const a = await probar('5918715 — caso real', real);
  const b = await probar('sintético — 9 meses con administración', largo);
  const c = await probar('sintético — 2 meses', corto);
  console.log('');
  console.log('RESULTADO:', (a && b && c) ? 'los tres casos cuadran' : 'ALGO FALLA');
})();
