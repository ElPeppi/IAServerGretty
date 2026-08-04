/**
 * POC Google Drive — OAuth (cuenta PERSONAL Gmail).
 *
 * Variante de `poc.js` (service account + Shared Drive) para PROBAR con tu
 * cuenta personal, donde NO hay Unidades Compartidas y un service account no
 * puede escribir en "Mi unidad" (no tiene cuota propia).
 *
 * Autoriza con TU cuenta (flujo OAuth loopback en localhost) y luego hace lo
 * mismo que el POC de producción, en tu "Mi unidad":
 *   1) auth con tu cuenta
 *   2) LISTA archivos recientes                         (consultar)
 *   3) CREA un .txt de prueba (o lo reutiliza)          (modificar)
 *   4) LEE su contenido                                 (consultar)
 *   5) SOBRESCRIBE el contenido y vuelve a leer         (modificar)
 *
 * Requiere (lo descargas tú de Google Cloud):
 *   - oauth-credentials.json  → OAuth client tipo "App de escritorio".
 * Genera (secreto, NO se versiona):
 *   - token.json  → tu token; se reutiliza en corridas siguientes.
 *
 * Uso:  npm install   (una vez)
 *       node poc-oauth.js
 *
 * NOTA: en producción se usa el mecanismo de `poc.js` (service account +
 * Shared Drive del Workspace). Esta variante solo valida que la API de Drive
 * (consultar + modificar) funciona; no valida el mecanismo de producción.
 */
require('dotenv').config();
const fs = require('fs');
const http = require('http');
const { URL } = require('url');
const { Readable } = require('stream');
const { google } = require('googleapis');
const { exec } = require('child_process');

const CRED_FILE = process.env.OAUTH_CRED || './oauth-credentials.json';
const TOKEN_FILE = process.env.OAUTH_TOKEN || './token.json';
const TEST_NAME = 'poc-gretty-test.txt';
const SCOPES = ['https://www.googleapis.com/auth/drive'];

function fail(msg) { console.error(`\n❌ ${msg}\n`); process.exit(1); }
function bufferToStream(buf) { return Readable.from(buf); }

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, () => {}); // best-effort; si falla, la URL igual se imprime
}

async function getAuthClient() {
  if (!fs.existsSync(CRED_FILE)) {
    fail(`Falta ${CRED_FILE} — descarga un OAuth client tipo "App de escritorio" desde Google Cloud (ver README).`);
  }
  const raw = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
  const cfg = raw.installed || raw.web;
  if (!cfg || !cfg.client_id) {
    fail(`${CRED_FILE} no parece un OAuth client de "App de escritorio" (falta la clave "installed").`);
  }
  const { client_id, client_secret } = cfg;

  // Reutiliza el token si ya autorizaste antes.
  if (fs.existsSync(TOKEN_FILE)) {
    const oAuth2 = new google.auth.OAuth2(client_id, client_secret);
    oAuth2.setCredentials(JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')));
    // Persiste el token si googleapis lo refresca.
    oAuth2.on('tokens', (t) => {
      const cur = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      fs.writeFileSync(TOKEN_FILE, JSON.stringify({ ...cur, ...t }, null, 2));
    });
    return oAuth2;
  }

  // Primera vez: flujo OAuth con redirect a un servidor local (loopback).
  return await new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const redirectUri = `http://localhost:${port}`;
      const oAuth2 = new google.auth.OAuth2(client_id, client_secret, redirectUri);
      const authUrl = oAuth2.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });
      console.log('\nAbre esta URL en el navegador y autoriza con tu cuenta:\n');
      console.log(authUrl + '\n');
      openBrowser(authUrl);

      server.on('request', async (req, res) => {
        try {
          const u = new URL(req.url, redirectUri);
          const code = u.searchParams.get('code');
          const err = u.searchParams.get('error');
          if (err) {
            res.end('Autorizacion denegada: ' + err);
            server.close(); return reject(new Error('Autorización denegada: ' + err));
          }
          if (!code) { res.end('Esperando el code de Google...'); return; } // p.ej. /favicon.ico
          const { tokens } = await oAuth2.getToken(code);
          oAuth2.setCredentials(tokens);
          fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
          res.end('OK, autorizado. Cierra esta pestaña y vuelve a la terminal.');
          server.close(); resolve(oAuth2);
        } catch (e) {
          res.end('Error: ' + e.message);
          server.close(); reject(e);
        }
      });
    });
  });
}

async function main() {
  const auth = await getAuthClient();
  const drive = google.drive({ version: 'v3', auth });
  console.log('✅ 1. Auth OK\n');

  // ── 2. LISTAR (consultar) ───────────────────────────────────────────────────
  const list = await drive.files.list({
    q: 'trashed = false',
    fields: 'files(id,name,mimeType,modifiedTime,size)',
    orderBy: 'modifiedTime desc',
    pageSize: 10,
  });
  const files = list.data.files || [];
  console.log(`✅ 2. LISTAR — ${files.length} archivo(s) recientes en tu Drive:`);
  files.forEach((f) => console.log(`     • ${f.name}  [${f.id}]`));
  if (!files.length) console.log('     (sin archivos recientes)');
  console.log('');

  // ── 3. CREAR o reutilizar el archivo de prueba (modificar) ──────────────────
  const existing = files.find((f) => f.name === TEST_NAME);
  const contenido1 = `Hola Drive (OAuth personal) desde GrettyAI POC — creado ${new Date().toISOString()}\n`;
  let fileId;
  if (existing) {
    fileId = existing.id;
    await drive.files.update({ fileId, media: { mimeType: 'text/plain', body: bufferToStream(Buffer.from(contenido1)) } });
    console.log(`✅ 3. REUTILIZAR + sobrescribir "${TEST_NAME}"  [${fileId}]`);
  } else {
    const res = await drive.files.create({
      requestBody: { name: TEST_NAME },
      media: { mimeType: 'text/plain', body: bufferToStream(Buffer.from(contenido1)) },
      fields: 'id,webViewLink',
    });
    fileId = res.data.id;
    console.log(`✅ 3. CREAR "${TEST_NAME}"  [${fileId}]`);
    if (res.data.webViewLink) console.log(`     ${res.data.webViewLink}`);
  }
  console.log('');

  // ── 4. LEER (consultar contenido) ───────────────────────────────────────────
  const leer = async () => {
    const r = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
    return Buffer.from(r.data).toString('utf8');
  };
  console.log(`✅ 4. LEER contenido:\n     "${(await leer()).trim()}"\n`);

  // ── 5. SOBRESCRIBIR y volver a leer (modificar) ─────────────────────────────
  const contenido2 = `MODIFICADO ${new Date().toISOString()} — si ves esto, escribir funciona.\n`;
  await drive.files.update({ fileId, media: { mimeType: 'text/plain', body: bufferToStream(Buffer.from(contenido2)) } });
  console.log(`✅ 5. SOBRESCRIBIR + releer:\n     "${(await leer()).trim()}"\n`);

  console.log('─'.repeat(70));
  console.log('🎉 POC OAuth OK: consultar (listar+leer) y modificar (crear+sobrescribir) funcionan.');
  console.log(`   Archivo de prueba: ${TEST_NAME}  [${fileId}] — puedes borrarlo desde Drive.`);
  console.log('   Producción usará service account + Shared Drive (poc.js).');
}

main().catch((e) => fail(e.response?.data?.error?.message || e.message));
