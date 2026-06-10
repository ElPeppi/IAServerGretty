# Arquitectura — SAC Processor

Servidor Node.js que automatiza el flujo de demandas ejecutivas singulares:
recibe ZIPs de documentos desde n8n, descarga PDFs del portal SAC con Puppeteer
y genera la Plantilla Singular (Excel) + demandas (Word).

## Estilo: monolito modular en capas

```
HTTP (routes) → lógica de negocio (services) → reglas puras (domain) → helpers (utils)
                                ↓
                        config (única fuente de env)
```

Reglas de dependencia (siempre hacia abajo, nunca al revés):

- `routes/` puede importar `services/`, `utils/`, `config`
- `services/` puede importar otros services, `domain/`, `utils/`, `config`
- `domain/` solo puede importar `utils/` (sin I/O, sin Express, sin env)
- `utils/` no importa nada del proyecto
- Nadie lee `process.env` directamente — todo pasa por `src/config.js`

## Mapa de archivos

```
sac_scripts/
├─ server.js                        Punto de entrada: carga config + app y escucha
├─ sac_puppeteer.js                 Worker CLI (proceso hijo): login SAC, PDFs de
│                                   obligaciones VIGENTES, Dir y Tel, contactos CSV
├─ singular_processor.js            Shim de compatibilidad → src/services/singular
├─ test (HTML)                      ../test_singular.html consume estos endpoints
└─ src/
   ├─ config.js                     .env + rutas + credenciales + constantes
   ├─ app.js                        Express: CORS, JSON 100mb, registro de rutas, /health
   ├─ routes/
   │  ├─ zips.routes.js             POST /procesar-zip, POST /procesar-zips, GET /job-status/:id
   │  └─ singular.routes.js         POST /generar-singular
   ├─ services/
   │  ├─ colaSac.js                 Cola de ejecución (una sesión SAC/Chromium a la vez)
   │  ├─ jobStore.js                Map de estado de jobs + limpieza periódica
   │  ├─ cedulas.js                 Extracción de cédula desde PDFs/nombres del ZIP
   │  ├─ zips.js                    Flujo de ZIPs: password del correo, extracción
   │  │                             (adm-zip + fallback PowerShell), renombrado de
   │  │                             pagarés, orquestación del lote completo
   │  ├─ puppeteerRunner.js         Lanza sac_puppeteer.js (lote y cédula única)
   │  └─ singular/
   │     ├─ index.js                procesarSingular (orquestador del flujo completo)
   │     ├─ excelEntrada.js         Parseo del Excel de entrada (Hoja1 + Hoja2, filtro DECEVAL)
   │     ├─ carpetaCliente.js       Lectura de {OUT_DIR}/{cedula}/: PDFs SAC, DECEVAL, contactos
   │     ├─ ramaJudicial.js         Scraping del directorio de correos de juzgados (+cache)
   │     ├─ plantillaXlsx.js        Construcción de filas + llenado de la Plantilla Singular
   │     └─ demandas.js             Generación de demandas Word (mail merge sobre DOCX)
   ├─ domain/
   │  ├─ cuantia.js                 Umbrales de cuantía y reglas de tipo de juzgado
   │  └─ vehiculos.js               Parseo de descripciones de vehículos
   └─ utils/
      ├─ carpetas.js                mkdirpSync (UNC-safe) + resolución {cedula}/{cedula}_{año}
      ├─ fechas.js                  Fechas a texto legal "14 de Abril del 2026"
      └─ numeros.js                 toNum, fmtCOP
```

## Flujos principales

**POST /procesar-zips** (n8n → lote de ZIPs en base64)
1. `zips.procesarLoteZips` encola todo el flujo en `colaSac`
2. Por cada ZIP: decodificar → `cedulas.extraerCedulaDePDFs` → carpeta por cédula
   → extraer archivos (adm-zip, fallback PowerShell) → renombrar pagarés
3. `puppeteerRunner.correrPuppeteerLote` lanza `sac_puppeteer.js` (un login, N clientes)
4. Enriquecer respuesta con los archivos reales en disco

**POST /generar-singular** (Excel de entrada → Plantilla Singular + demandas)
1. `excelEntrada.parsearExcelEntrada` filtra clientes DECEVAL y consolida financieros
2. Por cliente: `carpetaCliente` lee PDFs SAC (fecha mora más antigua), DECEVAL
   (número pagaré, fecha suscripción) y contactos; `ramaJudicial` busca el correo
   del juzgado; `domain/cuantia` clasifica cuantía y juzgado
3. `plantillaXlsx.fillTemplate` escribe el XLSX (Hoja2 = vehículos adicionales)
4. `demandas.generarDemandasWord` genera un DOCX por cliente

## Decisiones de diseño

- **sac_puppeteer.js queda como worker CLI separado**: corre como proceso hijo
  (un Chromium aislado por ejecución, sin compartir memoria con el servidor).
  Su contrato es por argv + JSON en stdout; no importa nada de src/.
- **Cola en lugar de concurrencia**: el SAC no tolera sesiones paralelas del
  mismo usuario y Chromium consume mucha RAM; `colaSac` serializa todo.
- **Sin framework de inyección de dependencias**: el tamaño del proyecto no lo
  justifica; los módulos se conectan por require directo.
- **Los services devuelven objetos resultado** (`{ success, error, ... }`) en
  lugar de lanzar excepciones hacia las rutas, para que n8n siempre reciba
  JSON consistente.

## Para agregar un endpoint nuevo

1. Crear el service con la lógica en `src/services/`
2. Crear/extender un router en `src/routes/` (solo parseo req/res)
3. Registrarlo en `src/app.js`
