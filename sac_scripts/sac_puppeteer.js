/**
 * sac_puppeteer.js
 * Una sola sesión SAC para procesar N clientes (un login, N búsquedas).
 * Genera PDFs de obligaciones VIGENTES y extrae contactos (Dir y Tel + Datacredito).
 *
 * Uso:
 *   node sac_puppeteer.js <clientesJSON> <sacBaseUrl> <usuario> <password>
 *
 * clientesJSON: JSON array → [{ cedula: "...", outputDir: "..." }, ...]
 * Salida stdout: JSON → { success, clientes: [{ cedula, success, pdfs, contactoFile, error? }] }
 */

const puppeteer = require('puppeteer');
const pdfParse  = require('pdf-parse');
const path      = require('path');
const fs        = require('fs');

const [,, clientesJson, sacBaseUrl, sacUser, sacPass] = process.argv;

const LOGIN_URL   = `${sacBaseUrl}/login`;
const GESTION_URL = `${sacBaseUrl}/management/general/home/accout?navId=5`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const waitMs = ms => new Promise(r => setTimeout(r, ms));

async function waitForAngular(page, extraMs = 500) {
  await page.waitForFunction(
    () => !document.querySelector('.loading, .spinner, mat-progress-bar, mat-progress-spinner'),
    { timeout: 15000 }
  ).catch(() => {});
  if (extraMs > 0) await waitMs(extraMs);
}

// ─── Seleccionar cliente: lupa → modal → buscar cédula → seleccionar fila ────

async function seleccionarCliente(page, cedula) {
  await page.waitForSelector('button[data-target="#searchModal"]', { visible: true, timeout: 15000 });
  await page.click('button[data-target="#searchModal"]');
  await waitForAngular(page, 600);

  await page.waitForSelector('#searchModal input, .modal.show input', { visible: true, timeout: 8000 });
  const campoBusqueda = await page.$('#searchModal input') || await page.$('.modal.show input');
  if (!campoBusqueda) throw new Error(`Modal de búsqueda no encontrado (cédula ${cedula})`);
  await campoBusqueda.click({ clickCount: 3 });
  await campoBusqueda.type(cedula, { delay: 25 });

  const buscarBtn = await page.$('#searchModal button.btn-primary')
    || await page.$('.modal.show button.btn-primary');
  if (!buscarBtn) throw new Error('Botón BUSCAR no encontrado');
  await buscarBtn.click();
  await waitForAngular(page, 1200);

  const primerResultado = await page.$('#searchModal table tbody tr')
    || await page.$('.modal.show table tbody tr');
  if (!primerResultado) throw new Error(`Sin resultados para cédula ${cedula}`);
  await primerResultado.click();
  await waitForAngular(page, 1200);
}

// ─── Extraer Dir y Tel del SAC ────────────────────────────────────────────────
// Hace clic en el botón "Dir Y Tel" (ícono de teléfono fa-phone-square) y lee
// la tabla "Lista De Direcciones": col 0 = valor, col 1 = TIPO DIRECCIÓN.
// Tipo EMAIL  → lista de emails
// Otros tipos → lista de direcciones físicas { valor, ultimoUso }
// La fecha de último uso se busca en la columna cuyo encabezado contenga "USO".
//
// IMPORTANTE: el id "btn-link-home" puede estar repetido en varios ítems del
// menú lateral del SAC, así que NO basta seleccionarlo a ciegas — hay que dar
// con el <a> que contiene el ícono de teléfono. Tras cada clic se verifica que
// la tabla de direcciones realmente apareció; si no, se prueba el siguiente
// candidato.

// ¿Está la tabla de direcciones en el DOM?
async function tablaDireccionesVisible(page) {
  return page.evaluate(() => [...document.querySelectorAll('table')].some(t => {
    const hs = [...t.querySelectorAll('thead th, thead td')]
      .map(h => h.textContent.trim().toUpperCase());
    return hs.some(h => h.includes('DIRECCI'));
  }));
}

