/**
 * services/singular/mapeoColumnas.js — Mapeo inteligente de columnas del Excel
 *
 * Los Excel de Finandina cambian de encabezados en cada envío
 * ("NOMBRE_CLIENTE" / "NOMBRE DEUDOR", "NIT" / "SALARIO" / "ID EMPLEADOR",
 * "DESCRP_VS_NO_PRENDADOS" / "DETALLE VHS" / "VHS"…). Este módulo identifica
 * qué columna corresponde a cada campo canónico en dos niveles:
 *
 *   Nivel 1 — Heurística: puntaje por similitud de nombre (tokens/sinónimos)
 *             + validación del CONTENIDO de las filas de muestra. Gratis e
 *             instantáneo; resuelve la gran mayoría de variantes.
 *   Nivel 2 — Ollama (LLM local): solo para los campos que el nivel 1 no
 *             resolvió. La respuesta del modelo se acepta únicamente si el
 *             contenido de la columna propuesta pasa el validador del campo.
 *
 * El mapeo final se cachea por firma de encabezados: un formato ya visto no
 * vuelve a calcular nada. La IA decide QUÉ columna es QUÉ — los valores los
 * extrae siempre el código determinista.
 */

'use strict';

const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');
const http   = require('http');

const config = require('../../config');

// ─── Esquema canónico (Hoja1) ─────────────────────────────────────────────────
// tokens: palabras que suman puntaje si aparecen en el encabezado.
// antiTokens: palabras que descartan el encabezado (evitan falsos positivos).
// validar: recibe los valores de muestra de la columna → true si el contenido
//          es plausible para el campo.

const RE_NUM_DOC = /^\d{6,11}$/;
const RE_FECHA   = /^(?:\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}|\d{4,5}(?:\.\d+)?)$/; // dd/mm/yyyy o serial Excel

function frac(vals, fn) {
  const v = vals.filter(x => String(x ?? '').trim() !== '');
  if (v.length === 0) return 0;
  return v.filter(fn).length / v.length;
}

const limpiarNum = s => String(s ?? '').trim().replace(/[.\s,]/g, '').replace(/-\d$/, '');

