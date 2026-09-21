/**
 * diag-docx.js — baja la SOLICITUD .docx de una cédula (árbol de garantía
 * mobiliaria) y revisa su word/document.xml: caracteres de control inválidos para
 * XML y un chequeo básico de balance de etiquetas. Uso: node diag-docx.js [cedula]
 */
require('dotenv').config();
const { google } = require('googleapis');
const AdmZip = require('C:/Repositories/IAServerGretty/sac_scripts/node_modules/adm-zip');
const sax = require('C:/Repositories/IAServerGretty/sac_scripts/node_modules/sax');

// Valida XML de verdad. Devuelve el mensaje del PRIMER error (con posición) o null.
function validarXml(xml) {
  const parser = sax.parser(true, { xmlns: false });
  let error = null;
  parser.onerror = (e) => { if (!error) error = e.message.replace(/\s+/g, ' ').trim(); parser.error = null; };
  try { parser.write(xml).close(); } catch (e) { if (!error) error = e.message.replace(/\s+/g, ' ').trim(); }
  return error;
}

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
  const folder = (await ls(`'${p}' in parents and mimeType='${FOLDER}' and trashed=false`, 'files(id,name)'))
    .filter((f) => (f.name.match(/\d{5,12}/) || [])[0] === CED)
    .sort((a, b) => a.name.length - b.name.length)[0];
  if (!folder) fail(`sin carpeta para ${CED}`);
  console.log(`Carpeta: "${folder.name}"`);

  const docx = (await ls(`'${folder.id}' in parents and trashed=false`, 'files(id,name,mimeType)'))
    .find((f) => /^SOLICITUD DE APREHENSION.*\.docx$/i.test(f.name));
  if (!docx) fail('sin SOLICITUD .docx en la carpeta');
  console.log(`Archivo:  ${docx.name}\n`);

  const r = await drive.files.get({ fileId: docx.id, alt: 'media', ...common }, { responseType: 'arraybuffer' });
  const buf = Buffer.from(r.data);
  console.log(`tamaño .docx: ${buf.length} bytes`);
  let zip;
  try { zip = new AdmZip(buf); } catch (e) { fail(`no se pudo abrir el .docx como zip: ${e.message}`); }

  const entries = zip.getEntries().filter((e) => !e.isDirectory);
  console.log(`entradas en el zip: ${entries.length}\n`);

  const balance = (xml, tag) => {
    const abre = (xml.match(new RegExp(`<${tag}(?:[ >/])`, 'g')) || []).length;
    const autoc = (xml.match(new RegExp(`<${tag}[^>]*/>`, 'g')) || []).length;
    const cierra = (xml.match(new RegExp(`</${tag}>`, 'g')) || []).length;
    return (abre - autoc) === cierra ? '' : ` [${tag}: abre ${abre - autoc} / cierra ${cierra} ✗]`;
  };

  for (const e of entries) {
    const name = e.entryName;
    if (!/\.(xml|rels)$/i.test(name)) continue;
    let xml = '';
    try { xml = e.getData().toString('utf8'); } catch (err) { console.log(`✗ ${name}: no se pudo leer (${err.message})`); continue; }
    const ctrl = [...xml.matchAll(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g)];
    const marc = (xml.match(/«[^«»]{0,80}»/g) || []).length;
    const err = validarXml(xml);
    const problemas = [];
    if (err) problemas.push(`XML MAL FORMADO: ${err}`);
    if (ctrl.length) problemas.push(`${ctrl.length} car. control`);
    if (marc) problemas.push(`${marc} marcador(es) sin reemplazar`);
    const marca = problemas.length ? '⚠️ ' : '   ';
    console.log(`${marca}${name} (${xml.length})${problemas.length ? ' → ' + problemas.join('; ') : ' ok'}`);
  }

  // ── media (imágenes, etc.) ──────────────────────────────────────────────────
  console.log('\nMedia / binarios:');
  for (const e of entries) {
    if (/\.(xml|rels)$/i.test(e.entryName)) continue;
    const d = e.getData();
    const magic = d.slice(0, 4).toString('hex');
    const tipo = magic.startsWith('89504e47') ? 'PNG' : magic.startsWith('ffd8ff') ? 'JPEG'
      : magic.startsWith('25504446') ? 'PDF(!)' : magic.startsWith('504b0304') ? 'ZIP(!)' : `?(${magic})`;
    console.log(`   ${e.entryName} — ${d.length} bytes — ${tipo}`);
  }

  // ── integridad OOXML: rId, targets, content-types ───────────────────────────
  console.log('\nIntegridad de referencias:');
  const doc = zip.readAsText('word/document.xml');
  const rels = zip.readAsText('word/_rels/document.xml.rels');
  const ct = zip.readAsText('[Content_Types].xml');
  const nombres = new Set(entries.map((e) => e.entryName));

  const relIds = new Set([...rels.matchAll(/Id="([^"]+)"/g)].map((m) => m[1]));
  const usados = new Set([...doc.matchAll(/r:(?:embed|id|link)="([^"]+)"/g)].map((m) => m[1]));
  const faltanRel = [...usados].filter((id) => !relIds.has(id));
  console.log(`   rId usados en document.xml: ${[...usados].join(', ') || '—'}`);
  console.log(`   ${faltanRel.length ? '⚠️ rId sin relación: ' + faltanRel.join(', ') : 'todos los rId existen en rels ✓'}`);

  const targets = [...rels.matchAll(/Target="([^"]+)"(?:[^>]*TargetMode="External")?/g)]
    .map((m) => m[1]).filter((t) => !/^https?:|^mailto:/i.test(t));
  const faltanParte = targets
    .map((t) => 'word/' + t.replace(/^\//, ''))
    .filter((p) => !nombres.has(p) && !nombres.has(p.replace('word/', '')));
  console.log(`   ${faltanParte.length ? '⚠️ Targets sin parte: ' + faltanParte.join(', ') : 'todos los Target apuntan a partes existentes ✓'}`);

  const exts = new Set([...nombres].map((n) => (n.match(/\.([a-z0-9]+)$/i) || [])[1]).filter(Boolean).map((x) => x.toLowerCase()));
  const declaradas = new Set([...ct.matchAll(/Extension="([^"]+)"/gi)].map((m) => m[1].toLowerCase()));
  const overrides = new Set([...ct.matchAll(/PartName="([^"]+)"/g)].map((m) => m[1]));
  const sinCT = [...exts].filter((x) => !declaradas.has(x));
  console.log(`   extensiones: ${[...exts].join(', ')}`);
  console.log(`   ${sinCT.length ? '⚠️ sin Default en [Content_Types]: ' + sinCT.join(', ') + ' (¿override?)' : 'todas las extensiones tienen Default ✓'}`);
  if (sinCT.length) {
    for (const e of entries) {
      const x = (e.entryName.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
      if (sinCT.includes(x)) console.log(`       ${e.entryName}: override=${overrides.has('/' + e.entryName) ? 'sí' : 'NO ✗'}`);
    }
  }
}

main().catch((e) => fail(e.message));