// Hace clic en el botón "Dir y Tel" probando candidatos en orden de
// especificidad. Devuelve true si la tabla de direcciones apareció.
async function abrirVistaDirYTel(page, cedula) {
  // ¿Ya está visible? (p. ej. una corrida previa dejó la vista abierta)
  if (await tablaDireccionesVisible(page)) return true;

  const candidatos = [
    // El botón REAL: <a> con el ícono de teléfono (fa-phone-square)
    'a:has(i.fa-phone-square)',
    'xpath///a[.//i[contains(@class,"fa-phone-square")]]',
    // <p>Dir y Tel</p> dentro del <a>
    'xpath///a[.//p[normalize-space(text())="Dir y Tel"]]',
    // Atributos del tooltip Angular
    '[ng-reflect-message="Dir Y Tel"]',
    '[title="Dir Y Tel"]',
    // Último recurso: el id (puede estar repetido en otros ítems del menú)
    '#btn-link-home',
  ];

  for (const sel of candidatos) {
    let btn = null;
    try { btn = await page.$(sel); } catch (_) { /* selector no soportado */ }
    if (!btn) continue;

    try {
      await btn.click();
    } catch (e) {
      console.error(`[DIR-SAC] ${cedula}: clic falló en ${sel}: ${e.message}`);
      continue;
    }
    await waitForAngular(page, 2000);

    // Esperar hasta 8s a que Angular pinte la tabla de direcciones
    try {
      await page.waitForFunction(
        () => [...document.querySelectorAll('table')].some(t => {
          const hs = [...t.querySelectorAll('thead th, thead td')]
            .map(h => h.textContent.trim().toUpperCase());
          return hs.some(h => h.includes('DIRECCI'));
        }),
        { timeout: 8000 }
      );
      console.error(`[DIR-SAC] ${cedula}: vista Dir y Tel abierta (selector: ${sel})`);
      return true;
    } catch (_) {
      console.error(`[DIR-SAC] ${cedula}: ${sel} no mostró la tabla de direcciones — probando siguiente`);
    }
  }
  return false;
}

async function extraerDirYTelSAC(page, cedula) {
  try {
    const abierta = await abrirVistaDirYTel(page, cedula);
    if (!abierta) {
      console.error(`[WARN] No se pudo abrir la vista Dir y Tel para ${cedula}`);
      return { sac_dir: [], sac_email: [] };
    }

    const datos = await page.evaluate(() => {
      const result = { sac_dir: [], sac_email: [] };
      const tables = [...document.querySelectorAll('table')];

      for (const table of tables) {
        // La tabla de direcciones tiene "DIRECCIÓN" como primer encabezado
        const headers = [...table.querySelectorAll('thead th, thead td')]
                        .map(c => c.textContent.trim().toUpperCase());
        if (!headers[0] || !headers[0].includes('DIRECCI')) continue;

        // Columna de fecha de último uso ("FECHA ÚLTIMO USO", "ULTIMO USO"…)
        let usoIdx = headers.findIndex(h => h.includes('USO'));
        if (usoIdx < 0) usoIdx = headers.findIndex(h => h.includes('ULTIM'));

        const rows = [...table.querySelectorAll('tbody tr')];
        for (const row of rows) {
          const cells = [...row.querySelectorAll('td')].map(td => td.textContent.trim());
          const valor = (cells[0] || '').trim();
          const tipo  = (cells[1] || '').trim().toUpperCase();
          if (!valor || valor.length < 3) continue;

          if (tipo === 'EMAIL') {
            result.sac_email.push(valor);
          } else {
            result.sac_dir.push({
              valor,
              ultimoUso: usoIdx >= 0 ? (cells[usoIdx] || '').trim() : '',
            });
          }
        }
        break; // Solo necesitamos la tabla de direcciones
      }
      return result;
    });

    console.error(`[DIR-SAC] ${cedula}: ${datos.sac_dir.length} dir, ${datos.sac_email.length} emails`);
    return datos;

  } catch (e) {
    console.error(`[WARN] extraerDirYTelSAC ${cedula}: ${e.message}`);
    return { sac_dir: [], sac_email: [] };
  }
}

// ─── Generar PDF de la vista "Dir y Tel" (teléfonos + direcciones) ────────────
// Se llama DESPUÉS de extraerDirYTelSAC, cuando la página ya muestra esa vista.
// Captura "Lista De Teléfonos" + "Lista De Direcciónes" en un solo PDF A3.

