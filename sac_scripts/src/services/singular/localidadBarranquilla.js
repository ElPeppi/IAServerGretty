/**
 * services/singular/localidadBarranquilla.js — Localidad de Barranquilla por barrio
 *
 * En Barranquilla, cuando el juzgado es de Pequeñas Causas, la ciudad del
 * juzgado debe indicar la localidad: "BARRANQUILLA - {LOCALIDAD}".
 * Barranquilla tiene 5 localidades (división oficial):
 *   NORTE-CENTRO HISTORICO, RIOMAR, METROPOLITANA, SUROCCIDENTE, SURORIENTE.
 *
 * La localidad se determina por el BARRIO de la dirección del demandado, usando
 * la tabla oficial barrio→localidad de abajo (semilla). Se puede sobreescribir/
 * ampliar con {SAC_OUT_DIR}/barranquilla_localidades.json. Si el barrio no se
 * reconoce, se devuelve '' y se avisa en el log para completarlo a mano.
 */

'use strict';

const path  = require('path');
const fs    = require('fs');
const https = require('https');

const config = require('../../config');

function norm(s) {
  return String(s || '').toUpperCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Listas oficiales de barrios por localidad ───────────────────────────────
const BARRIOS = {
  'NORTE-CENTRO HISTORICO': [
    'Abajo', 'Alameda del Rio', 'Altos del Prado', 'America', 'Barlovento', 'Bellavista',
    'Bethania', 'Boston', 'Campo Alegre', 'Centro', 'Ciudad Jardin', 'Colombia',
    'El Castillo', 'El Golf', 'El Porvenir', 'El Prado', 'El Recreo', 'El Rosario',
    'El Tabor', 'Granadillo', 'La Campiña', 'La Concepcion', 'La Cumbre', 'La Loma',
    'Las Delicias', 'Las Mercedes', 'Las Nubes', 'Los Alpes', 'Los Jobos', 'Los Nogales',
    'Miramar', 'Modelo', 'Montecristo', 'Nuevo Horizonte', 'Paraiso', 'San Francisco',
    'Santa Ana', 'Villa Country', 'Villanueva', 'Zona Franca', 'Zona Industrial',
  ],
  'RIOMAR': [
    'Altamira', 'Altos de Riomar', 'Altos del Limon', 'Andalucia',
    'Corregimiento Eduardo Santos La Playa', 'Eduardo Santos', 'La Playa', 'El Limoncito',
    'El Poblado', 'La Floresta', 'Las Flores', 'Las Tres Ave Maria', 'Riomar',
    'San Salvador', 'San Vicente', 'Santa Monica', 'Siape', 'Solaire Norte', 'Solaire',
    'Villa Campestre', 'Villa Carolina', 'Villa del Este', 'Villa Santos',
  ],
  'METROPOLITANA': [
    'Buenos Aires', 'Carrizal', 'Cevillar', 'Ciudadela 20 de Julio', 'El Santuario',
    'Kennedy', 'La Sierra', 'La Sierrita', 'Las Americas', 'Las Cayenas', 'Las Gardenias',
    'Las Granjas', 'Los Continentes', 'Los Girasoles', 'San Luis', 'Santa Maria',
    'Santo Domingo de Guzman', 'Sevilla Real', 'Siete de Abril', 'Sinai', 'Veinte de Julio',
    'Villa San Carlos', 'Villa San Pedro', 'Villa Sevilla', 'Villa Valery',
  ],
  'SUROCCIDENTE': [
    'Alfonso Lopez', 'Bernardo Hoyos', 'Buena Esperanza', 'California', 'Caribe Verde',
    'Carlos Meisel', 'Ciudad Modesto', 'Ciudadela de la Salud', 'Ciudadela de Paz',
    'Colina Campestre', 'Cordialidad', 'Corregimiento de Juan Mina', 'Cuchilla de Villate',
    'El Bosque', 'El Carmen', 'El Eden', 'El Pueblo', 'El Romance', 'El Rubi', 'El Silencio',
    'El Valle', 'Las Estrellas', 'Las Malvinas', 'Las Terrazas', 'Lipaya', 'Loma Fresca',
    'Los Andes', 'Los Angeles I', 'Los Angeles II', 'Los Angeles III', 'Los Angeles',
    'Los Olivos I', 'Los Olivos II', 'Los Olivos', 'Los Pinos', 'Los Rosales', 'Lucero',
    'Me Quejo', 'Mercedes Sur', 'Nueva Colombia', 'Nueva Granada', 'Olaya', 'Pinar del Rio',
    'Por Fin', 'Evaristo Sourdis', 'Gerlein y Villate', 'Kalamary', 'La Ceiba',
    'La Esmeralda', 'La Florida', 'La Gloria', 'La Libertad', 'La Manga', 'La Paz',
    'La Pradera', 'Las Colinas', 'Pumarejo', 'San Felipe', 'San Isidro',
    'San Pedro Alejandrino', 'San Pedro Sector', 'Santo Domingo', 'Siete de Agosto',
    'Villa del Rosario', 'Villa Flor', 'Villas de la Cordialidad', 'Villas de San Pablo',
  ],
  'SURORIENTE': [
    'Atlantico', 'Bellarena', 'Boyaca', 'Chiquinquira', 'El Campito', 'El Limon',
    'El Milagro', 'El Parque Sector Barranquilla', 'Jose Antonio Galan', 'La Arboraya',
    'La Chinita', 'La Luz', 'La Magdalena', 'La Union', 'La Victoria', 'Las Dunas',
    'Las Nieves', 'Las Palmas', 'Las Palmeras', 'Los Laureles', 'Los Trupillos', 'Moderno',
    'Montes', 'Pasadena', 'Primero de Mayo El Ferry', 'Primero de Mayo', 'El Ferry',
    'Rebolo', 'San Jose', 'San Nicolas', 'San Roque', 'Santa Helena', 'Simon Bolivar',
    'Tayrona', 'Universal I', 'Universal II', 'Universal', 'Villa Blanca', 'Villa del Carmen',
  ],
};

// ─── Tabla barrio(normalizado) → localidad ───────────────────────────────────
let _tabla = null;

function buildSeed() {
  const t = {};
  for (const [loc, barrios] of Object.entries(BARRIOS)) {
    for (const b of barrios) t[norm(b)] = loc;
  }
  return t;
}

function loadTabla() {
  if (_tabla) return _tabla;
  _tabla = buildSeed();
  // Override/ampliación opcional desde JSON del despacho
  const p = process.env.LOCALIDADES_BQ_CONFIG || path.join(config.OUT_DIR, 'barranquilla_localidades.json');
  try {
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      for (const [k, v] of Object.entries(raw)) {
        if (k.startsWith('_')) continue;
        _tabla[norm(k)] = norm(v);
      }
    } else {
      const seed = { _instrucciones: 'Override barrio→localidad de Barranquilla. Clave: BARRIO; valor: NORTE-CENTRO HISTORICO | RIOMAR | METROPOLITANA | SUROCCIDENTE | SURORIENTE.' };
      Object.assign(seed, buildSeed());
      try { fs.writeFileSync(p, JSON.stringify(seed, null, 2), 'utf8'); } catch (_) {}
    }
  } catch (e) {
    console.error(`[LOCALIDAD-BQ] Error leyendo override: ${e.message}`);
  }
  return _tabla;
}

