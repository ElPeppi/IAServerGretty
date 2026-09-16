/**
 * Lista (y opcionalmente baja) el contenido de la carpeta de un caso de Libertador:
 *   ROOT/DEMANDAS/LIBERTADOR/SINGULAR/<CASO>
 * Uso: node analizar-caso-libertador.js <CASO> [--download]
 * Baja a backend/_descargas/caso_<CASO>/ todo lo que NO sea demanda ni poder.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const SA_KEY = process.env.DRIVE_SA_KEY || './sa-key.json';
const IMPERSONATE = process.env.DRIVE_IMPERSONATE_USER || '';
const ROOT = process.env.DRIVE_ROOT_FOLDER_ID || 'root';
const FOLDER = 'application/vnd.google-apps.folder';

const CASO = process.argv[2] || '4755208';
const DOWNLOAD = process.argv.includes('--download');
const OUT_DIR = path.join(__dirname, '_descargas', `caso_${CASO}`);
const EXCLUIR = /demanda|poder/i; // no bajar demanda ni poderes

function fail(m) { console.error(`\n❌ ${m}\n`); process.exit(1); }

async function main() {
  const auth = new google.auth.JWT({ keyFile: SA_KEY, scopes: ['https://www.googleapis.com/auth/drive'], subject: IMPERSONATE });
  await auth.authorize().catch((e) => fail(`Auth: ${e.message}`));
  const drive = google.drive({ version: 'v3', auth });
  const common = { supportsAllDrives: true, includeItemsFromAllDrives: true };
  const ls = (q, fields = 'files(id,name,mimeType,size,modifiedTime)') =>
    drive.files.list({ q, fields, pageSize: 500, ...common }).then((r) => r.data.files || []);

  async function child(parent, nameLike) {
    const items = await ls(`'${parent}' in parents and mimeType='${FOLDER}' and trashed=false`, 'files(id,name)');
    const hit = items.find((f) => f.name.toLowerCase() === nameLike.toLowerCase())
             || items.find((f) => f.name.toLowerCase().includes(nameLike.toLowerCase()));
    console.log(`  ${nameLike} → ${hit ? hit.name : `NO (hijos: ${items.map(x=>x.name).slice(0,40).join(', ')})`}`);
    return hit?.id || null;
  }

  console.log(`🌳 Navegando: DEMANDAS / LIBERTADOR / SINGULAR / ${CASO}`);
  let p = ROOT;
  for (const seg of ['DEMANDAS', 'LIBERTADOR', 'SINGULAR', CASO]) {
    p = await child(p, seg);
    if (!p) fail(`No resolvió "${seg}"`);
  }

  const items = await ls(`'${p}' in parents and trashed=false`);
  console.log(`\n📁 Caso ${CASO}: ${items.length} elemento(s)\n`);
  items.forEach((f) => {
    const kb = f.size ? (f.size / 1024).toFixed(0) + ' KB' : '—';
    console.log(`  ${EXCLUIR.test(f.name) ? '⛔' : '  '} ${f.name}  [${f.mimeType.split('.').pop()}, ${kb}]`);
  });

  if (DOWNLOAD) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    console.log(`\n📥 Descargando (excluye demanda/poder) → ${OUT_DIR}`);
    for (const f of items) {
      if (f.mimeType === FOLDER || EXCLUIR.test(f.name)) continue;
      const dest = path.join(OUT_DIR, f.name.replace(/[\\/:*?"<>|]/g, '_'));
      try {
        const r = await drive.files.get({ fileId: f.id, alt: 'media', ...common }, { responseType: 'arraybuffer' });
        fs.writeFileSync(dest, Buffer.from(r.data));
        console.log(`  ⬇️  ${f.name} (${(r.data.byteLength/1024).toFixed(0)} KB)`);
      } catch (e) {
        console.log(`  ⚠️  ${f.name}: ${e.message}`);
      }
    }
  }
  console.log('\n✅ Listo.');
}

main().catch((e) => fail(e.message));
