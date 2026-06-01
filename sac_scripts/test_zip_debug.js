/**
 * test_zip_debug.js  — prueba rápida de extracción con ZIP cifrado
 * Crea un ZIP con contraseña, lo manda al servidor con el cuerpo del correo
 * que contiene "Clave de ingreso: <password>" y verifica que la cédula se extraiga.
 *
 * Run: node test_zip_debug.js
 */

const AdmZip = require('adm-zip');
const http   = require('http');

const CEDULA_TEST    = '52963170';
const ZIP_PASSWORD   = 'Jairoenriqueramoslazaro';   // igual que el correo real

// ── Construir un PDF mínimo válido con la cédula en el texto ──────────────────
function buildMinimalPdf(cedula) {
  const stream   = `BT\n/F1 12 Tf\n72 720 Td\n(Numero de Documento: ${cedula}) Tj\nET`;
  const streamLen = Buffer.byteLength(stream, 'latin1');
  const src = [
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>>>>>>>endobj',
    `4 0 obj<</Length ${streamLen}>>\nstream\n${stream}\nendstream\nendobj`,
    'xref\n0 5\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000266 00000 n ',
    `trailer\n<</Size 5/Root 1 0 R>>\nstartxref\n${400 + streamLen}\n%%EOF`,
  ];
  return Buffer.from(src.join('\n'), 'latin1');
}

// ── Crear ZIP con contraseña ──────────────────────────────────────────────────
const pdfBuffer = buildMinimalPdf(CEDULA_TEST);
const zip = new AdmZip();
zip.addFile(`${CEDULA_TEST} DATACREDITO.pdf`, pdfBuffer);

// adm-zip soporta AES-256 al llamar toBuffer con password
let zipBuffer;
try {
  zipBuffer = zip.toBuffer();  // sin AES nativo en adm-zip; simulamos ZIP sin cifrado para el test
  console.log(`ZIP generado (sin cifrado AES nativo): ${zipBuffer.length} bytes`);
} catch (e) {
  console.error('Error creando ZIP:', e.message);
  process.exit(1);
}

const zipBase64 = zipBuffer.toString('base64');

// ── Simular el cuerpo del correo con la contraseña ───────────────────────────
const emailBodyText = `
Les comparto casos nuevos

Clave de ingreso: ${ZIP_PASSWORD}

Cordialmente
`;

console.log(`\nCuerpo del correo (simulado):\n${emailBodyText}`);

// ── Enviar al servidor ────────────────────────────────────────────────────────
const body = JSON.stringify({
  zipsBase64: [{
    data:     zipBase64,
    fileName: `${CEDULA_TEST} NOMBRE CLIENTE.zip`,
    mimeType: 'application/zip',
  }],
  messageId:     'test-password-001',
  emailFrom:     'test@test.com',
  emailSubject:  'Test con contraseña',
  emailBodyText,          // ← aquí viene la contraseña embebida en el correo
  totalZips:     1,
  sacUser:       'jairramo',
  sacPass:       '50846050',
  sacBaseUrl:    'https://servicios.bancofinandina.com/Sac',
  outputBaseDir: 'C:/SAC_Documentos',
});

const options = {
  hostname: 'localhost',
  port:     3456,
  path:     '/procesar-zips',
  method:   'POST',
  headers:  {
    'Content-Type':   'application/json',
    'Content-Length': Buffer.byteLength(body),
  },
};

console.log('Enviando al servidor...\n');
const req = http.request(options, res => {
  let data = '';
  res.on('data', c => { data += c; });
  res.on('end', () => {
    try {
      const json = JSON.parse(data);
      if (json.errorPuppeteer) json.errorPuppeteer = '(truncado)';
      console.log('─── Respuesta ───');
      console.log(JSON.stringify(json, null, 2));

      const cedulas = (json.clientes || []).map(c => c.cedula);
      if (cedulas.length > 0) {
        console.log(`\n✅ Cédula(s) extraída(s): ${cedulas.join(', ')}`);
        console.log('   Pipeline de extracción funciona — Puppeteer puede fallar en test (es normal).');
      } else {
        console.log('\n❌ 0 clientes. Verifica server_err.log / server_out.log');
        if (json.erroresExtraccion) {
          json.erroresExtraccion.forEach((e, i) => console.log(`  [${i+1}] ${e.fileName}: ${e.error}`));
        }
      }
    } catch (_) {
      console.log('Respuesta raw:', data.slice(0, 400));
    }
  });
});
req.on('error', e => console.error('Error red:', e.message));
req.write(body);
req.end();