async function generarPDFDirecciones(page, cedula, outputDir) {
  try {
    // Dar tiempo a que Angular renderice completamente las dos tablas
    await waitMs(1000);

    // Verificar que la tabla de direcciones está en el DOM antes de imprimir
    await page.waitForFunction(
      () => [...document.querySelectorAll('table')].some(t => {
        const hs = [...t.querySelectorAll('thead th, thead td')]
          .map(h => h.textContent.trim().toUpperCase());
        return hs.some(h => h.includes('DIRECCI'));
      }),
      { timeout: 10000 }
    ).catch(() => {
      console.error(`[WARN] ${cedula}: tabla Direcciones no detectada antes de generar PDF`);
    });

    await waitMs(500);

    const nomArchivo = `SAC_${cedula}_DIRYTEL.pdf`;
    await page.pdf({
      path:            path.join(outputDir, nomArchivo),
      format:          'A3',
      landscape:       true,
      printBackground: true,
      margin:          { top: '8mm', bottom: '8mm', left: '8mm', right: '8mm' },
      scale:           0.75,
    });
    console.error(`[PDF] ${cedula}: generado ${nomArchivo} (Dir y Tel)`);
    return nomArchivo;
  } catch (e) {
    console.error(`[PDF-ERR] ${cedula} Dir y Tel: ${e.message}`);
    return null;
  }
}

// ─── Extraer datos del PDF Datacredito (sección RECONOCER+) ──────────────────
// Lee todos los PDFs no-SAC del outputDir (son los Datacredito del ZIP).
// Emails  → regex confiable aplicado a todo el texto.
// Dirs    → regex de vías colombianas (CL/KR/AV/TV/DG…) en texto de RECONOCER+.

