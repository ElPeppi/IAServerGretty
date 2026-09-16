/**
 * Navega la ruta EXACTA del Drive de la oficina y descarga la plantilla del
 * estado de cuenta de Libertador:
 *   ROOT(05 DOCUMENTOS ACTUALIZADOS 2019)/DEMANDAS/LIBERTADOR/PLANTILLAS
 * Respaldo: archivo llamado "...EL LIBERTADOR..." si la ruta no resuelve.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const SA_KEY = process.env.DRIVE_SA_KEY || './sa-key.json';
const IMPERSONATE = process.env.DRIVE_IMPERSONATE_USER || '';
const ROOT = process.env.DRIVE_ROOT_FOLDER_ID || 'root';
const OUT_DIR = path.join(__dirname, '_descargas');
const FOLDER = 'application/vnd.google-apps.folder';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const GSHEET = 'application/vnd.google-apps.spreadsheet';

function fail(m) { console.error(`\n❌ ${m}\n`); process.exit(1); }

async function main() {
  const auth = new google.auth.JWT({ keyFile: SA_KEY, scopes: ['https://www.googleapis.com/auth/drive'], subject: IMPERSONATE });
  await auth.authorize().catch((e) => fail(`Auth: ${e.message}`));
  const drive = google.drive({ version: 'v3', auth });
  const common = { supportsAllDrives: true, includeItemsFromAllDrives: true };
  const ls = (q, fields = 'files(id,name,mimeType,size,modifiedTime,parents)') =>
    drive.files.list({ q, fields, pageSize: 500, ...common }).then((r) => r.data.files || []);

  async function child(parent, nameLike) {
    const items = await ls(`'${parent}' in parents and mimeType='${FOLDER}' and trashed=false`, 'files(id,name)');
    const hit = items.find((f) => f.name.toLowerCase() === nameLike.toLowerCase())
             || items.find((f) => f.name.toLowerCase().includes(nameLike.toLowerCase()));
    console.log(`  ${nameLike} → ${hit ? `${hit.name} [${hit.id}]` : `NO (hijos: ${items.map(x=>x.name).slice(0,30).join(', ')})`}`);
    return hit?.id || null;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const descargar = async (f, prefix='') => {
    const safe = (prefix + f.name).replace(/[\\/:*?"<>|]/g, '_');
    let dest = path.join(OUT_DIR, safe);
    if (f.mimeType === GSHEET) { if (!/\.xls[xm]?$/i.test(dest)) dest += '.xlsx';
      const r = await drive.files.export({ fileId: f.id, mimeType: XLSX_MIME }, { responseType: 'arraybuffer' });
      fs.writeFileSync(dest, Buffer.from(r.data)); }
    else { const r = await drive.files.get({ fileId: f.id, alt: 'media', ...common }, { responseType: 'arraybuffer' });
      fs.writeFileSync(dest, Buffer.from(r.data)); }
    console.log(`  ⬇️  ${dest}  (${f.size||'?'} bytes)`);
    return dest;
  };

  console.log('🌳 Navegando ruta exacta:');
  let p = ROOT;
  for (const seg of ['DEMANDAS', 'LIBERTADOR', 'PLANTILLAS']) {
    p = await child(p, seg);
    if (!p) break;
  }

  if (p) {
    const cont = await ls(`'${p}' in parents and trashed=false`);
    console.log(`\n📁 PLANTILLAS contiene ${cont.length} elemento(s):`);
    cont.forEach((f) => console.log(`   • ${f.name}  [${f.mimeType}]`));
    const objetivo = cont.filter((f) => /estado.*cuenta/i.test(f.name) && /\.xls|spreadsheet/i.test(f.mimeType + f.name));
    console.log(`\n⬇️  Descargando ${objetivo.length} plantilla(s) de estado de cuenta:`);
    for (const f of objetivo) await descargar(f, 'LIBERTADOR__');
    if (objetivo.length) { console.log('\n✅ Listo desde ruta exacta.'); return; }
  }

  // Respaldo: por nombre "EL LIBERTADOR"
  console.log('\n↩️  Ruta no dio la plantilla; respaldo por nombre "EL LIBERTADOR"...');
  const named = await ls(`name contains 'LIBERTADOR' and name contains 'ESTADO' and trashed=false`);
  named.forEach((f) => console.log(`   • ${f.name}  [${f.mimeType}]  id=${f.id}`));
  for (const f of named.filter((f) => /\.xls|spreadsheet/i.test(f.mimeType + f.name))) await descargar(f, 'NOMBRE__');
  console.log('\n✅ Listo (respaldo).');
}

main().catch((e) => fail(e.response?.data?.error?.message || e.message));
