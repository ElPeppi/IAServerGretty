/**
 * diag-sac-alex.js — baja los SAC de una cédula del árbol de garantía mobiliaria
 * y revisa si su texto contiene "Días Mora" (lo que exige la detección de garantías).
 * Uso: node diag-sac-alex.js [cedula]
 */
require('dotenv').config();
const { google } = require('googleapis');
const pdf = require('C:/Repositories/IAServerGretty/sac_scripts/node_modules/pdf-parse');

const SA_KEY = process.env.DRIVE_SA_KEY || './sa-key.json';
const IMPERSONATE = process.env.DRIVE_IMPERSONATE_USER || '';
const ROOT = process.env.DRIVE_ROOT_FOLDER_ID || 'root';
const FOLDER = 'application/vnd.google-apps.folder';
const CED = process.argv[2] || '72166331';

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

  let p = ROOT;
  for (const s of ['DEMANDAS', 'FINANDINA', 'GARANTIA MOBILIARIAS', 'GARANTIAS']) p = await child(p, s);
  // Carpeta(s) de la cédula
  const folders = (await ls(`'${p}' in parents and mimeType='${FOLDER}' and trashed=false`, 'files(id,name)'))
    .filter((f) => (f.name.match(/\d{5,12}/) || [])[0] === CED);
  console.log(`\nCarpetas de ${CED} en garantía mobiliaria: ${folders.map((f) => `"${f.name}"`).join(', ') || '—'}\n`);

  for (const f of folders) {
    const archivos = await ls(`'${f.id}' in parents and trashed=false and mimeType!='${FOLDER}'`, 'files(id,name,mimeType)');
    for (const a of archivos) {
      if (!/^SAC_/i.test(a.name)) continue;
      let info = `  ${a.name} [${a.mimeType}]`;
      if (/pdf/i.test(a.mimeType)) {
        try {
          const r = await drive.files.get({ fileId: a.id, alt: 'media', ...common }, { responseType: 'arraybuffer' });
          const d = await pdf(Buffer.from(r.data));
          const txt = d.text || '';
          const hit = /D[ií]as\s*Mora/i.exec(txt);
          info += `  paginas=${d.numpages} textoLen=${txt.trim().length}  DíasMora=${hit ? 'SÍ ✅' : 'NO ❌'}`;
          if (hit) info += `  → "${txt.slice(hit.index, hit.index + 40).replace(/\s+/g, ' ')}"`;
        } catch (e) {
          info += `  (no se pudo leer: ${e.message})`;
        }
      }
      console.log(info);
    }
  }
  console.log('');
}

main().catch((e) => fail(e.message));