// Extrae el barrio de una dirección ("... BR/BARRIO/RES/URB/CONJ X")
function extraerBarrio(direccion) {
  const m = String(direccion || '')
    .match(/\b(?:BR|BRR|BARRIO|RES|RESERVA|URB|URBANIZACION|CONJ|CONJUNTO|SECTOR|CIUDADELA)\b\.?\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

// Localidad por la tabla de barrios (sin red). '' si no se ubica.
function determinarPorTabla(direccion) {
  const tabla = loadTabla();
  const dirNorm = norm(direccion);
  const barrio = extraerBarrio(direccion);

  // 1) Barrio explícito tras "BR/BARRIO/..."
  if (barrio) {
    const bN = norm(barrio);
    if (tabla[bN]) return tabla[bN];
    // coincidencia por prefijo (p.ej. "LOS ANGELES" ↔ "LOS ANGELES II")
    const pref = Object.keys(tabla).find(k => k.startsWith(bN + ' ') || bN.startsWith(k + ' '));
    if (pref) return tabla[pref];
  }

  // 2) Buscar el barrio MÁS LARGO de la tabla que aparezca en la dirección
  let mejor = '';
  for (const b of Object.keys(tabla)) {
    if (b.length < 5) continue; // evitar nombres muy cortos/ambiguos
    const re = new RegExp('(^|[^A-Z0-9])' + b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^A-Z0-9]|$)');
    if (re.test(dirNorm) && b.length > mejor.length) mejor = b;
  }
  if (mejor) return tabla[mejor];
  return '';
}

// ─── Fallback: geocodificación Waze ──────────────────────────────────────────
// Para direcciones que solo traen nomenclatura (sin barrio), Waze ubica la
// dirección y devuelve la localidad. Best-effort; si falla, '' (queda manual).

function httpGet(url) {
  return new Promise((res) => {
    const req = https.get(url, {
      timeout: 12000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        'Referer': 'https://www.waze.com/es/live-map/',
      },
    }, r => { let d = ''; r.on('data', x => d += x); r.on('end', () => res(d)); });
    req.on('error', () => res(''));
    req.on('timeout', () => { req.destroy(); res(''); });
  });
}

