/**
 * POC Google Drive — consultar + modificar (Shared Drive con service account).
 *
 * Valida el MISMO mecanismo que usará la migración (docs/DISENO-STORAGE-DRIVE.md):
 * service account miembro de una Shared Drive, sin domain-wide delegation.
 *
 * Hace, en orden:
 *   1) auth y confirma quién es el service account
 *   2) LISTA archivos de la carpeta destino            (consultar)
 *   3) CREA un archivo de prueba (o lo reutiliza)       (modificar)
 *   4) LEE su contenido                                 (consultar)
 *   5) SOBRESCRIBE el contenido y vuelve a leer         (modificar)
 *
 * Uso:  npm install   (una vez)
 *       node poc.js
 * Requiere .env (ver .env.example).
 */
require('dotenv').config();
const fs = require('fs');
const { Readable } = require('stream');
const { google } = require('googleapis');

const SA_KEY = process.env.DRIVE_SA_KEY || '';
const SHARED_DRIVE_ID = process.env.DRIVE_SHARED_DRIVE_ID || '';
const ROOT_FOLDER_ID = process.env.DRIVE_ROOT_FOLDER_ID || SHARED_DRIVE_ID;
const TEST_NAME = 'poc-gretty-test.txt';

function fail(msg) { console.error(`\n❌ ${msg}\n`); process.exit(1); }

function bufferToStream(buf) { return Readable.from(buf); }

async function main() {
  // ── 0. Validación de entorno ────────────────────────────────────────────────
  if (!SA_KEY) fail('Falta DRIVE_SA_KEY (ruta al JSON del service account) en .env');
  if (!fs.existsSync(SA_KEY)) fail(`No existe el archivo de clave: ${SA_KEY}`);
  if (!SHARED_DRIVE_ID) fail('Falta DRIVE_SHARED_DRIVE_ID en .env (ID de la Unidad compartida)');

  const key = JSON.parse(fs.readFileSync(SA_KEY, 'utf8'));
  console.log(`Service account: ${key.client_email}`);
  console.log(`Shared Drive ID: ${SHARED_DRIVE_ID}`);
  console.log(`Carpeta destino: ${ROOT_FOLDER_ID}`);
  console.log('─'.repeat(70));

  // ── 1. Auth ─────────────────────────────────────────────────────────────────
  const auth = new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  await auth.authorize().catch((e) => fail(`Auth falló: ${e.message} (¿habilitaste la Drive API en el proyecto?)`));
  const drive = google.drive({ version: 'v3', auth });
  console.log('✅ 1. Auth OK\n');

  const common = { supportsAllDrives: true };

  // ── 2. LISTAR (consultar) ───────────────────────────────────────────────────
  let list;
  try {
    list = await drive.files.list({
      q: `'${ROOT_FOLDER_ID}' in parents and trashed = false`,
      fields: 'files(id,name,mimeType,modifiedTime,size)',
      corpora: 'drive',
      driveId: SHARED_DRIVE_ID,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      pageSize: 20,
    });
  } catch (e) {
    if (e.code === 404) fail(`Carpeta/Drive no encontrada (404). Revisa DRIVE_SHARED_DRIVE_ID / DRIVE_ROOT_FOLDER_ID.`);
    if (e.code === 403) fail(`Sin permiso (403). ¿El service account (${key.client_email}) es MIEMBRO de la Shared Drive con rol "Administrador de contenido"?`);
    fail(`files.list falló: ${e.message}`);
  }
  const files = list.data.files || [];
  console.log(`✅ 2. LISTAR — ${files.length} archivo(s) en la carpeta:`);
  files.forEach((f) => console.log(`     • ${f.name}  [${f.id}]`));
  if (!files.length) console.log('     (carpeta vacía — normal si es nueva)');
  console.log('');

  // ── 3. CREAR o reutilizar el archivo de prueba (modificar) ──────────────────
  const existing = files.find((f) => f.name === TEST_NAME);
  const contenido1 = `Hola Drive desde GrettyAI POC — creado ${new Date().toISOString()}\n`;
  let fileId;
  if (existing) {
    fileId = existing.id;
    await drive.files.update({ fileId, media: { mimeType: 'text/plain', body: bufferToStream(Buffer.from(contenido1)) }, ...common });
    console.log(`✅ 3. REUTILIZAR + sobrescribir "${TEST_NAME}"  [${fileId}]`);
  } else {
    const res = await drive.files.create({
      requestBody: { name: TEST_NAME, parents: [ROOT_FOLDER_ID] },
      media: { mimeType: 'text/plain', body: bufferToStream(Buffer.from(contenido1)) },
      fields: 'id,webViewLink',
      supportsAllDrives: true,
    });
    fileId = res.data.id;
    console.log(`✅ 3. CREAR "${TEST_NAME}"  [${fileId}]`);
    if (res.data.webViewLink) console.log(`     ${res.data.webViewLink}`);
  }
  console.log('');

  // ── 4. LEER (consultar contenido) ───────────────────────────────────────────
  const leer = async () => {
    const r = await drive.files.get({ fileId, alt: 'media', ...common }, { responseType: 'arraybuffer' });
    return Buffer.from(r.data).toString('utf8');
  };
  console.log(`✅ 4. LEER contenido:\n     "${(await leer()).trim()}"\n`);

  // ── 5. SOBRESCRIBIR y volver a leer (modificar) ─────────────────────────────
  const contenido2 = `MODIFICADO ${new Date().toISOString()} — si ves esto, escribir funciona.\n`;
  await drive.files.update({ fileId, media: { mimeType: 'text/plain', body: bufferToStream(Buffer.from(contenido2)) }, ...common });
  console.log(`✅ 5. SOBRESCRIBIR + releer:\n     "${(await leer()).trim()}"\n`);

  console.log('─'.repeat(70));
  console.log('🎉 POC OK: consultar (listar+leer) y modificar (crear+sobrescribir) funcionan.');
  console.log(`   Archivo de prueba: ${TEST_NAME}  [${fileId}] — puedes borrarlo desde Drive.`);
}

main().catch((e) => fail(e.message));
