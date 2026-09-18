/**
 * mover-sac-pago-directo.js — reubica los SAC que cayeron en el árbol EQUIVOCADO.
 *
 * Antes del fix, la descarga del SAC subía SIEMPRE a EJECUTIVAS SINGULARES. Los
 * casos de pago directo (garantía mobiliaria) quedaron con su SAC en el árbol
 * singular, separado del resto del expediente. Este script los devuelve a su sitio.
 *
 *   Origen : DEMANDAS/FINANDINA/EJECUTIVAS SINGULARES/GARANTIAS/<carpeta cédula>
 *   Destino: DEMANDAS/FINANDINA/GARANTIA MOBILIARIAS/GARANTIAS/<carpeta cédula>
 *
 * Criterio: una carpeta del árbol singular es candidata si (a) contiene archivos
 * SAC_*.pdf / CONTACTOS_*.csv y (b) esa MISMA cédula tiene carpeta en el árbol de
 * garantía mobiliaria (señal de que es un caso de pago directo). Mueve SOLO esos
 * archivos (no la carpeta), al folder más reciente de la cédula en el destino.
 *
 * Uso:
 *   node mover-sac-pago-directo.js            # DRY-RUN: solo reporta qué movería
 *   node mover-sac-pago-directo.js --apply    # ejecuta el movimiento
 *
 * El movimiento en Drive conserva el fileId (addParents/removeParents), así que es
 * reversible. No borra nada; si un archivo ya existe en el destino, lo OMITE.
 */
require('dotenv').config();
const { google } = require('googleapis');

const SA_KEY = process.env.DRIVE_SA_KEY || './sa-key.json';
const IMPERSONATE = process.env.DRIVE_IMPERSONATE_USER || '';
const ROOT = process.env.DRIVE_ROOT_FOLDER_ID || 'root';
const FOLDER = 'application/vnd.google-apps.folder';
const APPLY = process.argv.includes('--apply');

const SAC_FILE = /^(SAC_.*\.pdf|CONTACTOS_.*\.csv)$/i;
const MESES = { enero:1,febrero:2,marzo:3,abril:4,mayo:5,junio:6,julio:7,agosto:8,
  septiembre:9,setiembre:9,octubre:10,noviembre:11,diciembre:12,nov:11,gosto:8 };

function fail(m) { console.error(`\n❌ ${m}\n`); process.exit(1); }

// Cédula (primera corrida de 5-12 dígitos) + año/mes de lo que sobra del nombre.
function analizar(nombre) {
  const m = String(nombre).match(/\d{5,12}/);
  if (!m) return null;
  const cedula = m[0];
  const sufijo = String(nombre).slice(m.index + cedula.length);
  let anio = 0, mes = 0;
  for (const p of sufijo.toLowerCase().split(/[^a-z0-9áéíóú]+/i).filter(Boolean)) {
    if (/^\d{4}$/.test(p)) anio = parseInt(p, 10);
    else if (/^\d{1,2}$/.test(p)) { const n = parseInt(p,10); if (!mes && n>=1 && n<=12) mes = n; }
    else if (MESES[p] !== undefined) mes = MESES[p];
  }
  return { cedula, anio, mes };
}

// Más reciente: año desc, mes desc, y a igualdad el nombre más corto (el original).
function masReciente(a, b) {
  return (b.anio - a.anio) || (b.mes - a.mes) || (a.name.length - b.name.length);
}