const ESQUEMA = {
  IDENTIFICACION: {
    tokens: ['IDENTIFICACION', 'CEDULA', 'DOCUMENTO', 'DOC', 'CC'],
    antiTokens: ['CODEUDOR', 'SUPERVISOR', 'NEGOCIADOR', 'EMPLEADOR', 'NIT'],
    validar: vals => frac(vals, v => RE_NUM_DOC.test(String(v).trim())) >= 0.6,
  },
  NOMBRE: {
    tokens: ['NOMBRE', 'CLIENTE', 'DEUDOR'],
    antiTokens: ['EMPRESA', 'EMP', 'CODEUDOR', 'COMERCIAL', 'PROFESION', 'APELLIDO_SOLO'],
    validar: vals => frac(vals, v => /^[A-ZÁÉÍÓÚÑÜ ]{6,60}$/i.test(String(v).trim()) && String(v).trim().split(/\s+/).length >= 2) >= 0.5,
  },
  APLICATIVO: {
    tokens: ['APLICATIVO'],
    antiTokens: [],
    validar: vals => frac(vals, v => /^[A-Z]{2,12}$/i.test(String(v).trim())) >= 0.5,
  },
  DIRECCION: {
    tokens: ['DIRECCION', 'DIR', 'RESIDENCIA'],
    antiTokens: ['ELECTRONICA', 'CORREO', 'EMAIL', 'TRANSITO'],
    validar: vals => frac(vals, v => /\b(?:CL|CLL|CALLE|CR|CRA|KR|CARRERA|MZ|MANZANA|AV|AVENIDA|DG|DIAGONAL|TV|KM)\b/i.test(String(v)) || /\d+\s*[-#]\s*\d+/.test(String(v))) >= 0.3,
  },
  CORREO: {
    tokens: ['CORREO', 'EMAIL', 'MAIL'],
    antiTokens: ['JUZGADO', 'COORPORATIVO', 'CORPORATIVO'],
    validar: vals => frac(vals, v => /@/.test(String(v))) >= 0.3,
  },
  CIUDAD: {
    tokens: ['CIUDAD', 'MUNICIPIO', 'MPIO'],
    antiTokens: ['CAPTURA', 'JUZGADO'],
    validar: vals => frac(vals, v => /^[A-ZÁÉÍÓÚÑÜ .]+(?:\([^)]*\))?$/i.test(String(v).trim())) >= 0.5,
  },
  DEPARTAMENTO: {
    tokens: ['DEPARTAMENTO', 'DEPTO', 'DPTO'],
    antiTokens: [],
    validar: vals => frac(vals, v => /^[A-ZÁÉÍÓÚÑÜ .]{3,30}$/i.test(String(v).trim())) >= 0.5,
  },
  NIT_EMPLEADOR: {
    // OJO: 'ID' NO va aquí. Estaba pensado para "ID EMPLEADOR", pero hacía que
    // una columna llamada solo "ID" —que en los Excel crudos del banco es la
    // CÉDULA DEL DEUDOR— se mapeara como NIT del patrono (y de paso se la
    // quitaba a IDENTIFICACION). "ID EMPLEADOR" sigue puntuando por 'EMPLEADOR'.
    tokens: ['NIT', 'EMPLEADOR', 'SALARIO', 'PATRONO'],
    antiTokens: ['NOMBRE'],
    validar: vals => frac(vals, v => RE_NUM_DOC.test(limpiarNum(v))) >= 0.2,
  },
  NOMBRE_EMPRESA: {
    tokens: ['EMPRESA', 'EMP', 'EMPLEADOR', 'PATRONO'],
    antiTokens: ['NIT', 'ID', 'DIRECCION', 'ELECTRONICA', 'MAREIWA'],
    validar: vals => frac(vals, v => /[A-ZÁÉÍÓÚÑÜ]{3,}/i.test(String(v)) && !RE_NUM_DOC.test(limpiarNum(v))) >= 0.2,
  },
  DETALLE_VEHICULOS: {
    tokens: ['DESCRP', 'DESCRIPCION', 'DETALLE', 'VHS', 'VS', 'VEHICULOS', 'PRENDADOS'],
    antiTokens: ['CANT', 'CANTIDAD', 'ESTADO'],
    validar: vals => frac(vals, v => /(?:MOTOCICLETA|AUTOMOVIL|CAMIONETA|CAMPERO|MICROBUS|BUS|MODELO|PLACA|MATRICULAD)/i.test(String(v))) >= 0.2,
  },
  CANT_VEHICULOS: {
    tokens: ['CANT', 'CANTIDAD', 'VHS', 'VEHICULOS', 'VEHIC'],
    antiTokens: ['DETALLE', 'DESCRP', 'DESCRIPCION'],
    validar: vals => frac(vals, v => /^\d{1,2}$/.test(String(v).trim())) >= 0.4,
  },
  PLACA: {
    tokens: ['PLACA', 'PLACAS'],
    antiTokens: ['OBLIGACION', 'STRIA'],
    validar: vals => frac(vals, v => /^[A-Z]{3}\s?\d{2}[A-Z0-9]$/i.test(String(v).trim())) >= 0.3,
  },
  INMUEBLE: {
    tokens: ['INM', 'INMUEBLE', 'INMUEBLES'],
    antiTokens: ['VHS', 'VEHIC', 'PLACA'],
    // El contenido es matrícula/descripción cuando hay inmueble, o "----" cuando
    // no; no se valida por contenido, se confía en el nombre de la columna.
    validar: () => true,
  },
  OBLIGACION: {
    tokens: ['OBLIGACION'],
    antiTokens: ['PLACA', 'CANTIDAD', 'PESO', 'CLASIFICACION'],
    validar: vals => frac(vals, v => /^\d{6,15}$/.test(String(v).trim())) >= 0.5,
  },
  FECHA_MORA: {
    tokens: ['FECHA', 'INI', 'MORA', 'ACT'],
    antiTokens: ['CUOTA', 'GESTION', 'PROMESA', 'NACIMIENTO', 'DESEMBOLSO', 'TERMINACION', 'SOAT'],
    validar: vals => frac(vals, v => RE_FECHA.test(String(v).trim())) >= 0.4,
  },
  FECHA_DESEMBOLSO: {
    tokens: ['FECHA', 'DESEMBOLSO'],
    antiTokens: ['ANIO', 'AÑO', 'MES', 'MORA'],
    validar: vals => frac(vals, v => RE_FECHA.test(String(v).trim())) >= 0.4,
  },
};

// Campos que justifican llamar al LLM si la heurística no los resolvió
const CAMPOS_CRITICOS = [
  'IDENTIFICACION', 'NOMBRE', 'APLICATIVO', 'DIRECCION', 'CIUDAD',
  'NIT_EMPLEADOR', 'NOMBRE_EMPRESA', 'DETALLE_VEHICULOS',
];

// ─── Nivel 1: heurística nombre + contenido ───────────────────────────────────

function normalizar(h) {
  return String(h || '').toUpperCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

function nameScore(headerNorm, tokens, antiTokens) {
  if (!headerNorm) return 0;
  const palabras = headerNorm.split(' ');
  for (const anti of antiTokens) {
    if (palabras.includes(anti)) return -1;
    // Encabezados PEGADOS sin separador ("CEDULANEGOCIADOR", "CEDULASUPERVISOR")
    // quedan como UNA sola palabra, así que la comparación exacta no los veía:
    // el token "CEDULA" puntuaba por prefijo, el contenido validaba (son cédulas)
    // y IDENTIFICACION terminaba apuntando a la cédula del NEGOCIADOR en vez de
    // la del deudor. Para anti-tokens largos se busca también como subcadena;
    // los cortos ('ID', 'CC', 'EMP', 'DOC') se dejan en exacto para no barrer
    // encabezados legítimos ("CIUDAD" contiene "ID").
    if (anti.length >= 5 && palabras.some(p => p.includes(anti))) return -1;
  }
  let hits = 0;
  for (const t of tokens) {
    if (palabras.includes(t)) hits += 1;
    else if (palabras.some(p => p.startsWith(t) || t.startsWith(p) && p.length >= 3)) hits += 0.5;
  }
  return hits / tokens.length;
}

// columnas: [{ idx, header, headerNorm, muestra: [] }]
function mapearHeuristica(columnas) {
  const mapeo = {};       // CAMPO → idx
  const usadas = new Set();

  // Candidatos puntuados por campo
  const candidatos = [];
  for (const [campo, spec] of Object.entries(ESQUEMA)) {
    for (const col of columnas) {
      const ns = nameScore(col.headerNorm, spec.tokens, spec.antiTokens);
      if (ns <= 0) continue;
      const cs = spec.validar(col.muestra) ? 1 : 0;
      // El contenido pesa: un nombre parecido con contenido inválido no sirve
      const score = ns * 0.5 + cs * 0.5;
      if (score >= 0.5 && cs === 1) candidatos.push({ campo, idx: col.idx, score });
    }
  }

  // Asignación greedy: mejor puntaje primero, sin repetir columna ni campo
  candidatos.sort((a, b) => b.score - a.score);
  for (const c of candidatos) {
    if (mapeo[c.campo] !== undefined || usadas.has(c.idx)) continue;
    mapeo[c.campo] = c.idx;
    usadas.add(c.idx);
  }

  // Último recurso para la cédula: una columna llamada exactamente "ID" (los
  // Excel crudos del banco la usan en vez de "IDENTIFICACION"/"CEDULA"). No se
  // pone 'ID' entre los tokens porque es demasiado genérico y empataría con la
  // columna buena cuando ambas existen; aquí solo entra si NADA la resolvió y el
  // contenido pasa el validador de documento (un consecutivo 1,2,3… no pasa).
  if (mapeo.IDENTIFICACION === undefined) {
    const col = columnas.find(c => c.headerNorm === 'ID' && !usadas.has(c.idx)
                                && ESQUEMA.IDENTIFICACION.validar(c.muestra));
    if (col) {
      mapeo.IDENTIFICACION = col.idx;
      usadas.add(col.idx);
    }
  }

  // Regla por estructura: el NIT del empleador suele ser la columna numérica
  // inmediatamente a la IZQUIERDA del nombre de la empresa.
  if (mapeo.NIT_EMPLEADOR === undefined && mapeo.NOMBRE_EMPRESA !== undefined) {
    const izq = columnas.find(c => c.idx === mapeo.NOMBRE_EMPRESA - 1);
    if (izq && !usadas.has(izq.idx) && ESQUEMA.NIT_EMPLEADOR.validar(izq.muestra)) {
      mapeo.NIT_EMPLEADOR = izq.idx;
      usadas.add(izq.idx);
    }
  }

  return mapeo;
}

// ─── Nivel 2: Ollama (LLM local) ─────────────────────────────────────────────

function ollamaChat(payload, baseUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL('/api/chat', baseUrl);
    const body = JSON.stringify(payload);
    const req = http.request({
      hostname: u.hostname, port: u.port || 11434, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: timeoutMs,
    }, res => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('respuesta no JSON: ' + data.substring(0, 120))); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error(`timeout ${timeoutMs}ms`)); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function ollamaDisponible(baseUrl) {
  return new Promise(resolve => {
    const u = new URL('/api/tags', baseUrl);
    const req = http.get({ hostname: u.hostname, port: u.port || 11434, path: u.pathname, timeout: 2000 }, res => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        try {
          const tags = JSON.parse(data);
          resolve((tags.models || []).map(m => m.name));
        } catch (_) { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

async function mapearConOllama(columnas, faltantes) {
  const baseUrl = config.OLLAMA_URL;
  const modelos = await ollamaDisponible(baseUrl);
  if (!modelos) {
    console.error('[MAPEO] Ollama no disponible — se continúa solo con heurística');
    return {};
  }
  const modelo = modelos.includes(config.OLLAMA_MODEL) ? config.OLLAMA_MODEL : modelos[0];
  if (!modelo) {
    console.error('[MAPEO] Ollama sin modelos instalados — se continúa solo con heurística');
    return {};
  }

  const descripciones = {
    IDENTIFICACION:    'cédula de ciudadanía del deudor — también "documento", "DOC", "CC", "No. identificación" (número de 6-11 dígitos)',
    NOMBRE:            'nombre completo del deudor/cliente (persona natural, nombre y apellidos)',
    APLICATIVO:        'aplicativo u origen del crédito (valores cortos como DECEVAL, LP, TPD)',
    DIRECCION:         'dirección física de residencia del deudor — también "resid", "ubicación" (ej: CL 45 22 18)',
    CORREO:            'correo electrónico del deudor',
    CIUDAD:            'ciudad o municipio de residencia del deudor',
    DEPARTAMENTO:      'departamento de residencia (Atlántico, Córdoba…)',
    NIT_EMPLEADOR:     'NIT (número tributario) de la empresa/patrono/empleador donde trabaja el deudor',
    NOMBRE_EMPRESA:    'nombre o razón social de la empresa donde trabaja el deudor — también "patrono", "empleador", "labora en" (ej: ACME S.A.S)',
    DETALLE_VEHICULOS: 'descripción completa de vehículos del deudor (texto largo con clase, marca, modelo, placa)',
    CANT_VEHICULOS:    'cantidad de vehículos (número pequeño)',
    PLACA:             'placa del vehículo (formato ABC123 o ABC12D)',
    OBLIGACION:        'número de la obligación/crédito (10+ dígitos)',
    FECHA_MORA:        'fecha de inicio de mora actual',
    FECHA_DESEMBOLSO:  'fecha de desembolso o giro del crédito',
  };

  const colsTxt = columnas.map(c => {
    const muestra = c.muestra.filter(v => String(v ?? '').trim() !== '').slice(0, 2)
      .map(v => JSON.stringify(String(v).substring(0, 45))).join(', ');
    return `${c.idx}: "${c.header}" → [${muestra || 'vacío'}]`;
  }).join('\n');

  const camposTxt = faltantes.map(f => `- ${f}: ${descripciones[f] || f}`).join('\n');

  const prompt = `Eres un mapeador de columnas de Excel bancarios colombianos.
Columnas disponibles (índice: "encabezado" → [valores de muestra]):
${colsTxt}

Identifica el índice de columna para cada campo (null si ninguna columna corresponde):
${camposTxt}

Responde SOLO un objeto JSON: {"CAMPO": indice_o_null, ...}`;

  try {
    console.error(`[MAPEO] Consultando Ollama (${modelo}) por ${faltantes.length} campo(s): ${faltantes.join(', ')}`);
    const res = await ollamaChat({
      model: modelo,
      messages: [{ role: 'user', content: prompt }],
      format: 'json',
      stream: false,
      options: { temperature: 0 },
    }, baseUrl, config.OLLAMA_TIMEOUT);

    // Ollama devuelve { error: "..." } con HTTP 500 (p.ej. RAM insuficiente)
    if (res?.error) throw new Error(res.error);

    const out = JSON.parse(res?.message?.content || '{}');
    const valido = {};
    for (const campo of faltantes) {
      const idx = out[campo];
      if (idx === null || idx === undefined || isNaN(Number(idx))) continue;
      const col = columnas.find(c => c.idx === Number(idx));
      // Solo aceptar si el CONTENIDO de la columna propuesta pasa el validador
      if (col && ESQUEMA[campo] && ESQUEMA[campo].validar(col.muestra)) {
        valido[campo] = Number(idx);
        console.error(`[MAPEO]   Ollama: ${campo} → col ${idx} ("${col.header}") ✓`);
      } else if (col) {
        console.error(`[MAPEO]   Ollama: ${campo} → col ${idx} ("${col.header}") descartado (contenido no valida)`);
      }
    }
    return valido;
  } catch (e) {
    console.error(`[MAPEO] Ollama falló: ${e.message} — se continúa solo con heurística`);
    return {};
  }
}

// ─── Cache por firma de encabezados ───────────────────────────────────────────

let _cache = null;

function cacheFile() {
  return path.join(config.OUT_DIR, 'mapeo_columnas_cache.json');
}

function loadCache() {
  if (_cache) return _cache;
  _cache = {};
  try {
    if (fs.existsSync(cacheFile())) _cache = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
  } catch (_) {}
  return _cache;
}

function saveCache() {
  try { fs.writeFileSync(cacheFile(), JSON.stringify(_cache, null, 2), 'utf8'); } catch (_) {}
}

function firmaHeaders(headers) {
  return crypto.createHash('sha1').update(headers.map(normalizar).join('|')).digest('hex');
}

// ─── API principal ────────────────────────────────────────────────────────────

/**
 * Mapea los encabezados de Hoja1 al esquema canónico.
 * headers: fila 0 del sheet; filas: filas de datos para muestreo.
 * Devuelve { CAMPO: colIdx } (solo campos resueltos).
 */
// Un mapeo incompleto (Ollama caído o campos sin resolver) se reusa durante
// 24h antes de reintentar — evita pagar el timeout del LLM en cada corrida.
const RETRY_TTL = 24 * 60 * 60 * 1000;

async function mapearColumnas(headers, filas) {
  const firma = firmaHeaders(headers);
  const cache = loadCache();
  const hit   = cache[firma];
  if (hit && (hit.completo !== false || Date.now() - (hit.ts || 0) < RETRY_TTL)) {
    return hit.mapeo;
  }

  const muestras = filas.slice(0, 8);
  const columnas = headers.map((h, idx) => ({
    idx,
    header: String(h ?? ''),
    headerNorm: normalizar(h),
    muestra: muestras.map(f => f[idx]),
  })).filter(c => c.headerNorm || c.muestra.some(v => String(v ?? '').trim() !== ''));

  // Nivel 1: heurística
  const mapeo = mapearHeuristica(columnas);

  // Nivel 2: Ollama para los campos críticos que falten
  let faltantes = CAMPOS_CRITICOS.filter(c => mapeo[c] === undefined);
  if (faltantes.length > 0) {
    const extra = await mapearConOllama(columnas, faltantes);
    Object.assign(mapeo, extra);
    faltantes = CAMPOS_CRITICOS.filter(c => mapeo[c] === undefined);
  }

  const resumen = Object.entries(mapeo).map(([c, i]) => `${c}→"${headers[i]}"`).join(', ');
  console.error(`[MAPEO] ${Object.keys(mapeo).length} campo(s) mapeados: ${resumen}`);
  if (faltantes.length > 0) console.error(`[MAPEO] Sin resolver: ${faltantes.join(', ')}`);

  cache[firma] = {
    mapeo,
    completo: faltantes.length === 0,
    headers: headers.filter(Boolean).slice(0, 50),
    ts: Date.now(),
  };
  saveCache();
  return mapeo;
}

module.exports = { mapearColumnas };