async function extraerDatacredito(outputDir) {
  const result = { dc_dir: [], dc_email: [] };

  try {
    const archivos = fs.readdirSync(outputDir);
    const pdfsDC   = archivos.filter(f =>
      f.toLowerCase().endsWith('.pdf') && !f.startsWith('SAC_')
    );

    for (const pdfName of pdfsDC) {
      try {
        const buffer = fs.readFileSync(path.join(outputDir, pdfName));
        // Sin max: leer todas las páginas para alcanzar la sección RECONOCER+
        const parsed = await pdfParse(buffer);
        const texto  = parsed.text || '';

        // ── Emails ───────────────────────────────────────────────────────────
        // En el DataCrédito los correos vienen en una tabla enumerada; al extraer
        // el texto, el número de fila queda pegado al inicio del correo
        // (p.ej. "1davileidyss@gmail.com" → "davileidyss@gmail.com"). El contador
        // es secuencial (1, 2, 3…) y aparece al inicio de línea. Solo se quita si
        // los correos al inicio de línea REALMENTE vienen enumerados en secuencia,
        // para no dañar correos que legítimamente empiecen por dígitos (p.ej. los
        // basados en cédula, "1098765@gmail.com").
        const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
        const correoMatches = [];
        let m;
        while ((m = EMAIL_RE.exec(texto)) !== null) {
          const nl = texto.lastIndexOf('\n', m.index - 1);
          const lineStart = /^\s*$/.test(texto.slice(nl + 1, m.index));
          correoMatches.push({ email: m[0], lineStart });
        }

        // ¿Los correos al inicio de línea empiezan por 1, 2, 3…? (≥2 confirma tabla)
        const lineStarts = correoMatches.filter(x => x.lineStart);
        let run = 0;
        while (run < lineStarts.length && lineStarts[run].email.startsWith(String(run + 1))) run++;
        const enumerado = run >= 2;

        let fila = 0;
        for (const x of correoMatches) {
          let email = x.email;
          if (enumerado && x.lineStart) {
            const esperado = String(fila + 1);
            const resto = email.slice(esperado.length);
            if (email.startsWith(esperado) && /^[a-zA-Z0-9._%+-]+@/.test(resto)) {
              email = resto;   // quitar el contador de fila
              fila++;
            }
          }
          result.dc_email.push(email);
        }

        // ── Direcciones colombianas (mejor esfuerzo) ─────────────────────────
        // Patrón: tipo de vía + número inicial + hasta 45 chars alfanuméricos
        const COL_ADDR_RE = /\b(CL|CR|KR|AV|TV|DG|CQ|AC)\s+\d[A-Z0-9 #\-]{4,45}/gi;
        const matches = texto.match(COL_ADDR_RE) || [];

        for (const m of matches) {
          // Eliminar trailing de tipo de inmueble / zona (RES, LAB, CRR, URB, RUR…)
          const limpia = m
            .replace(/\s+(?:-\s*)?(?:RES|LAB|CRR|EMP|URB|RUR|SUS)\b[\s\S]*/i, '')
            .replace(/\s{2,}/g, ' ')
            .replace(/\s+\d\s*$/, '') // dígito suelto al final (estrato)
            .trim();
          if (limpia.length >= 6) result.dc_dir.push(limpia);
        }

      } catch (pdfErr) {
        console.error(`[WARN] PDF ${pdfName}: ${pdfErr.message}`);
      }
    }
  } catch (e) {
    console.error(`[WARN] extraerDatacredito: ${e.message}`);
  }

  const lbl = outputDir.split(/[/\\]/).pop();
  console.error(`[DIR-DC] ${lbl}: ${result.dc_dir.length} dir, ${result.dc_email.length} emails`);
  return result;
}

// ─── Deduplicar (case-insensitive, preserva primer aparición) ────────────────

function deduplicar(arr) {
  const visto = new Set();
  return arr.filter(v => {
    const key = (v || '').trim().toUpperCase();
    if (!key || visto.has(key)) return false;
    visto.add(key);
    return true;
  });
}

// ─── Guardar CONTACTOS_{cedula}.csv ──────────────────────────────────────────
// Combina SAC (primero) + Datacredito, deduplica case-insensitive.
// Guarda CSV con BOM UTF-8 para apertura correcta en Excel.
// sac_dir llega como [{ valor, ultimoUso }] (fecha de último uso de la tabla SAC).
//
//   TIPO,VALOR,FUENTE,ULTIMO_USO
//   DIRECCIÓN,"CL 15 13 A 52",SAC,"08-06-2026 18:14"
//   EMAIL,"elvher8693@gmail.com",SAC,""
//   DIRECCIÓN,"KR 16 A N 48 A 48",DATACREDITO,""

function guardarContactos(cedula, outputDir, { sac_dir, sac_email, dc_dir, dc_email }) {
  // Fecha de último uso por dirección SAC (clave normalizada)
  const usoMap = new Map();
  for (const d of sac_dir) {
    const key = (d.valor || '').trim().toUpperCase();
    if (key && d.ultimoUso && !usoMap.has(key)) usoMap.set(key, d.ultimoUso);
  }

  // SAC primero → más confiable; Datacredito agrega lo que falte
  const todasDir    = deduplicar([...sac_dir.map(d => d.valor), ...dc_dir]);
  const todosEmails = deduplicar([
    ...sac_email.map(e => e.toLowerCase()),
    ...dc_email.map(e => e.toLowerCase()),
  ]);

  if (todasDir.length === 0 && todosEmails.length === 0) {
    console.error(`[CONTACTOS] ${cedula}: sin datos de contacto`);
    return null;
  }

  const sacDirSet   = new Set(sac_dir.map(d => (d.valor || '').trim().toUpperCase()));
  const sacEmailSet = new Set(sac_email.map(e => e.trim().toUpperCase()));

  const filas = ['TIPO,VALOR,FUENTE,ULTIMO_USO'];

  for (const dir of todasDir) {
    const key    = dir.trim().toUpperCase();
    const fuente = sacDirSet.has(key) ? 'SAC' : 'DATACREDITO';
    const uso    = usoMap.get(key) || '';
    filas.push(`DIRECCIÓN,"${dir.replace(/"/g, '""')}",${fuente},"${uso.replace(/"/g, '""')}"`);
  }
  for (const email of todosEmails) {
    const fuente = sacEmailSet.has(email.toUpperCase()) ? 'SAC' : 'DATACREDITO';
    filas.push(`EMAIL,"${email}",${fuente},""`);
  }

  const filePath = path.join(outputDir, `CONTACTOS_${cedula}.csv`);
  // ﻿ = BOM UTF-8 para que Excel detecte el encoding correctamente
  fs.writeFileSync(filePath, '﻿' + filas.join('\n'), 'utf8');

  console.error(`[CONTACTOS] ${cedula}: ${todasDir.length} dir, ${todosEmails.length} emails → CONTACTOS_${cedula}.csv`);
  return `CONTACTOS_${cedula}.csv`;
}

// ─── Generar PDFs de obligaciones VIGENTE ────────────────────────────────────
//
// Problema conocido: la página SAC tiene VARIAS tablas en el DOM al mismo
// tiempo (Dir y Tel, detalles, búsqueda, etc.).  Un selector genérico como
// 'table tbody tr' captura filas de la tabla equivocada.
// Solución: identificar la tabla de obligaciones por su encabezado ESTADO
// antes de extraer o hacer clic en filas.

async function generarPDFsVigentes(page, cedula, outputDir) {
  const OBLIG_SEL = '[ng-reflect-message="Obligaciones"], [title="Obligaciones"], [aria-label="Obligaciones"]';

  // La tabla de Obligaciones SAC tiene AMBAS columnas: "OBLIGACI(ÓN)" y "ESTADO".
  // La tabla de Dir y Tel también tiene "ESTADO" (activo/inactivo de contactos)
  // pero NO tiene "OBLIGACI(ÓN)".  Por eso el discriminador es la presencia de
  // ambas columnas simultáneamente.
  function esTablaObligaciones(headers) {
    const hs = headers.map(h => h.trim().toUpperCase());
    return hs.some(h => h.includes('OBLIGACI')) && hs.some(h => h.includes('ESTADO'));
  }

  // ── Helper: navegar a la vista Obligaciones y esperar la tabla correcta ──
  async function cargarTablaObligaciones() {
    // Si la tabla ya es visible, no hacer clic (el botón es un toggle → clic
    // cuando ya está activo colapsaría la vista y causaría un timeout de 25 s)
    const yaVisible = await page.evaluate(() =>
      [...document.querySelectorAll('table')].some(t => {
        const hs = [...t.querySelectorAll('thead th, thead td')]
          .map(h => h.textContent.trim().toUpperCase());
        return hs.some(h => h.includes('OBLIGACI')) && hs.some(h => h.includes('ESTADO'));
      })
    );

    if (!yaVisible) {
      await page.waitForSelector(OBLIG_SEL, { visible: true, timeout: 12000 });
      await page.click(OBLIG_SEL);
      await waitForAngular(page, 1200);
      // Esperar una tabla que tenga AMBAS columnas: OBLIGACI(ÓN) + ESTADO
      await page.waitForFunction(
        () => [...document.querySelectorAll('table')].some(t => {
          const hs = [...t.querySelectorAll('thead th, thead td')]
            .map(h => h.textContent.trim().toUpperCase());
          return hs.some(h => h.includes('OBLIGACI')) && hs.some(h => h.includes('ESTADO'));
        }),
        { timeout: 25000 }
      ).catch(() => { throw new Error('Tabla de obligaciones (col. OBLIGACIÓN + ESTADO) no encontrada'); });
    }
  }

  // ── Helper: extraer filas VIGENTE de la tabla de obligaciones ────────────
  async function extraerVigentes() {
    // ── DEBUG: volcar todas las tablas del DOM para diagnosticar ─────────
    const debugTables = await page.evaluate(() =>
      [...document.querySelectorAll('table')].map((t, ti) => ({
        ti,
        headers: [...t.querySelectorAll('thead th, thead td, tr:first-child th')]
          .map(h => h.textContent.trim()).slice(0, 10),
        rowCount: t.querySelectorAll('tbody tr').length,
        sample: [...t.querySelectorAll('tbody tr')].slice(0, 2).map(tr =>
          [...tr.querySelectorAll('td')].map(td => td.textContent.trim().slice(0, 25))
        ),
      }))
    );
    console.error(`[PDF-DEBUG] ${cedula}: ${debugTables.length} tabla(s) → ${JSON.stringify(debugTables)}`);
    // ── Fin DEBUG ─────────────────────────────────────────────────────────

    return page.evaluate(() => {
      for (const t of document.querySelectorAll('table')) {
        const headerCells = [...t.querySelectorAll('thead th, thead td')];
        const headers     = headerCells.map(h => h.textContent.trim().toUpperCase());
        // Tabla correcta: tiene OBLIGACI(ÓN) Y ESTADO
        if (!headers.some(h => h.includes('OBLIGACI')) || !headers.some(h => h.includes('ESTADO'))) continue;
        const estadoIdx = headers.findIndex(h => h.includes('ESTADO'));
        const obligIdx  = (() => {
          const i = headers.findIndex(h => h.includes('OBLIGACI'));
          return i >= 0 ? i : 2;
        })();
        return [...t.querySelectorAll('tbody tr')]
          .map((tr, idx) => {
            const cells = [...tr.querySelectorAll('td')];
            return {
              idx,
              estado:     (cells[estadoIdx]?.textContent || '').trim().toUpperCase(),
              obligacion: (cells[obligIdx]?.textContent  || '').trim(),
            };
          })
          .filter(r => r.estado === 'VIGENTE');
      }
      return [];
    });
  }

  // ── Helper: obtener ElementHandle de una fila por número de obligación ───
  async function buscarFila(obligacion, fallbackIdx) {
    const info = await page.evaluate((obl, fbIdx) => {
      const tables = [...document.querySelectorAll('table')];
      for (let ti = 0; ti < tables.length; ti++) {
        const t       = tables[ti];
        const headers = [...t.querySelectorAll('thead th, thead td')]
          .map(h => h.textContent.trim().toUpperCase());
        // Solo buscar en la tabla de obligaciones
        if (!headers.some(h => h.includes('OBLIGACI')) || !headers.some(h => h.includes('ESTADO'))) continue;
        const obligIdx = (() => {
          const i = headers.findIndex(h => h.includes('OBLIGACI'));
          return i >= 0 ? i : 2;
        })();
        const rows = [...t.querySelectorAll('tbody tr')];
        let ri = rows.findIndex(tr => {
          const cells = [...tr.querySelectorAll('td')];
          return (cells[obligIdx]?.textContent || '').trim() === obl;
        });
        if (ri === -1 && fbIdx >= 0 && fbIdx < rows.length) ri = fbIdx;
        if (ri >= 0) return { ti, ri };
      }
      return null;
    }, obligacion, fallbackIdx);

    if (!info) return null;
    const tables = await page.$$('table');
    const table  = tables[info.ti];
    if (!table) return null;
    const rows = await table.$$('tbody tr');
    return rows[info.ri] || null;
  }

  // ── Flujo principal ───────────────────────────────────────────────────────
  await cargarTablaObligaciones();

  const vigentes = await extraerVigentes();
  if (vigentes.length === 0) return [];
  console.error(`[PDF] ${cedula}: ${vigentes.length} obligación(es) VIGENTE`);

  const pdfsGenerados = [];

  for (let i = 0; i < vigentes.length; i++) {
    const vigente = vigentes[i];
    try {
      // Intentar encontrar la fila sin recargar (la tabla puede seguir visible).
      let fila = await buscarFila(vigente.obligacion, -1);

      // Si no se encontró, Angular pudo haber salido de la vista → recargar.
      if (!fila) {
        console.error(`[PDF] ${cedula}: recargando tabla (obl. ${vigente.obligacion})...`);
        await cargarTablaObligaciones();
        fila = await buscarFila(vigente.obligacion, vigente.idx);
      }

      if (!fila) {
        console.error(`[WARN] ${cedula}: fila de obligación "${vigente.obligacion}" no encontrada`);
        continue;
      }

      await fila.click();
      await waitForAngular(page, 1200);

      const nomArchivo = `SAC_${cedula}_OBL${vigente.obligacion || vigente.idx}.pdf`;
      await page.pdf({
        path:            path.join(outputDir, nomArchivo),
        format:          'A3',
        landscape:       true,
        printBackground: true,
        margin:          { top: '8mm', bottom: '8mm', left: '8mm', right: '8mm' },
        scale:           0.8,
      });
      pdfsGenerados.push(nomArchivo);
      console.error(`[PDF] ${cedula}: generado ${nomArchivo} (${i + 1}/${vigentes.length})`);

    } catch (pdfErr) {
      console.error(`[PDF-ERR] ${cedula} obligación "${vigente.obligacion}": ${pdfErr?.message || pdfErr}`);
    }
  }

  return pdfsGenerados;
}

// ─── Main ────────────────────────────────────────────────────────────────────
// Procesamiento secuencial: una sola tab, un cliente a la vez.
// Ventajas frente al enfoque multi-tab:
//   · El DOM de Angular es limpio en cada iteración (sin contaminación entre clientes).
//   · La tabla de obligaciones se detecta correctamente porque `generarPDFsVigentes`
//     corre ANTES de `extraerDirYTelSAC`, por lo que la tabla Dir y Tel aún no existe
//     en el DOM cuando se buscan las obligaciones.
//   · Una sola sesión → sin necesidad de inyectar localStorage/sessionStorage.

async function main() {
  let clientes;
  try {
    clientes = JSON.parse(clientesJson);
    if (!Array.isArray(clientes) || !clientes.length) throw new Error('Array vacío');
  } catch (e) {
    console.log(JSON.stringify({ success: false, error: 'clientesJSON inválido: ' + e.message }));
    return;
  }

  if (!sacBaseUrl || !sacUser || !sacPass) {
    console.log(JSON.stringify({ success: false, error: 'Argumentos SAC incompletos' }));
    return;
  }

  // 'shell' = old headless mode (compatible con Angular/Material y page.pdf()).
  // En Puppeteer 21+ headless:true usa el NUEVO motor que rompe muchos selectores.
  // HEADLESS=false abre el navegador visible (solo para diagnosticar el login a mano).
  const browser = await puppeteer.launch({
    headless: process.env.HEADLESS === 'false' ? false : 'shell',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1920,1080',
      '--disable-web-security',
      '--ignore-certificate-errors',
      '--ignore-certificate-errors-spki-list',
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  page.setDefaultTimeout(300000);
  // El SAC a veces tarda >60 s en responder el login; con 60 s se perdían cédulas
  // por "Navigation timeout" aunque el banco estuviera bien, solo lento.
  const NAV_TIMEOUT = Number(process.env.SAC_NAV_TIMEOUT_MS) || 120000;
  page.setDefaultNavigationTimeout(NAV_TIMEOUT);

  const resultados = [];

  try {
    // ── 1. Login ──────────────────────────────────────────────────────────────
    // Un reintento del goto: la carga inicial del SAC es la que más suele colgarse
    // de forma transitoria; reintentar una vez evita perder la cédula por eso.
    console.error(`[INFO] Navegando a login: ${LOGIN_URL}`);
    try {
      await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    } catch (e) {
      console.error(`[INFO] Login lento (${e.message}); reintentando una vez…`);
      await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    }
    await waitMs(3000);

    const loginUrl = page.url();
    console.error(`[INFO] URL actual tras goto: ${loginUrl}`);

    // Captura de pantalla de diagnóstico en C:/SAC_Documentos/debug_login.png
    
    

    // Loguear todos los inputs encontrados para diagnóstico
    const allInputs = await page.evaluate(() =>
      [...document.querySelectorAll('input')].map(i => ({
        type: i.type, name: i.name, id: i.id,
        class: i.className.slice(0, 60),
        visible: i.getBoundingClientRect().width > 0,
      }))
    );
    console.error(`[INFO] Inputs en la página: ${JSON.stringify(allInputs)}`);

    // Intentar múltiples selectores para el campo usuario
    const selectorUsuario = [
      'input.mat-input-element:not([type="password"])',
      'input[type="text"]',
      'input[formcontrolname="username"]',
      'input[name="username"]',
      'input[placeholder*="suar"]',
      'input[placeholder*="user"]',
      'input:not([type="password"]):not([type="hidden"])',
    ];

    let campoUsuario = null;
    for (const sel of selectorUsuario) {
      campoUsuario = await page.$(sel);
      if (campoUsuario) {
        const visible = await page.evaluate(el => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        }, campoUsuario);
        if (visible) { console.error(`[INFO] Campo usuario encontrado: ${sel}`); break; }
        campoUsuario = null;
      }
    }
    if (!campoUsuario) throw new Error(`Campo Usuario no encontrado. Inputs: ${JSON.stringify(allInputs)}`);

    await campoUsuario.click({ clickCount: 3 });
    await campoUsuario.type(sacUser, { delay: 40 });
    console.error(`[INFO] Usuario "${sacUser}" escrito`);

    // Campo contraseña
    const todosPass = await page.$$('input[type="password"]');
    const passIdx   = await page.evaluate(() => {
      const inputs = [...document.querySelectorAll('input[type="password"]')];
      return inputs.findIndex(inp => {
        const r = inp.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
    });
    if (passIdx === -1 || !todosPass[passIdx]) throw new Error('Campo Contraseña no visible en login');
    await todosPass[passIdx].click({ clickCount: 3 });
    await todosPass[passIdx].type(sacPass, { delay: 40 });
    console.error(`[INFO] Contraseña escrita`);

    const btnLogin = await page.$('button.btn-primary')
                  || await page.$('button[type="submit"]')
                  || await page.$('button');
    if (!btnLogin) throw new Error('Botón login no encontrado');
    const btnText = await page.evaluate(b => b.textContent.trim(), btnLogin);
    console.error(`[INFO] Haciendo clic en botón: "${btnText}"`);
    await btnLogin.click();

    // El SAC no siempre redirige solo tras el login: a veces la URL se queda en
    // /login aunque la autenticación fue correcta (bug observado en la oficina —
    // hubo que cambiar la URL al home a mano). Por eso NO dependemos del redirect:
    // esperamos la señal de sesión (token en storage) y, pase lo que pase,
    // forzamos nosotros la navegación al home.
    try {
      await page.waitForFunction(
        () => {
          if (!window.location.href.toLowerCase().includes('/login')) return true; // redirigió solo
          const tieneToken = (store) => {
            try {
              for (let i = 0; i < store.length; i++) {
                const k = store.key(i);
                if (/token|auth|jwt|session/i.test(k) && store.getItem(k)) return true;
              }
            } catch { /* storage bloqueado */ }
            return false;
          };
          return tieneToken(window.localStorage) || tieneToken(window.sessionStorage);
        },
        { timeout: 30000 }
      );
    } catch {
      console.error('[INFO] Sin redirect ni token tras 30 s; navego al home a mano (como en la oficina).');
    }

    // Forzamos la navegación al home: equivale a que el usuario cambie la URL al
    // dashboard cuando el SAC no redirige solo tras el login.
    await page.goto(GESTION_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await waitForAngular(page, 2000);

    // Si tras navegar el SAC nos devuelve a /login, la sesión no quedó activa
    // (credenciales incorrectas o token rechazado).
    if (page.url().toLowerCase().includes('/login')) {
      throw new Error('Login falló: el SAC volvió a /login tras autenticar (revisa usuario/contraseña).');
    }
    const urlPostLogin = page.url();
    console.error(`[INFO] Login exitoso → ${urlPostLogin}. Procesando ${clientes.length} cliente(s).`);

    // ── 2. Procesar clientes secuencialmente en la misma tab ─────────────────
    for (let i = 0; i < clientes.length; i++) {
      const { cedula, outputDir } = clientes[i];
      try {
        fs.mkdirSync(outputDir, { recursive: true });

        // Navegar a la vista de gestión para cada cliente.
        // IMPORTANTE: usar 'domcontentloaded' — las apps Angular/SPA nunca
        // llegan a 'networkidle2' porque hacen polling constante al backend.
        console.error(`[INFO] Navegando al cliente ${cedula} (${i + 1}/${clientes.length})...`);
        await page.goto(GESTION_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await waitForAngular(page, 2000);
        await seleccionarCliente(page, cedula);

        // IMPORTANTE: generarPDFsVigentes va ANTES de extraerDirYTelSAC.
        // Así la tabla Dir y Tel aún no está en el DOM cuando buscamos
        // la tabla de obligaciones → sin contaminación de selectores.
        const pdfs         = await generarPDFsVigentes(page, cedula, outputDir);

        // extraerDirYTelSAC hace clic en "Dir y Tel" → la página queda en esa vista.
        // generarPDFDirecciones aprovecha esa vista para generar el PDF sin navegar de nuevo.
        const sacContactos  = await extraerDirYTelSAC(page, cedula);
        const pdfDirecciones = await generarPDFDirecciones(page, cedula, outputDir);
        if (pdfDirecciones) pdfs.push(pdfDirecciones);

        const dcContactos  = await extraerDatacredito(outputDir);
        const contactoFile = guardarContactos(cedula, outputDir, {
          sac_dir:   sacContactos.sac_dir,
          sac_email: sacContactos.sac_email,
          dc_dir:    dcContactos.dc_dir,
          dc_email:  dcContactos.dc_email,
        });

        console.error(`[OK] ${cedula}: ${pdfs.length} PDF(s)${contactoFile ? ' + ' + contactoFile : ''} (${i + 1}/${clientes.length})`);
        resultados.push({ cedula, success: true, pdfs, contactoFile });

      } catch (err) {
        console.error(`[ERR] ${cedula}: ${err.message}`);
        resultados.push({ cedula, success: false, error: err.message });
      }
    }

  } catch (err) {
    await browser.close().catch(() => {});
    console.log(JSON.stringify({ success: false, error: err.message, clientes: resultados }));
    return;
  }

  await browser.close().catch(() => {});
  console.log(JSON.stringify({
    success:  resultados.some(r => r.success),
    clientes: resultados,
  }));
}

main().catch(err => {
  console.log(JSON.stringify({ success: false, error: err.message }));
});