async function main() {
  const auth = new google.auth.JWT({ keyFile: SA_KEY, scopes: ['https://www.googleapis.com/auth/drive'], subject: IMPERSONATE });
  await auth.authorize().catch((e) => fail(`Auth: ${e.message}`));
  const drive = google.drive({ version: 'v3', auth });
  const common = { supportsAllDrives: true, includeItemsFromAllDrives: true };

  async function lsAll(q, fields) {
    const out = [];
    let pageToken;
    do {
      const r = await drive.files.list({ q, fields: `nextPageToken, ${fields}`, pageSize: 1000, pageToken, ...common });
      out.push(...(r.data.files || []));
      pageToken = r.data.nextPageToken;
    } while (pageToken);
    return out;
  }
  async function child(parent, nameLike) {
    const items = await lsAll(`'${parent}' in parents and mimeType='${FOLDER}' and trashed=false`, 'files(id,name)');
    const hit = items.find((f) => f.name.toLowerCase() === nameLike.toLowerCase())
             || items.find((f) => f.name.toLowerCase().includes(nameLike.toLowerCase()));
    if (!hit) fail(`No resolvió "${nameLike}" (hijos: ${items.map(x=>x.name).slice(0,30).join(', ')})`);
    return hit.id;
  }
  async function resolver(segs) {
    let p = ROOT;
    for (const s of segs) p = await child(p, s);
    return p;
  }

  console.log(`\n${APPLY ? '🚚 APLICANDO' : '🔍 DRY-RUN (nada se mueve)'}\n`);

  const origenId = await resolver(['DEMANDAS','FINANDINA','EJECUTIVAS SINGULARES','GARANTIAS']);
  const destId   = await resolver(['DEMANDAS','FINANDINA','GARANTIA MOBILIARIAS','GARANTIAS']);

  // Mapa cédula → carpetas en el árbol de garantía mobiliaria (destino).
  const destFolders = await lsAll(`'${destId}' in parents and mimeType='${FOLDER}' and trashed=false`, 'files(id,name)');
  const destPorCedula = new Map();
  for (const f of destFolders) {
    const info = analizar(f.name);
    if (!info) continue;
    const arr = destPorCedula.get(info.cedula) || [];
    arr.push({ id: f.id, name: f.name, anio: info.anio, mes: info.mes });
    destPorCedula.set(info.cedula, arr);
  }

  // Carpetas del árbol singular (origen).
  const srcFolders = await lsAll(`'${origenId}' in parents and mimeType='${FOLDER}' and trashed=false`, 'files(id,name)');

  const plan = [];      // { cedula, srcName, srcId, destName, destId, mover:[{id,name}], omitir:[name] }
  let sinDest = 0, sinSac = 0;

  for (const src of srcFolders) {
    const info = analizar(src.name);
    if (!info) continue;
    const archivos = await lsAll(`'${src.id}' in parents and trashed=false and mimeType!='${FOLDER}'`, 'files(id,name)');
    const sac = archivos.filter((a) => SAC_FILE.test(a.name));
    if (!sac.length) { continue; }
    const destArr = destPorCedula.get(info.cedula);
    if (!destArr) { sinDest++; continue; }               // caso singular legítimo → no tocar
    const dest = destArr.slice().sort(masReciente)[0];
    // ¿Qué ya existe en el destino? (para no duplicar nombres)
    const yaEnDest = new Set((await lsAll(`'${dest.id}' in parents and trashed=false`, 'files(name)')).map((f) => f.name.toLowerCase()));
    const mover = sac.filter((a) => !yaEnDest.has(a.name.toLowerCase()));
    const omitir = sac.filter((a) => yaEnDest.has(a.name.toLowerCase())).map((a) => a.name);
    if (!mover.length && !omitir.length) continue;
    plan.push({ cedula: info.cedula, srcName: src.name, srcId: src.id, destName: dest.name, destId: dest.id, mover, omitir });
  }

  if (!plan.length) {
    console.log('No hay SAC mal ubicados que mover (ninguna cédula del árbol singular con SAC coincide con el de garantía mobiliaria).');
    console.log(`\nResumen: ${srcFolders.length} carpetas en origen, ${sinDest} con SAC pero sin caso en garantía mobiliaria (se dejan).`);
    return;
  }

  let totalMover = 0, totalOmitir = 0;
  console.log(`Candidatos: ${plan.length} cédula(s)\n`);
  for (const p of plan) {
    console.log(`● Cédula ${p.cedula}`);
    console.log(`    origen : EJECUTIVAS SINGULARES/…/"${p.srcName}"`);
    console.log(`    destino: GARANTIA MOBILIARIAS/…/"${p.destName}"`);
    for (const f of p.mover)  { console.log(`      → mover:  ${f.name}`); totalMover++; }
    for (const n of p.omitir) { console.log(`      ⏭ omitir: ${n} (ya existe en destino)`); totalOmitir++; }
  }
  console.log(`\nResumen: ${totalMover} archivo(s) a mover, ${totalOmitir} ya en destino (omitidos), ${sinDest} carpeta(s) singular sin caso de garantía (intactas).`);

  if (!APPLY) {
    console.log('\n(DRY-RUN) Revisa la lista. Para ejecutar: node mover-sac-pago-directo.js --apply\n');
    return;
  }

  console.log('\n🚚 Moviendo…\n');
  let hechos = 0, fallos = 0;
  for (const p of plan) {
    for (const f of p.mover) {
      try {
        await drive.files.update({ fileId: f.id, addParents: p.destId, removeParents: p.srcId, fields: 'id', supportsAllDrives: true });
        console.log(`  ✅ ${p.cedula}  ${f.name}`);
        hechos++;
      } catch (e) {
        console.log(`  ⚠️  ${p.cedula}  ${f.name}: ${e.message}`);
        fallos++;
      }
    }
  }
  console.log(`\n✅ Listo: ${hechos} movido(s), ${fallos} con error.`);
}

main().catch((e) => fail(e.message));
