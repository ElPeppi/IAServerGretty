/**
 * Convierte a RELATIVAS las URLs de documentos que quedaron guardadas con host
 * absoluto (p. ej. "http://107.22.122.49/docs/…").
 *
 * Hace falta porque el navegador BLOQUEA esas URLs: la web se sirve por HTTPS y
 * el documento se pedía por HTTP contra la IP cruda → "mixed content", y el visor
 * muere con "Failed to fetch". Guardarlas como "/docs/…" las hace inmunes al
 * esquema, al dominio y a un cambio de IP: siempre salen del mismo origen que la
 * página. El backend no se entera: `relPathFromUrl` busca el marcador "/docs/".
 *
 * El origen de las nuevas se controla con BASE_URL en el .env del backend; para
 * que salgan relativas debe estar VACÍO (BASE_URL=""). Este script solo arregla
 * las filas que ya están en la base.
 *
 *   npm run db:urls              → SIMULACIÓN: solo muestra qué cambiaría
 *   npm run db:urls -- --apply   → aplica los cambios
 */
import 'dotenv/config';
import { prisma } from './prisma/client';

// Se corta en "/docs/" en vez de comparar contra un host concreto: así también
// limpia filas viejas con localhost:3001 o con el dominio, no solo con la IP.
const MARCADOR = '/docs/';

function relativizar(url: string | null): string | null {
  if (!url) return null;
  const i = url.indexOf(MARCADOR);
  if (i <= 0) return null; // ya es relativa (i === 0) o no es una URL de /docs
  return url.slice(i);
}

// modelo → columnas de URL (ver schema.prisma)
const TABLAS = [
  { modelo: 'user' as const, campos: ['signatureUrl'] },
  {
    modelo: 'document' as const,
    campos: ['fileUrl', 'signedUrl', 'anexosUrl', 'antecedentesUrl', 'asignacionUrl', 'poderUrl'],
  },
  {
    modelo: 'asignacion' as const,
    campos: ['excelUrl', 'poderUrl', 'poderPagoDirectoUrl', 'correoPoderUrl'],
  },
];

type Fila = Record<string, unknown> & { id: string };

async function main() {
  const aplicar = process.argv.includes('--apply');
  let total = 0;
  const muestra: string[] = [];

  for (const { modelo, campos } of TABLAS) {
    // `any`: se recorre el cliente por nombre de modelo para no repetir el mismo
    // bloque tres veces; los campos vienen del schema, no de entrada del usuario.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const delegado = (prisma as any)[modelo];
    const select = Object.fromEntries([['id', true], ...campos.map((c) => [c, true])]);
    const filas: Fila[] = await delegado.findMany({ select });

    for (const fila of filas) {
      const data: Record<string, string> = {};
      for (const campo of campos) {
        const nueva = relativizar(fila[campo] as string | null);
        if (nueva) data[campo] = nueva;
      }
      if (Object.keys(data).length === 0) continue;

      total += Object.keys(data).length;
      if (muestra.length < 10) {
        const campo = Object.keys(data)[0];
        muestra.push(`  ${modelo}.${campo}: ${String(fila[campo]).slice(0, 70)}…  →  ${data[campo]}`);
      }
      if (aplicar) await delegado.update({ where: { id: fila.id }, data });
    }
  }

  if (total === 0) {
    console.log('✓ Todas las URLs ya son relativas; nada que corregir.');
    return;
  }

  console.log(`${total} URL(s) con host absoluto. Ejemplos:\n`);
  console.log(muestra.join('\n'));

  if (!aplicar) {
    console.log('\nSIMULACIÓN: no se escribió nada. Para aplicar:');
    console.log('  npm run db:urls -- --apply');
    return;
  }
  console.log(`\n✓ ${total} URL(s) corregida(s).`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
