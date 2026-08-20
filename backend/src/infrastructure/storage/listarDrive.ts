/**
 * Lista una carpeta del almacenamiento (Drive en producción, disco en local).
 *
 * Sirve para saber QUÉ archivos tiene de verdad un cliente sin abrir la web: los
 * nombres reales hacen falta para construir una URL /docs/… correcta (p. ej. para
 * pasarle un pagaré a la sonda de OCR del motor).
 *
 *   npm run drive:ls -- "DEMANDAS/FINANDINA/EJECUTIVAS SINGULARES/GARANTIAS/1045231446-AGOSTO 2026"
 *   npm run drive:ls -- "DEMANDAS/FINANDINA"
 *
 * Si la carpeta sale vacía, se lista también la de arriba: casi siempre el fallo
 * es un nombre con el mes/año distinto, y así se ve al lado el correcto.
 */
import 'dotenv/config';
import { storage } from './index';

const kb = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

async function listar(rel: string): Promise<number> {
  const archivos = await storage.listDetallado(rel);
  const carpetas = (await storage.list(rel)).filter((n) => !archivos.some((a) => a.nombre === n));

  console.log(`\n${rel || '(raíz)'}`);
  if (!archivos.length && !carpetas.length) {
    console.log('  (vacía o inexistente)');
    return 0;
  }
  for (const c of carpetas.sort()) console.log(`  📁 ${c}`);
  for (const a of archivos.sort((x, y) => x.nombre.localeCompare(y.nombre))) {
    console.log(`  📄 ${a.nombre}   ${kb(a.tamano)}`);
    console.log(`     /docs/${a.nombre ? [rel, a.nombre].join('/').split('/').map(encodeURIComponent).join('/') : ''}`);
  }
  return archivos.length + carpetas.length;
}

/**
 * Dice QUÉ falta, sin imprimir valores (hay una clave de servicio de por medio).
 *
 * El caso típico en el servidor: el backend funciona porque pm2 le pasó las
 * variables al arrancar, pero no están en el .env — así que un script suelto
 * como éste arranca sin ellas. Ver también DOCS_DIR y BASE_URL, que ya dieron
 * este mismo susto.
 */
function porQueNoEstaConfigurado(): string[] {
  const driver = (process.env.STORAGE_DRIVER || 'nas').toLowerCase();
  const falta = (k: string) => !process.env[k];
  if (driver === 'drive') {
    if ((process.env.DRIVE_AUTH || 'delegation').toLowerCase() === 'oauth') {
      return ['DRIVE_OAUTH_CRED', 'DRIVE_OAUTH_TOKEN'].filter(falta);
    }
    const req = ['DRIVE_SA_KEY', 'DRIVE_IMPERSONATE_USER'].filter(falta);
    if (!process.env.DRIVE_SHARED_DRIVE_ID && !process.env.DRIVE_ROOT_FOLDER_ID) {
      req.push('DRIVE_SHARED_DRIVE_ID o DRIVE_ROOT_FOLDER_ID');
    }
    return req;
  }
  return falta('DOCS_DIR') ? ['DOCS_DIR'] : [];
}

async function main() {
  const rel = (process.argv[2] ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!storage.enabled) {
    const driver = (process.env.STORAGE_DRIVER || 'nas').toLowerCase();
    console.error(`El almacenamiento no está configurado. STORAGE_DRIVER=${driver}`);
    const faltan = porQueNoEstaConfigurado();
    console.error(faltan.length
      ? `Faltan estas variables: ${faltan.join(', ')}`
      : 'Las variables parecen estar; revisa que apunten a algo válido.');
    console.error('\nSi el backend SÍ funciona, es que pm2 las tiene y el .env no.');
    console.error('Para heredar el entorno del proceso vivo:');
    console.error('  export $(tr \'\\0\' \'\\n\' < /proc/$(pgrep -f gretty-backend | head -1)/environ \\');
    console.error('    | grep -E \'^(STORAGE_DRIVER|DRIVE_|DOCS_DIR)=\' | xargs -d \'\\n\')');
    process.exit(1);
  }

  const n = await listar(rel);
  if (n === 0 && rel.includes('/')) {
    const padre = rel.slice(0, rel.lastIndexOf('/'));
    console.log('\n— Como estaba vacía, esto es lo que hay en la carpeta de arriba —');
    await listar(padre);
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => process.exit(0));
