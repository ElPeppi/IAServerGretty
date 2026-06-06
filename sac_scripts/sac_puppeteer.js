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
// Hace clic en el botón "Dir Y Tel" (id="btn-link-home") y lee la tabla
// "Lista De Direcciones": col 0 = valor, col 1 = TIPO DIRECCIÓN.
// Tipo EMAIL  → lista de emails
// Otros tipos → lista de direcciones físicas

async function extraerDirYTelSAC(page, cedula) {
  try {
    const btn = await page.$('#btn-link-home')
              || await page.$('[ng-reflect-message="Dir Y Tel"]')
              || await page.$('[title="Dir Y Tel"]');

    if (!btn) {
      console.error(`[WARN] Botón Dir y Tel no encontrado para ${cedula}`);
      return { sac_dir: [], sac_email: [] };
    }

    await btn.click();
    await waitForAngular(page, 1500);

    const datos = await page.evaluate(() => {
      const result = { sac_dir: [], sac_email: [] };
      const tables = [...document.querySelectorAll('table')];

      for (const table of tables) {
        // La tabla de direcciones tiene "DIRECCIÓN" como primer encabezado
        const headers = [...table.querySelectorAll('thead th, thead td')]
                        .map(c => c.textContent.trim().toUpperCase());
        if (!headers[0] || !headers[0].includes('DIRECCI')) continue;

        const rows = [...table.querySelectorAll('tbody tr')];
        for (const row of rows) {
          const cells = [...row.querySelectorAll('td')].map(td => td.textContent.trim());
          const valor = (cells[0] || '').trim();
          const tipo  = (cells[1] || '').trim().toUpperCase();
          if (!valor || valor.length < 3) continue;

          if (tipo === 'EMAIL') {
            result.sac_email.push(valor);
          } else {
            result.sac_dir.push(valor);
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
        const emails = texto.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
        result.dc_email.push(...emails);

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
//
//   TIPO,VALOR,FUENTE
//   DIRECCIÓN,"CL 15 13 A 52",SAC
//   EMAIL,"elvher8693@gmail.com",SAC
//   DIRECCIÓN,"KR 16 A N 48 A 48",DATACREDITO

function guardarContactos(cedula, outputDir, { sac_dir, sac_email, dc_dir, dc_email }) {
  // SAC primero → más confiable; Datacredito agrega lo que falte
  const todasDir    = deduplicar([...sac_dir, ...dc_dir]);
  const todosEmails = deduplicar([
    ...sac_email.map(e => e.toLowerCase()),
    ...dc_email.map(e => e.toLowerCase()),
  ]);

  if (todasDir.length === 0 && todosEmails.length === 0) {
    console.error(`[CONTACTOS] ${cedula}: sin datos de contacto`);
    return null;
  }

  const sacDirSet   = new Set(sac_dir.map(d => d.trim().toUpperCase()));
  const sacEmailSet = new Set(sac_email.map(e => e.trim().toUpperCase()));

  const filas = ['TIPO,VALOR,FUENTE'];

  for (const dir of todasDir) {
    const fuente = sacDirSet.has(dir.trim().toUpperCase()) ? 'SAC' : 'DATACREDITO';
    filas.push(`DIRECCIÓN,"${dir.replace(/"/g, '""')}",${fuente}`);
  }
  for (const email of todosEmails) {
    const fuente = sacEmailSet.has(email.toUpperCase()) ? 'SAC' : 'DATACREDITO';
    filas.push(`EMAIL,"${email}",${fuente}`);
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
  const browser = await puppeteer.launch({
    headless: 'shell',
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
  page.setDefaultNavigationTimeout(60000);

  const resultados = [];

  try {
    // ── 1. Login ──────────────────────────────────────────────────────────────
    console.error(`[INFO] Navegando a login: ${LOGIN_URL}`);
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitMs(3000);

    const loginUrl = page.url();
    console.error(`[INFO] URL actual tras goto: ${loginUrl}`);

    // Captura de pantalla de diagnóstico en C:/SAC_Documentos/debug_login.png
    const debugDir = require('path').join(clientes[0]?.outputDir ? require('path').dirname(clientes[0].outputDir) : 'C:/SAC_Documentos');
    try {
      await page.screenshot({ path: require('path').join(debugDir, 'debug_login.png'), fullPage: true });
      console.error('[INFO] Screenshot de login guardado en debug_login.png');
    } catch (_) {}

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

    await page.waitForFunction(
      () => !window.location.href.toLowerCase().includes('/login'),
      { timeout: 90000 }
    );
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
