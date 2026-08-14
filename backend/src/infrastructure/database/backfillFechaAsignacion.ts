/**
 * Recalcula `fechaAsignacion` de las asignaciones ya cacheadas.
 *
 * Hace falta porque el parser de fechas no entendía los meses abreviados
 * ("1 SEP 2025") ni el mes pegado al año ("30 SEP2025"): esas asignaciones se
 * guardaron con el fallback "1 de enero del año de la carpeta". El escaneo de
 * "Actualizar asignaciones" salta las que ya existen por nombre, así que no se
 * corrigen solas.
 *
 *   npm run db:fechas        → SIMULACIÓN: solo muestra qué cambiaría
 *   npm run db:fechas -- --apply   → aplica los cambios
 */
import 'dotenv/config';
import { prisma } from './prisma/client';
import { fechaDesdeNombre } from '../services/fechaAsignacion';

// Incluye la HORA a propósito: al normalizar a mediodía UTC, muchas filas cambian
// solo en la hora y un formato de solo fecha haría parecer que no cambia nada.
const fmt = (d: Date | null) => (d ? d.toISOString().slice(0, 16).replace('T', ' ') + 'Z' : '—');

async function main() {
  const aplicar = process.argv.includes('--apply');
  const asignaciones = await prisma.asignacion.findMany({
    select: { id: true, nombre: true, fechaAsignacion: true },
    orderBy: { nombre: 'asc' },
  });

  const cambios = asignaciones.flatMap((a) => {
    const nueva = fechaDesdeNombre(a.nombre);
    // Solo se toca cuando el nombre SÍ da una fecha y difiere de la guardada.
    // Si el nombre no trae fecha, se respeta lo que haya (pudo ponerla el usuario
    // al subir el Excel a mano).
    if (!nueva) return [];
    const actual = a.fechaAsignacion;
    if (actual && actual.getTime() === nueva.getTime()) return [];
    return [{ id: a.id, nombre: a.nombre, actual, nueva }];
  });

  if (cambios.length === 0) {
    console.log(`✓ ${asignaciones.length} asignación(es) revisada(s); nada que corregir.`);
    return;
  }

  console.log(`${cambios.length} de ${asignaciones.length} asignación(es) con la fecha mal:\n`);
  for (const c of cambios) {
    console.log(`  ${fmt(c.actual)} → ${fmt(c.nueva)}   ${c.nombre}`);
  }

  if (!aplicar) {
    console.log('\nSIMULACIÓN: no se escribió nada. Para aplicar:');
    console.log('  npm run db:fechas -- --apply');
    return;
  }

  await prisma.$transaction(
    cambios.map((c) => prisma.asignacion.update({ where: { id: c.id }, data: { fechaAsignacion: c.nueva } }))
  );
  console.log(`\n✓ ${cambios.length} fecha(s) corregida(s).`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
