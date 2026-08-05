// Crea (o encuentra) una carpeta raíz dentro de la Unidad Compartida e imprime su ID.
// Uso: node ensure-root.js --drive <SHARED_DRIVE_ID> --name GARANTIAS
const path = require('path');
const { google } = require('googleapis');

const a = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const DRIVE = a('--drive', process.env.SHARED_DRIVE_ID);
const NAME = a('--name', 'GARANTIAS');
const SA_KEY = process.env.DRIVE_SA_KEY || path.resolve(__dirname, '../../backend/sa-key.json');
const SUBJECT = process.env.DRIVE_IMPERSONATE_USER || 'servidor@jramosabogados.com';
const FOLDER = 'application/vnd.google-apps.folder';

(async () => {
  if (!DRIVE) { console.error('Falta --drive'); process.exit(1); }
  const auth = new google.auth.JWT({ keyFile: SA_KEY, scopes: ['https://www.googleapis.com/auth/drive'], subject: SUBJECT });
  const drive = google.drive({ version: 'v3', auth });
  const found = await drive.files.list({
    q: `name = '${NAME}' and '${DRIVE}' in parents and mimeType = '${FOLDER}' and trashed = false`,
    fields: 'files(id,name)', corpora: 'drive', driveId: DRIVE,
    includeItemsFromAllDrives: true, supportsAllDrives: true,
  });
  let id = found.data.files?.[0]?.id;
  if (id) { console.log(`YA EXISTE ${NAME} = ${id}`); return; }
  const c = await drive.files.create({
    requestBody: { name: NAME, mimeType: FOLDER, parents: [DRIVE] },
    fields: 'id', supportsAllDrives: true,
  });
  console.log(`CREADA ${NAME} = ${c.data.id}`);
})().catch((e) => { console.error('ERROR:', e?.errors?.[0]?.message || e.message); process.exit(1); });
