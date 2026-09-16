/**
 * Baja las plantillas del PODER DE CONCILIACIÓN de Libertador desde el Drive:
 *   ROOT(05 DOCUMENTOS ACTUALIZADOS 2019)/DEMANDAS/LIBERTADOR/CREAR PODERES/**
 * Descarga (recursivo) todo archivo cuyo nombre contenga "PODER" a backend/_descargas.
 * Reusa la misma auth de service account que traer-plantilla-libertador.js.
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
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const GSHEET = 'application/vnd.google-apps.spreadsheet';
const GDOC = 'application/vnd.google-apps.document';

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
  const descargar = async (f) => {
    const safe = ('LIBERTADOR PODER__' + f.name).replace(/[\\/:*?"<>|]/g, '_');
    let dest = path.join(OUT_DIR, safe);
    if (f.mimeType === GSHEET) {
      if (!/\.xls[xm]?$/i.test(dest)) dest += '.xlsx';
      const r = await drive.files.export({ fileId: f.id, mimeType: XLSX_MIME }, { responseType: 'arraybuffer' });
      fs.writeFileSync(dest, Buffer.from(r.data));
    } else if (f.mimeType === GDOC) {
      if (!/\.docx?$/i.test(dest)) dest += '.docx';
      const r = await drive.files.export({ fileId: f.id, mimeType: DOCX_MIME }, { responseType: 'arraybuffer' });
      fs.writeFileSync(dest, Buffer.from(r.data));
    } else {
      const r = await drive.files.get({ fileId: f.id, alt: 'media', ...common }, { responseType: 'arraybuffer' });
      fs.writeFileSync(dest, Buffer.from(r.data));
    }
    console.log(`  ⬇️  ${dest}  (${f.size || '?'} bytes)`);
    return dest;
  };

  // Recorre recursivamente una carpeta y baja los archivos que matcheen /poder/i.
  async function recorrer(folderId, prof = 0) {
    const items = await ls(`'${folderId}' in parents and trashed=false`);
    for (const f of items) {
      if (f.mimeType === FOLDER) {
        console.log(`${'  '.repeat(prof)}📁 ${f.name}`);
        await recorrer(f.id, prof + 1);
      } else if (/poder/i.test(f.name)) {
        console.log(`${'  '.repeat(prof)}📄 ${f.name} (${f.mimeType})`);
        await descargar(f);
      }
    }
  }

  console.log('🌳 Navegando: DEMANDAS / LIBERTADOR / CREAR PODERES');
  let p = ROOT;
  for (const seg of ['DEMANDAS', 'LIBERTADOR', 'CREAR PODERES']) {
    p = await child(p, seg);
    if (!p) fail(`No resolvió el segmento "${seg}"`);
  }
  console.log('\n📥 Descargando archivos con "PODER" (recursivo):');
  await recorrer(p);
  console.log('\n✅ Listo.');
}

main().catch((e) => fail(e.message));
