/**
 * verificar-mover.js — comprueba que los SAC se movieron al árbol correcto.
 * Para cada cédula de la muestra: cuenta SAC/CONTACTOS en la carpeta de la
 * cédula en GARANTIA MOBILIARIAS (debe haber) y en EJECUTIVAS SINGULARES (debe
 * quedar 0). Uso: node verificar-mover.js [ced1 ced2 ...]
 */
require('dotenv').config();
const { google } = require('googleapis');

const SA_KEY = process.env.DRIVE_SA_KEY || './sa-key.json';
const IMPERSONATE = process.env.DRIVE_IMPERSONATE_USER || '';
const ROOT = process.env.DRIVE_ROOT_FOLDER_ID || 'root';
const FOLDER = 'application/vnd.google-apps.folder';
const SAC_FILE = /^(SAC_.*\.pdf|CONTACTOS_.*\.csv)$/i;

const MUESTRA = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['72166331', '1067818120', '39031201', '45754033', '19610390', '1143460817'];

function fail(m) { console.error(`\n❌ ${m}\n`); process.exit(1); }

async function main() {
  const auth = new google.auth.JWT({ keyFile: SA_KEY, scopes: ['https://www.googleapis.com/auth/drive'], subject: IMPERSONATE });
  await auth.authorize().catch((e) => fail(`Auth: ${e.message}`));
  const drive = google.drive({ version: 'v3', auth });
  const common = { supportsAllDrives: true, includeItemsFromAllDrives: true };
  const ls = (q, fields) => drive.files.list({ q, fields, pageSize: 1000, ...common }).then((r) => r.data.files || []);
  const child = async (parent, nameLike) => {
    const items = await ls(`'${parent}' in parents and mimeType='${FOLDER}' and trashed=false`, 'files(id,name)');
    const hit = items.find((f) => f.name.toLowerCase() === nameLike.toLowerCase())
             || items.find((f) => f.name.toLowerCase().includes(nameLike.toLowerCase()));
    if (!hit) fail(`No resolvió "${nameLike}"`);
    return hit.id;
  };
  const resolver = async (segs) => { let p = ROOT; for (const s of segs) p = await child(p, s); return p; };

  const destBase = await resolver(['DEMANDAS', 'FINANDINA', 'GARANTIA MOBILIARIAS', 'GARANTIAS']);
  const srcBase  = await resolver(['DEMANDAS', 'FINANDINA', 'EJECUTIVAS SINGULARES', 'GARANTIAS']);

  const foldersDe = async (base) => ls(`'${base}' in parents and mimeType='${FOLDER}' and trashed=false`, 'files(id,name)');
  const destFolders = await foldersDe(destBase);
  const srcFolders  = await foldersDe(srcBase);

  const sacEnCarpetasDe = async (folders, ced) => {
    const hits = folders.filter((f) => (f.name.match(/\d{5,12}/) || [])[0] === ced);
    let total = 0; const nombres = [];
    for (const f of hits) {
      const archivos = await ls(`'${f.id}' in parents and trashed=false and mimeType!='${FOLDER}'`, 'files(name)');
      for (const a of archivos) if (SAC_FILE.test(a.name)) { total++; nombres.push(a.name); }
    }
    return { total, nombres, carpetas: hits.map((h) => h.name) };
  };

  console.log('\nVerificación (SAC/CONTACTOS por cédula):\n');
  let ok = 0, mal = 0;
  for (const ced of MUESTRA) {
    const dst = await sacEnCarpetasDe(destFolders, ced);
    const src = await sacEnCarpetasDe(srcFolders, ced);
    const bien = dst.total > 0 && src.total === 0;
    console.log(`${bien ? '✅' : '❌'} ${ced}`);
    console.log(`    garantía mobiliaria [${dst.carpetas.join(', ') || '—'}]: ${dst.total} archivo(s)  ${dst.nombres.join(', ')}`);
    console.log(`    singular            [${src.carpetas.join(', ') || '—'}]: ${src.total} archivo(s)  ${src.nombres.join(', ')}`);
    bien ? ok++ : mal++;
  }
  console.log(`\nResultado: ${ok} OK, ${mal} con problema.\n`);
}

main().catch((e) => fail(e.message));
