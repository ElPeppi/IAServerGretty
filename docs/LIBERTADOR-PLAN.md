# Libertador — plan de implementación

Estado: **arranque**. Primer entregable = generar el **estado de cuenta** por deudor
antes de armar la demanda. Este doc fija las decisiones ya tomadas y lo que falta.

> Libertador es un cliente **distinto de Finandina**. NO comparte SAC, login ni
> plantillas. No reutilizar `sac_puppeteer.js` (ese es de Finandina).

## 1. Acceso al SAC de Libertador (Oracle Service Cloud) — RESUELTO

- Portal: `https://ellibertador.custhelp.com/...` → **Oracle Service Cloud (RightNow/CX)**.
- Login = **formulario usuario/contraseña en navegador** (la página dice "Página de
  conexión SSO" pero es el login propio de Oracle, sin IdP externo). Verificado
  cargando la página: campos `Nombre de usuario` + `Contraseña` + botón `Conexión`.
- **"Iniciar agente en explorador" (AgentWeb)** corre en cualquier Chromium moderno,
  incluido **headless en el servidor Linux** → **automatizable con Puppeteer**, mismo
  patrón que Finandina.
- La **app de escritorio "Agent Desktop" (.NET)** es **solo Windows** (no corre en
  Linux sin Wine, no soportado). Lo de "solo corre en Edge" viene de que esa app
  incrusta un control de navegador; **no la necesitamos** — AgentWeb la reemplaza.

**Decisión:** worker nuevo para Oracle (p. ej. `libertador_puppeteer.js` o
`src/services/libertador/…`), login por formulario, credenciales en `.env`:
`LIBERTADOR_SAC_URL`, `LIBERTADOR_SAC_USER`, `LIBERTADOR_SAC_PASS`.

## 2. Fuente de datos del estado de cuenta — DECIDIDO

Los datos (capital, intereses, mora, fechas, N.º de obligación, etc.) salen **del
propio SAC de Oracle** del deudor (pestaña financiera/obligaciones), leídos por el
agente en navegador — como se hace hoy con Finandina.

## 3. Plantilla del estado de cuenta — PENDIENTE (bloqueante)

- Ubicación: Drive → `documentos actuali.../demandas/libertador/plantillas/estado de cuenta.xls`.
- La NAS `\\10.0.10.10` **no** es alcanzable desde la máquina de desarrollo (sólo
  desde el servidor). El Drive sí, vía la POC OAuth (`scripts/drive-poc`).
- El token OAuth (`scripts/drive-poc/token.json`) **caducó** (`invalid_grant`, proyecto
  en modo testing → refresh token expira ~7 días). Respaldado como `token.json.bak`.
- Buscador listo: `scripts/drive-poc/buscar-estado-cuenta.js` (localiza y descarga la
  plantilla en cuanto el token esté vivo).

**Desbloqueo (una de las dos):**
1. Re-autorizar: `cd scripts/drive-poc && node poc-oauth.js` (consentimiento con la
   cuenta de la oficina) → regenera `token.json`.
2. O dejar el `estado de cuenta.xls` copiado en una carpeta local.

## 4. Generación del estado de cuenta — molde

Reusar el enfoque de [`plantillaXlsx.js`](../sac_scripts/src/services/finandina/singular/plantillaXlsx.js):
cargar la plantilla `.xlsx` con la librería `xlsx`, leer encabezados/celdas y escribir
los valores. El mapeo campo→celda se define **cuando tengamos la plantilla** (punto 3).

## 5. Worker de login (AgentWeb + Puppeteer) — HECHO (falta probar con credenciales)

- Worker: [`libertador_puppeteer.js`](../sac_scripts/libertador_puppeteer.js) (raíz de
  `sac_scripts`, al estilo de `sac_puppeteer.js` de Finandina: CLI, salida JSON por stdout).
- Selectores reales del login SSO de Oracle: form `#loginform`, usuario `#username`
  (name `USERNAME`), contraseña `#password` (name `PASSWORD`), botón `#loginbutton`
  ("Conexión"); al éxito redirige a `/AgentWeb/login`.
- Config en `src/config.js`: `LIBERTADOR_SAC_URL` / `LIBERTADOR_SAC_USER` /
  `LIBERTADOR_SAC_PASS`. Variables agregadas a `sac_scripts/.env` (credenciales vacías,
  para pegar).
- Probar en local:
  ```
  cd sac_scripts
  node libertador_puppeteer.js              # headless
  HEADLESS=false node libertador_puppeteer.js   # para ver el navegador
  ```
  Salida: `{ success, finalUrl, screenshot, error? }`. Screenshot en `SAC_TEMP_DIR`.

## 6. Generador del estado de cuenta — HECHO (mecanismo), falta datos reales

- Plantilla canónica descargada y analizada (hoja `Formato`): estado de cuenta de
  cobranza de arrendamiento (canon/adm/abonos/saldo + liquidación con honorarios/IVA).
- Generador: [`src/services/libertador/estadoCuenta.js`](../sac_scripts/src/services/libertador/estadoCuenta.js)
  `generarEstadoCuenta(datos, plantillaPath)` → Buffer .xlsx. Contrato de datos documentado
  en el archivo. Demo probado (TOTAL DEUDA calculado por las fórmulas del template).
- Pendiente de formato: `xlsx` (SheetJS community) no reescribe estilos; para conservar
  100% el formato del .xls, en producción usar LibreOffice headless o plantilla .xlsx con estilos.

## 7. Navegación dentro de AgentWeb — selectores reales

Descubiertos por `LIBERTADOR_EXPLORE=1` (vuelca frames + inputs/botones/pestañas):

- Buscador "Búsqueda rápida" (placeholder "# Solicitud"), en el documento principal:
  - input `#select-box-input-quickSearch`
  - botón `#quickSearchSearchButton` (title "Buscar")
- La consola vacía tiene solo 2 frames (principal + chat rnengage `about:blank`);
  el **workspace se monta en el documento principal** (Oracle JET `oj-*`), NO en iframe.
- Ojo con los dos números por solicitud: el del título ("6929878-BÁSICO") es el
  **# Solicitud**; el "ID: 1548546" es el id interno del registro.

### La búsqueda abre un GRID de resultados, no la ficha
Buscar por # Solicitud abre un reporte "Buscar Solicitud" con **una fila por
siniestro** (una solicitud tiene varios: distintos amparos/fechas/estados).
Es un **Oracle JET DataGrid**: celdas `div.oj-datagrid-cell[row-id][column-id]`;
encabezados `.oj-datagrid-header-cell-text` (orden = column-id):
Grupo(0) · Asesor(1) · Amparo(2) · Solicitud No(3) · Fecha de Mora(4) ·
Estado del Siniestro(5) · Arrendatario(6) · Dirección(7) · Acciones(8).
El "Abrir" de cada fila = `span.recordCommandLink` en la columna Acciones.

### Regla de negocio (definida por la oficina)
De las N filas se abre la de **Estado del Siniestro = "Vigente"**; si hay varias,
la de **Fecha de Mora más reciente**. Implementado en `abrirSiniestroVigente()`
(lee encabezados → agrupa por row-id → filtra Vigente → ordena por fecha desc →
marca y hace clic en su recordCommandLink).

Worker: `buscarSolicitud()` + `abrirSiniestroVigente()` implementados. Correr:
```
cd sac_scripts
LIBERTADOR_EXPLORE=1 LIBERTADOR_SOLICITUD=6929878 HEADLESS=false node libertador_puppeteer.js
```
Flujo: login → busca 6929878 → grid → abre la fila Vigente → explora la FICHA.
✅ Probado: abre la ficha correcta (6929878-AMPARO INTEGRAL, Vigente, mora 06/11/2024).

### Pestañas de la ficha + Estado de Cuenta
Las pestañas son `<li class="ws-tab-item">` con `<span class="tab-title">`. El id
lleva el id interno del siniestro (dinámico) → se selecciona por TEXTO exacto.
`irAEstadoDeCuenta()` hace clic en la de texto "Estado de Cuenta" (evita
"Estado de Cuenta Póliza" y "Novedades Estado de Cuenta"). Implementado + cableado.

La exploración ahora extrae **datagrids** como filas estructuradas
(`datagrids[].headers` + `rows[].cells`) → el estado de cuenta debería salir ahí.

⚠️ OJO (a confirmar): la ficha Vigente (AMPARO INTEGRAL) trae Valor Canon $0 y
Periodo Adeudado 06/11/2024 (un día), mientras la BÁSICO/Desocupado tenía canon
real y periodo largo. Verificar cuál siniestro alimenta realmente el estado de
cuenta / la demanda antes de mapear los datos.

Correr (login → busca → abre Vigente → entra a Estado de Cuenta → explora):
```
cd sac_scripts
LIBERTADOR_EXPLORE=1 LIBERTADOR_SOLICITUD=6929878 HEADLESS=false node libertador_puppeteer.js
```

## Siguientes pasos

- [x] Pegar credenciales en `.env` y probar `libertador_puppeteer.js` (login real).
      ✅ Login headless confirmado (success:true, llega a /AgentWeb/). Sirve en Linux.
- [ ] Extender el worker: tras el login, navegar a la solicitud/deudor y LEER los
      datos financieros (canon, adm, abonos, fechas por mes) del SAC Oracle.
- [ ] Mapear esos datos → contrato de `generarEstadoCuenta` (ya definido).
- [ ] Confirmar versión canónica de la plantilla (la blanca tiene layout distinto a
      los diligenciados recientes) y el formato de salida.
- [ ] Recién entonces: armar la demanda de Libertador.

## 8. Poder de Conciliación — fuente de datos: DECLARACION DE PAGOS (verificado)

Decisión: el poder NO se llena con un Excel subido por el usuario. El programa
extrae los 6 campos de los documentos que YA están en la carpeta del caso
(Drive: DEMANDAS/LIBERTADOR/SINGULAR/<solicitud>).

Fuente única confirmada: **`DECLARACION DE PAGOS`** de cada caso (contiene los 6
campos del poder). Verificado en 3 casos (4755208, 11168927, 4755281); el
11168927 cruza EXACTO con la fila del Excel del poder (TAYRONA, MONICA…, 41765488,
NADJAR…, CL 20 3 39). Anclajes de extracción:

| Campo del poder | Anclaje en DECLARACION DE PAGOS |
|---|---|
| SOLICITUD | 1ª línea `póliza - solicitud` (tomar 2º número) |
| INMOBILIARIA | "representante legal de **X**," |
| REPRESENTANTE_LEGAL_INMOBILIARIA | nombre antes de ", mayor de edad" |
| IDENTIFICACION_REPRESENTANTE_LEGAL_INMOB | firma: tras el nombre, `CC/C.C./C.e. No.` (antes del NIT) |
| ARRENDATARIOS | "arrendatarios **X**." |
| DIRECCION_INMUEBLE_ | "inmueble: **X** ciudad" |

Formatos: la DECLARACION viene como .docx (digital) o .pdf; algunos PDF son
ESCANEADOS con OCR (CamScanner) → texto con ruido (`C.e.NO.`), riesgo residual en
dígitos → el extractor debe tolerar variantes y conviene mostrar los valores al
abogado para revisión.

El ESTADO DE CUENTA.xls tiene etiquetas POL:/SOLICITUD: pero pueden venir VACÍAS
(caso 4755208) → no es fuente confiable del número de solicitud.

Scripts de análisis (backend, usan la auth de Drive del backend):
- traer-poder-libertador.js  → baja plantillas del poder (conciliación/restitución)
- analizar-caso-libertador.js <caso> [--download] → lista/baja docs de un caso

Pendiente: escribir el extractor `declaracionPagos.js` (texto → 6 campos, tolerante
a OCR) + generador del Word combinado con generarPoderesCombinado y la plantilla
PLANTILLA PODER DE CONCILIACION.docx.

## 9. Extractor de la DECLARACION DE PAGOS — HECHO y verificado

Módulo: [`src/services/libertador/declaracionPagos.js`](../sac_scripts/src/services/libertador/declaracionPagos.js)
- `leerTexto(filePath)` → texto de .docx (adm-zip) o .pdf (pdf-parse); si el PDF NO
  trae capa de texto, cae a OCR (`ocr.js`: Tesseract por defecto / Vision si se activa).
- `parseDeclaracion(texto)` → { solicitud, poliza, inmobiliaria, representante,
  identificacion, arrendatarios, direccion, ciudad, faltantes } (regex tolerante a OCR).
- `aFieldMapPoder(campos)` → marcadores «...» de la plantilla del poder.

Probado en 3 casos (4755208 pdf digital, 11168927 docx, 4755281 pdf OCR): **6/6 campos
correctos** en los tres. Cruce 11168927 vs Excel del poder: idéntico salvo cosméticos
(sufijo "S.A.S" aplanado a "S A"; orden de nombres de arrendatarios reordenado a mano
en el Excel). El extractor devuelve lo que dice el documento fuente.

Pendiente: generador del Word combinado (`generarPoderesCombinado` + PLANTILLA PODER
DE CONCILIACION.docx) y el flujo que, dada una solicitud/lote, ubica la carpeta del
caso en Drive → encuentra la DECLARACION DE PAGOS → extrae → genera el poder.

## 10. Generador del Poder de Conciliación — HECHO y verificado

IMPORTANTE: a diferencia de Finandina (un Word combinado con todos los poderes),
Libertador genera un **Word INDIVIDUAL por caso**, guardado en **su propia carpeta**.

Módulo: [`src/services/libertador/poderes.js`](../sac_scripts/src/services/libertador/poderes.js)
- `generarPoderConciliacion(campos, plantillaBuf)` → Buffer del docx (reusa `comun/poderes.fillPoder`).
- `encontrarDeclaracion(carpetaCaso)` → ubica la DECLARACION DE PAGOS (excluye otras "declaraciones").
- `procesarCarpetaCaso(carpetaCaso, plantillaPath)` → extrae + genera + escribe
  `PODER DE CONCILIACION - <solicitud> - <inmobiliaria>.docx` en la MISMA carpeta.
- Nombre de archivo: `nombreArchivoPoder(campos)`.

Config: `PLANTILLA_PODER_LIBERTADOR_CONCILIACION` (config.js) → default junto a las
plantillas de demanda; overridable por `.env`.

Probado con el caso 4755208: docx generado con **0 marcadores «» sin rellenar** y los
6 campos correctos.

Pendiente: el flujo/endpoint que recibe qué casos procesar (lista de solicitudes o
lote de carpetas nuevas) y les pasa la carpeta a `procesarCarpetaCaso`. Además,
asegurar que la plantilla del poder esté disponible localmente (sync desde Drive,
como las demás plantillas).

## 11. Flujo de entrada por asignación (decidido) + endpoint del motor (HECHO)

Decisiones del usuario:
- Libertador NO lleva cédula → el item de asignación se identifica por SOLICITUD.
- El poder queda directo en la carpeta del caso.
- La UI de "agregar asignación" lleva un SELECTOR Finandina / Libertador (cambia el
  input: Excel para Finandina, lista de solicitudes para Libertador).
- Tipo = CONCILIACION. Sin modo escaneo por ahora (solo pegar solicitudes).

Endpoint del motor — HECHO y probado:
- `POST /generar-poder-libertador` ([src/routes/libertador.routes.js](../sac_scripts/src/routes/libertador.routes.js)):
  body { declaracionBase64, plantillaBase64?, solicitud? } → { success, campos,
  faltantes, fuente, nombreArchivo, poderBase64 }. Probado por HTTP (caso 4755281
  escaneado): 200, 6/6 campos, 0 marcadores sin rellenar.
- El motor también puede trabajar por filesystem: `procesarCarpetaCaso(carpeta, plantilla)`.

Pendiente (backend + frontend):
- Backend: endpoint para crear asignación Libertador por solicitudes; y la generación
  que por cada solicitud ubica la carpeta del caso, obtiene la DECLARACION DE PAGOS,
  llama al motor y deja el poder en la carpeta.
- Frontend: selector Finandina/Libertador en SubirAsignacionModal + textarea de solicitudes.

⚠️ DECISIÓN CLAVE PENDIENTE (NAS vs Drive): las carpetas de caso viven en el Drive de
la oficina (DEMANDAS/LIBERTADOR/SINGULAR/<sol>) y probablemente también en el NAS
\10.0.10.10 (mismo árbol "DOCUMENTOS ACTUALIZADOS 2019"). Si en producción el
servidor alcanza el NAS por filesystem, el motor procesa la carpeta directo
(procesarCarpetaCaso) — lo más simple. Si hay que ir por Drive API, el backend baja
la declaración y sube el poder (usando /generar-poder-libertador). Los nombres de
carpeta a veces traen sufijo de año (p. ej. "5761466 - 2025") y duplicados → la
resolución solicitud→carpeta necesita match por prefijo.

## 12. Flujo por asignación Libertador — CONSTRUIDO (motor + backend + frontend)

Decisión de infraestructura: los casos de Libertador viven SOLO en Drive → el
backend orquesta Drive; el motor solo procesa documentos.

MOTOR:
- `POST /generar-poder-libertador` (declaracionBase64 → poderBase64). Probado por HTTP.

BACKEND:
- [libertadorDrive.ts](../backend/src/infrastructure/storage/libertadorDrive.ts):
  `resolverCarpetaCaso(solicitud)` (match por prefijo + año más reciente),
  `bajarDeclaracionPagos(folderId)`, `bajarPlantillaConciliacion()`,
  `subirPoder(folderId, nombre, buf)`. Reusa auth/env de DriveStorage.
- `EngineService.generarPoderLibertador()` → llama al motor.
- `AsignacionController`:
  - `POST /api/asignaciones/libertador` (crearLibertador): crea asignación
    banco=LIBERTADOR, filas=[{SOLICITUD,TIPO:CONCILIACION}] (sin cédula, sin Excel).
  - `POST /api/asignaciones/:id/generar-poderes-libertador` (generarPoderesLibertador):
    por cada solicitud → Drive resuelve carpeta → baja DECLARACION DE PAGOS → motor →
    sube el poder a esa carpeta. Devuelve { generados, excluidos, resultados }.

FRONTEND:
- `SubirAsignacionModal`: selector Finandina/Libertador; en Libertador, textarea de
  números de solicitud (contador de solicitudes válidas) → `crearLibertador`.
- `asignacionApi.crearLibertador()` y `generarPoderesLibertador()`.

Estado: backend y frontend compilan (tsc --noEmit OK). Lógica de documentos probada
en 3 casos; navegación de Drive probada por los scripts. Falta la prueba viva
end-to-end (motor+backend+DB+Drive juntos) y un botón en la UI para disparar
`generarPoderesLibertador` sobre una asignación Libertador (hoy solo existe el API).

Nota: la plantilla del poder la baja el backend desde Drive (no requiere sync local).