// Mapea el texto de localidad/barrio de Waze a una de las 5 localidades.
function mapearTextoLocalidad(texto) {
  const n = norm(texto);
  if (!n) return '';
  if (/ORIENT/.test(n))                 return 'SURORIENTE';
  if (/OCCIDENT/.test(n))               return 'SUROCCIDENTE';
  if (/METROPOLIT/.test(n))             return 'METROPOLITANA';
  if (/RIOMAR/.test(n))                 return 'RIOMAR';
  if (/NORTE|CENTRO HISTOR/.test(n))    return 'NORTE-CENTRO HISTORICO';
  // Si Waze devolvió un barrio en vez de la localidad, buscarlo en la tabla
  const tabla = loadTabla();
  if (tabla[n]) return tabla[n];
  const pref = Object.keys(tabla).find(k => k === n || k.startsWith(n + ' ') || n.startsWith(k + ' '));
  return pref ? tabla[pref] : '';
}

async function geocodeWaze(direccion) {
  const q = encodeURIComponent(`${String(direccion || '').trim()}, Barranquilla, Atlantico`);
  // Coordenadas del centro de Barranquilla para acotar la búsqueda
  const url = `https://www.waze.com/row-SearchServer/mozi?q=${q}&lang=es&origin=livemap&lon=-74.8070&lat=10.9685&v=7773`;
  const body = await httpGet(url);
  if (!body) return '';
  let arr;
  try { arr = JSON.parse(body); } catch (_) { return ''; }
  const hit = (arr || []).find(x => /BARRANQUILLA/i.test(x.name || '') && /BARRANQUILLA/i.test(x.city || ''));
  if (!hit) return ''; // sin match en Barranquilla (p.ej. cayó en Soledad)

  // name: "Cl 28 # 22-18, Sur Orient, Barranquilla, Atlántico" → tomar el
  // componente anterior a "Barranquilla".
  const partes = hit.name.split(',').map(s => s.trim());
  const iBq = partes.findIndex(p => /^BARRANQUILLA/i.test(norm(p)));
  const cand = iBq > 0 ? partes[iBq - 1] : '';
  const loc = mapearTextoLocalidad(cand);
  if (loc) console.error(`[LOCALIDAD-BQ] Waze ubicó "${direccion}" → ${cand} → ${loc}`);
  return loc;
}

/**
 * Determina la localidad de Barranquilla del demandado según su dirección.
 * 1) Tabla de barrios (instantánea, autoritativa).
 * 2) Fallback Waze para nomenclaturas sin barrio.
 * Devuelve el nombre de la localidad (p.ej. 'SURORIENTE') o '' si no se ubica.
 */
async function determinarLocalidad(direccion) {
  const porTabla = determinarPorTabla(direccion);
  if (porTabla) return porTabla;

  const porWaze = await geocodeWaze(direccion);
  if (porWaze) return porWaze;

  console.error(`[LOCALIDAD-BQ] No se ubicó la localidad de "${direccion}" — completar a mano`);
  return '';
}

module.exports = { determinarLocalidad, determinarPorTabla, extraerBarrio };
