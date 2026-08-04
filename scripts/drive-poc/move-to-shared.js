/**
 * Mueve TODO lo de "Mi unidad" de una cuenta (servidor@) a una Unidad Compartida,
 * por REPARENT (cambia la carpeta padre) — NO recopia bytes, los fileId no cambian.
 *
 * Auth: service account con DELEGACIÓN DE DOMINIO, suplantando a la cuenta dueña
 * (servidor@). Esa cuenta debe ser MIEMBRO (Administrador de contenido/Administrador)
 * de la Unidad Compartida destino, si no el mover falla.
 *
 * Uso:
 *   # 1) En SECO (solo lista lo que movería, no mueve nada):
 *   node move-to-shared.js --drive <SHARED_DRIVE_ID>
 *   # 2) Probar con pocas:
 *   node move-to-shared.js --drive <ID> --limit 2 --go
 *   # 3) Mover TODO de verdad:
 *   node move-to-shared.js --drive <ID> --go
 *
 * Env (o defaults):
 *   DRIVE_SA_KEY            ruta al JSON del SA   (default ../../backend/sa-key.json)
 *   DRIVE_IMPERSONATE_USER  cuenta a suplantar    (default servidor@jramosabogados.com)
 */
const path = require('path');
const fs = require('fs');
const { google } = require('googleapis');

/** Carga fileIds a OMITIR: de skip-ids.txt (mismo dir) + arg --skip-ids a,b,c. */
function loadSkipIds() {
  const ids = new Set();
  const file = path.resolve(__dirname, 'skip-ids.txt');
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const id = line.split('#')[0].trim();
      if (id) ids.add(id);
    }
  }
  const cli = process.argv[process.argv.indexOf('--skip-ids') + 1];
  if (process.argv.includes('--skip-ids') && cli) cli.split(',').forEach((x) => ids.add(x.trim()));
  return ids;
}

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) : def;
}
const SHARED_DRIVE_ID = arg('--drive', process.env.SHARED_DRIVE_ID);
const LIMIT = Number(arg('--limit', 0)) || 0;
const GO = process.argv.includes('--go');
const FILES_ONLY = process.argv.includes('--files-only'); // la API no mueve carpetas a Shared Drive
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SA_KEY = process.env.DRIVE_SA_KEY || path.resolve(__dirname, '../../backend/sa-key.json');
const IMPERSONATE = process.env.DRIVE_IMPERSONATE_USER || 'servidor@jramosabogados.com';

function fail(m) { console.error(`\n❌ ${m}\n`); process.exit(1); }

async function main() {
  if (!SHARED_DRIVE_ID) fail('Falta --drive <SHARED_DRIVE_ID> (o env SHARED_DRIVE_ID).');

  const auth = new google.auth.JWT({
    keyFile: SA_KEY,
    scopes: ['https://www.googleapis.com/auth/drive'],
    subject: IMPERSONATE,
  });
  await auth.authorize().catch((e) => fail(`Auth falló: ${e.message}`));
  const drive = google.drive({ version: 'v3', auth });

  console.log(`Suplantando: ${IMPERSONATE}`);
  console.log(`Unidad destino: ${SHARED_DRIVE_ID}`);
  console.log(`Modo: ${GO ? 'MOVER (--go)' : 'SECO (dry-run)'}${LIMIT ? ` | limit ${LIMIT}` : ''}`);
  console.log('─'.repeat(70));

  // 1) id real de la raíz de "Mi unidad" del usuario suplantado.
  const rootRes = await drive.files.get({ fileId: 'root', fields: 'id,name' });
  const rootId = rootRes.data.id;

  // Modo cuarentena: aparta los archivos de skip-ids.txt a una carpeta en Mi unidad,
  // para que en la raíz queden SOLO las carpetas legítimas (facilita el "Mover a" en la web).
  if (process.argv.includes('--quarantine')) {
    const SKIP = loadSkipIds();
    const QNAME = '__REVISAR_SEGURIDAD__';
    const found = await drive.files.list({
      q: `name = '${QNAME}' and '${rootId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id)', spaces: 'drive',
    });
    let qId = found.data.files?.[0]?.id;
    if (!qId) {
      const c = await drive.files.create({ requestBody: { name: QNAME, mimeType: FOLDER_MIME, parents: [rootId] }, fields: 'id' });
      qId = c.data.id;
      console.log(`Carpeta de cuarentena creada: ${QNAME} [${qId}]`);
    }
    let ok = 0, err = 0;
    for (const id of SKIP) {
      try {
        await drive.files.update({ fileId: id, addParents: qId, removeParents: rootId, fields: 'id' });
        ok++; console.log(`   ✅ apartado ${id}`);
      } catch (e) { err++; console.log(`   ❌ ${id}: ${e?.errors?.[0]?.message || e.message}`); }
    }
    console.log('─'.repeat(70));
    console.log(`🎉 Cuarentena: ${ok} apartados a "${QNAME}", ${err} con error.`);
    return;
  }

  // 2) listar TODO lo que cuelga de la raíz (carpetas + archivos), propiedad del usuario.
  const items = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      q: `'${rootId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id,name,mimeType,ownedByMe)',
      pageSize: 1000,
      pageToken,
      spaces: 'drive',
    });
    for (const f of res.data.files || []) items.push(f);
    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken);

  const SKIP = loadSkipIds();
  const propios = items.filter((f) => f.ownedByMe !== false); // no mover "compartido conmigo"
  let owned = propios.filter((f) => !SKIP.has(f.id));
  if (FILES_ONLY) owned = owned.filter((f) => f.mimeType !== FOLDER_MIME); // API no mueve carpetas
  const ajenos = items.length - propios.length;
  const saltados = propios.length - owned.length; // omitidos por skip-list (sospechosos)
  const targets = LIMIT ? owned.slice(0, LIMIT) : owned;

  console.log(`Encontrados en Mi unidad: ${items.length} (propios: ${propios.length}, ajenos omitidos: ${ajenos}, skip-list: ${saltados})`);
  console.log(`Se ${GO ? 'moverán' : 'moverían'}: ${targets.length}\n`);
  targets.forEach((f) => {
    const tipo = f.mimeType === 'application/vnd.google-apps.folder' ? '📁' : '📄';
    console.log(`   ${tipo} ${f.name}  [${f.id}]`);
  });
  console.log('');

  if (!GO) {
    console.log('SECO: no se movió nada. Repite con --go para mover de verdad.');
    return;
  }

  // 3) mover (reparent) cada uno a la raíz de la Unidad Compartida.
  let ok = 0, err = 0;
  for (const f of targets) {
    try {
      await drive.files.update({
        fileId: f.id,
        addParents: SHARED_DRIVE_ID,
        removeParents: rootId,
        supportsAllDrives: true,
        fields: 'id',
      });
      ok++;
      console.log(`   ✅ movido: ${f.name}`);
    } catch (e) {
      err++;
      console.log(`   ❌ ${f.name}: ${e?.errors?.[0]?.message || e.message}`);
    }
  }
  console.log('─'.repeat(70));
  console.log(`🎉 Listo: ${ok} movidos, ${err} con error.`);
}

main().catch((e) => fail(e?.errors?.[0]?.message || e.message));
