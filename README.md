# GrettyAI — Sistema de demandas ejecutivas singulares (J Ramos Abogados)

> Este README es también el **contexto para Claude Code**: si abres el repo en otro
> PC, léelo completo antes de tocar nada. Resume qué hace el proyecto, cómo está
> armado, el estado de la migración a Google Drive y qué falta.

## 1. Qué hace

Plataforma interna del bufete para **generar demandas ejecutivas singulares** de
cartera bancaria (hoy **FINANDINA**), de punta a punta:

1. Se sube/deja una **asignación** (Excel del banco con los deudores).
2. El **motor** (`sac_scripts`) scrapea el portal SAC (Puppeteer) + RUNT/Rama Judicial,
   descarga obligaciones/antecedentes y **genera** la demanda (.docx), los anexos y el
   poder, calculando cuantía y juzgado competente.
3. El **backend** persiste cada demanda como `Document`, la sirve en la web, permite
   **editarla** (SuperDoc) y **firmarla** (estampa firma → PDF con LibreOffice).
4. Todo el almacenamiento de documentos va a **Google Drive** (antes era un NAS).

## 2. Componentes

| Carpeta | Qué es | Stack | Puerto |
|---|---|---|---|
| `backend/` | API + lógica + persistencia | Node/TS, Express, Prisma (Postgres) | 3001 |
| `frontend/` | Web (SPA) | React + Vite | 5173 |
| `sac_scripts/` | **Motor**: scraping SAC + generación de docs | Node, Puppeteer | `SAC_PORT` |
| `scripts/drive-poc/` | Utilidades de Google Drive (POC, setup, migración) | Node | — |
| `docs/` | Diseño, bitácora, despliegue | Markdown | — |

El backend NO scrapea ni genera: llama al motor por HTTP (`ENGINE_BASE_URL`). El motor
corre en la misma máquina (camino "b": escribe en su disco y devuelve los archivos en
**base64 + relPath**; el backend los sube a Drive). n8n quedó como legado (reemplazado
por el motor).

### Arquitectura del backend (capas)
`presentation/` (controllers, routes) → `application/` (use-cases, contratos) →
`domain/` (entidades) → `infrastructure/` (prisma, storage, services).

### Modelo de datos (Prisma → Postgres)
`User`, `Document` (la demanda), `Asignacion` (el lote/Excel), `Poder`, `Observacion`
(clientes no generados y por qué), `DriveFile` (índice `relPath ↔ fileId` de Drive).

## 3. Almacenamiento: capa intercambiable NAS ↔ Google Drive

El código nunca sabe si escribe en disco o en Drive: usa la interfaz **`IStorage`** vía
la factory `storage` (`backend/src/infrastructure/storage/index.ts`), elegida por env
`STORAGE_DRIVER`:

- `STORAGE_DRIVER=nas` → **`FsStorage`** (disco/NAS local).
- `STORAGE_DRIVER=drive` → **`DriveStorage`** (Google Drive API).

Cada archivo se identifica por un `relPath` posix relativo a la **raíz** del storage
(`DOCS_DIR` en nas; `DRIVE_ROOT_FOLDER_ID` en drive). Mismo `relPath`, distinta raíz →
swap transparente.

### DriveStorage — dos modos de autenticación (`DRIVE_AUTH`)
- `delegation` (**producción**): service account + **delegación de dominio** que suplanta
  a `servidor@jramosabogados.com` (miembro de una **Unidad Compartida**). Escribe en la
  unidad del Workspace.
- `oauth` (**pruebas con Gmail personal**): OAuth (cliente de escritorio + refresh token),
  escribe en "Mi unidad" de la cuenta autorizada. Sin Workspace no hay Unidad Compartida.

Índice `relPath→fileId` en la tabla Prisma `DriveFile` (evita resolver por API cada vez).
`/docs/{relPath}` se sirve por **streaming** desde `storage` (`DocsController`, reemplazó
`express.static`). Es **público** a propósito (lo cargan `<iframe>`/`<a>`/SuperDoc sin JWT).

### Convención de carpetas (banco/año) — `infrastructure/storage/rutas.ts`
La raíz del storage es el **top** de la oficina (`DOCUMENTOS ACTUALIZADOS 2019`), con el
árbol completo dentro (espejo de `sac_scripts/src/config.js`):

```
DEMANDAS/{BANCO}/ASIGNACION/{AÑO}                    ← asignaciones (buzón de entrada)
DEMANDAS/{BANCO}/EJECUTIVAS SINGULARES/GARANTIAS     ← demandas generadas ({cedula}/...)
DEMANDAS/{BANCO}/EJECUTIVAS SINGULARES/PODERES       ← poderes
```

- **Leer** ("Actualizar asignaciones"): recorre `DEMANDAS/*/ASIGNACION/*/*.xlsx` — el
  **banco y el año salen de la carpeta** (no se adivinan). Importa los Excel nuevos
  (dedup por nombre), referenciándolos en su sitio.
- **Escribir** ("Subir asignación"): deriva banco (de `EMPRESA/NIT`) + año (de la fecha/
  nombre) → guarda en `DEMANDAS/{banco}/ASIGNACION/{año}/`.
- **Demandas del motor**: el `relPath` `{cedula}/...` se **prefija** con
  `carpetaGarantias(banco)` antes de subir a Drive. `metadata.demandaRelPath` guarda la
  ruta ya prefijada (firma/editor leen el sitio correcto).
- **SAC en Drive — Drive es la fuente de verdad** (`sacSync.ts`); el disco local
  (`DOCS_DIR`) es un caché EFÍMERO:
  - Al **descargar** el SAC: el motor lo deja en `DOCS_DIR/{cedula}/` y avisa por cédula
    (`POST /api/notifications/engine`, `type:'sac', meta.fase:'cedula'`). El backend lo
    **sube** a `GARANTIAS/{cedula}/` y **borra la copia local** (`subirSacDeCedula`).
  - El gate `tieneInfoSac` mira **Drive** (`GARANTIAS/{cedula}` tiene `SAC_*.pdf`).
  - Al **generar**: el backend **hidrata** de Drive a `DOCS_DIR/{cedula}/`
    (`hidratarCedula`) para que el motor lea los SAC del disco, y al terminar **borra la
    carpeta local** (`limpiarLocalCedula`, en `finally`).

## 4. Cómo correr (dev)

Requisitos: Node 18+, Postgres, LibreOffice (para firmar), y el motor.

```bash
# 1) Base de datos (Prisma)
cd backend && npm install && npx prisma generate && npx prisma migrate dev

# 2) Backend  → http://localhost:3001
cd backend && npm run dev

# 3) Frontend → http://localhost:5173
cd frontend && npm install && npm run dev

# 4) Motor (scraping + generación) → SAC_PORT
cd sac_scripts && npm install && node server.js
```

Login: si no hay usuario, `cd backend && npm run prisma:seed`.

## 5. Configuración (`backend/.env`)

> **Secretos (NUNCA en git, ya gitignored):** `DATABASE_URL`, `PASSWORD_ENC_KEY`,
> `ENGINE_NOTIFY_SECRET`, `backend/sa-key.json`, `scripts/drive-poc/token.json`,
> `scripts/drive-poc/oauth-credentials.json`. Consíguelos del password manager del equipo.

### Modo producción (Workspace, delegación de dominio) ← **modo actual**
```
STORAGE_DRIVER=drive
DRIVE_AUTH=delegation
DRIVE_SA_KEY=./sa-key.json
DRIVE_IMPERSONATE_USER=servidor@jramosabogados.com
DRIVE_ROOT_FOLDER_ID=1UawSt3PseEcjxRiEBmdI-NsUG-n7ZtEb   # "05 DOCUMENTOS ACTUALIZADOS 2019"
#DRIVE_SHARED_DRIVE_ID=0AA8hMZ5Qyvr9Uk9PVA               # a propósito SIN definir, ver abajo
DOCS_DIR=<carpeta de trabajo local del motor, p.ej. C:/SAC_Documentos>
ENGINE_BASE_URL=<url del motor>
```
- La service account (`gretty-backend@grettysia-drive-connection.iam.gserviceaccount.com`,
  Client ID `111992794330854899979`) debe estar autorizada en Admin console → Delegación
  de dominio, scope `https://www.googleapis.com/auth/drive`.
- ⚠️ **`DRIVE_SHARED_DRIVE_ID` va vacío.** La data real de la oficina vive en **"Mi unidad"
  de `servidor@`**; en la Unidad Compartida ("Servidor Compartido", `0AA8hMZ5Qyvr9Uk9PVA`)
  solo hay un **acceso directo** a la carpeta. Definirlo activa `corpora=drive` y acota las
  búsquedas al corpus de la unidad → no encontraría nada. Por eso `DriveStorage.findChild`
  **sigue los shortcuts** y `enabled` acepta `ROOT_FOLDER_ID` sin `SHARED_DRIVE_ID`.
- Estructura idéntica a la del NAS, relativa a esa raíz:
  `DEMANDAS/{banco}/ASIGNACION/{año}` y `DEMANDAS/{banco}/EJECUTIVAS SINGULARES/{GARANTIAS,PLANTILLAS,PODERES}`.
- Al **cambiar de cuenta/modo**, vaciar el índice (los `fileId` son por cuenta):
  `cd backend && echo "DELETE FROM drive_files;" | npx prisma db execute --stdin`

### Modo pruebas (Gmail personal, OAuth)
```
STORAGE_DRIVER=drive
DRIVE_AUTH=oauth
DRIVE_OAUTH_CRED=../scripts/drive-poc/oauth-credentials.json
DRIVE_OAUTH_TOKEN=../scripts/drive-poc/token.json
DRIVE_ROOT_FOLDER_ID=<carpeta de Mi unidad>
DOCS_DIR=<carpeta de salida del motor>
```
- Re-autorizar cuando el token expire (app OAuth en "Testing" → refresh token dura ~7
  días): `cd scripts/drive-poc && node poc-oauth.js`. O publicar la app OAuth a
  "Producción" para que no expire.

> `DOCS_DIR` en modo Drive ya NO sirve archivos: es el **scratch** del motor. El backend
> sube a Drive y borra local (`sacSync.ts`), y vuelve a bajar una copia justo antes de generar.

### Qué va en Drive y qué va en el disco del servidor (EC2)

**Drive = fuente de verdad** de todo lo que cambia por caso: asignaciones, `SAC_*.pdf`,
`CONTACTOS_*.csv`, pagarés (los suben a mano), demandas y poderes generados, firmados.

**Disco del servidor = inputs estáticos del motor + secretos + scratch.** El motor
(`sac_scripts`) es un proceso Node que solo sabe leer/escribir disco: no habla con la API
de Drive. En EC2 no hay Drive Desktop, así que sus inputs se despliegan **como assets
locales** (`sac_scripts/.env`):

| Var | Contenido | Origen en Drive |
|---|---|---|
| `PLANTILLA_SINGULAR` / `_DEMANDA` / `_PODER`, `SAC_FIRMA_PATH` | plantillas + `Firma.png` | `…/EJECUTIVAS SINGULARES/PLANTILLAS` |
| `ANEXOS_DEMANDAS` | ANEXO 4 (CCO J Ramos), ANEXO 5 (SIRNA) | `DEMANDAS/` (sueltos) |
| `ANEXOS_FINANDINA` | ANEXO 6 (SuperFinanciera), ANEXO 7 (CCO Finandina) | `DEMANDAS/FINANDINA/` (sueltos) |
| `ANEXOS_PODERES` | ANEXO 1 (correo de otorgamiento, respaldo) | `…/EJECUTIVAS SINGULARES/PODERES` |

⚠️ El motor elige **"el más reciente por `mtime`"** (`anexos.js: archivoMasReciente`). Al
bajarlos de Drive hay que **conservar la fecha** (`fs.utimesSync`); la migración masiva
dejó todos los `modifiedTime` iguales, así que conviene derivar la fecha del **nombre**
("10 DE JULIO DE 2026"). Solo mira `.pdf`.

## 6. Estado de la migración NAS → Drive

| Fase | Qué | Estado |
|---|---|---|
| F0 | Capa `IStorage` + Fs/Drive + factory | ✅ |
| F1 | Índice Prisma `DriveFile` | ✅ |
| F2 | Controllers usan `storage` (async); `NasStorage` eliminado; el motor sube outputs a Drive | ✅ (tsc; falta e2e con motor) |
| F3 | `/docs` por streaming (`DocsController`) | ✅ (probado offline) |
| Rutas | Ruteo por banco/año (`rutas.ts`) en leer/subir/demandas | ✅ (probado en Drive real: tree-walk + write) |
| SAC→Drive | Drive = fuente: subir+borrar-local al descargar, gate mira Drive, hidratar al generar, borrar local al terminar (`sacSync.ts`) | ✅ ciclo probado en Drive real; falta e2e con motor |
| OAuth | Modo cuenta personal en `DriveStorage` | ✅ (validado e2e contra Gmail) |
| Workspace | Delegación contra el Drive REAL de la oficina (shortcut + Mi unidad de `servidor@`) | ✅ list/save/read/delete validados |
| Assets motor | Plantillas, firma y anexos fuera del NAS → disco local, bajados de Drive | ✅ (falta el SIRNA) |

**Probado end-to-end en la app (modo oauth):** subir asignación → Drive; "Actualizar
asignaciones" → tree-walk importa por banco/año. **Falta** probar generar una demanda
completa (necesita el motor corriendo) para ver el prefijo GARANTIAS en vivo.

**Nota sobre los datos históricos:** las ~342 carpetas de cédula que ya existen traen
pantallazos manuales `__ SAC __ v6.0.02.pdf`. El motor **no** los usa: exige
`SAC_{cedula}_DIRYTEL.pdf` (`sac_puppeteer.js:209`). Por eso el gate de generación pide
`SAC_*.pdf` y marcará "falta info del SAC" en los casos viejos — es el comportamiento
correcto: hay que volver a descargar el SAC.

## 6.b Tipos de proceso

Una asignación trae clientes de varios procesos (columna "POSIBLE PROCESO"). Hoy el
sistema genera dos:

**Cada proceso tiene su PROPIO árbol** en Drive, con la misma forma (`GARANTIAS/{cédula}`,
`PODERES/{año}`, `PLANTILLAS`) — no se mezclan (`CARPETA_PROCESO` en `rutas.ts`):

```
DEMANDAS/{banco}/ASIGNACION/{año}            ← común: el Excel trae los procesos mezclados
DEMANDAS/{banco}/EJECUTIVAS SINGULARES/…     ← ejecutivo singular
DEMANDAS/{banco}/GARANTIA MOBILIARIAS/…      ← trámite de pago directo
```

| Proceso | Poder | Plantilla | Juzgado |
|---|---|---|---|
| **Ejecutivo singular** | `EJECUTIVAS SINGULARES/PODERES/{año}/PODERES EJECUTIVOS {lote}.docx` | `PLANTILLA PODER SINGULAR AI.docx` | por **cuantía** (capital+interés → Pequeñas Causas / Civil Municipal / Circuito) |
| **Trámite de pago directo** (garantía mobiliaria, Ley 1676/2013) | `GARANTIA MOBILIARIAS/PODERES/{año}/PODER PAGO DIRECTO {lote}.docx` | `PLANTILLA PODER BANCO FINANDINA PAGO DIRECTO.docx` | **sin cuantía**: `CIVIL MUNICIPAL`, o `PROMISCUO MUNICIPAL` donde la Rama no reporta civil |

- Se elige con `tipo: 'singular' | 'pago_directo'` en `POST /api/asignaciones/:id/generar-poderes`
  (y en `POST /generar-poderes` del motor). Por defecto `singular`.
- Marcadores del pago directo: `TIPO_DE_JUZGADO`, `CIUDAD_JUZGADO` (⚠️ sin "DE", distinto
  del singular), `DEMANDADO_1` (solo el nombre), `MARCA` (columna `GARANTIA` completa,
  p.ej. "CHEVROLET ONIX"), `MODELO` (año) y `PLACA`. Sin cuantía, obligaciones ni pagaré.
- Los dos conviven: `Poder.tipo` (`SINGULAR`/`PAGO_DIRECTO`) y columnas separadas
  `poderUrl` / `poderPagoDirectoUrl`. Regenerar un tipo NO borra el otro.
- ⚠️ La plantilla de pago directo venía de un **mail-merge de Word**: el motor aplana los
  `MERGEFIELD` y desactiva la combinación de correspondencia (`aplanarCamposWord` /
  `desactivarMailMerge` en `poderes.js`). Sin eso, Word re-evalúa los campos contra un
  origen de datos inexistente y borra los valores.
- Falta: la **demanda** (solicitud de aprehensión y entrega) de pago directo; hoy solo el poder.

## 6.c Nombres de las carpetas de cliente (GARANTIAS)

⚠️ La oficina **no** usa un solo formato. Lo que hay hoy en Drive:

| Formato | EJEC. SINGULARES | GARANTIA MOBILIARIAS |
|---|---|---|
| `98598830` (solo cédula) | 319 | 9 |
| `1143152167-AGOSTO 2026` ← **el nuevo** | 18 | 5 |
| `CC 9306310` | — | 110 |
| `92540211_2026`, `33114995_06_2026` (los crea el motor) | 13 | — |
| erratas: `15648165- AGOSTO 2026`, `1044800457-GOSTO 2026`, `CC 45754033-`, `CC 40932033+`, `8537096 - NOVIEMBRE` | 5 | 4 |

Por eso **nunca se busca la carpeta por nombre exacto**. `carpetasCedula.ts` la resuelve
por la cédula contenida en el nombre (primera corrida de 5–12 dígitos) e interpreta el
resto como fecha para saber cuál es la más reciente:

- `carpetasDeCedula(cedula, banco, proceso)` → todas las del cliente, más reciente primero.
- `carpetaDestino(…)` → dónde ESCRIBIR (la más reciente existente; si no hay, `{cedula}`).
- `relEnCarpetaCedula(relPathMotor, …)` → traduce el `{carpetaLocal}/archivo` que devuelve
  el motor a la carpeta real del cliente en Drive.

Se usa en el gate de generación (`insumosSac`), en `sacSync` (subir/hidratar) y al subir
los documentos que genera el motor. El motor hace lo mismo en disco
(`sac_scripts/src/utils/carpetas.js`), que acepta los mismos formatos.

> Sin esto, un cliente con carpeta `1143152167-AGOSTO 2026` daba **0 archivos**: el gate
> abortaba su demanda por "falta el pagaré" aunque el pagaré estuviera ahí.

## 6.d Notificaciones en vivo (SSE)

`GET /api/notifications/stream?token=JWT` → el navegador escucha con `EventSource`.
El motor avisa por `POST /api/notifications/engine` (secreto compartido) y el backend
retransmite.

⚠️ **La conexión puede quedar ZOMBI.** El proxy de desarrollo (Vite) mantiene el socket
del navegador ABIERTO aunque el backend se caiga o reinicie: `EventSource` nunca lanza
`onerror`, se queda en `readyState = OPEN`, la UI muestra "conectado"… y no vuelve a
llegar nada hasta recargar a mano. Verificado: 21 s con el backend muerto y el navegador
seguía en `OPEN(1)`, mientras el backend reportaba `clients: 0`.

Dos piezas lo resuelven, y **las dos son necesarias**:

1. **Backend** — el latido de 25 s va como MENSAJE (`data: {"type":"heartbeat"}`), no como
   comentario `: ping`. Los comentarios SSE no disparan `onmessage`, así que el cliente no
   podría distinguir "sin novedades" de "conexión muerta". No lleva `id` → el cliente no lo muestra.
2. **Frontend** (`NotificationContext.tsx`) — vigilante que rehace el canal si pasan 70 s sin
   recibir nada, más reconexión manual con espera creciente cuando `readyState === CLOSED`
   (el navegador NO reintenta si el servidor contesta algo distinto de `200 text/event-stream`,
   p. ej. el **502** del proxy de Vite mientras el backend reinicia).

> Al desarrollar, cada edición de un `.ts` del backend hace respawn de `ts-node-dev` y corta
> el canal — por eso esto aparecía tan seguido.

## 6.e Índice `drive_files` y borrados manuales

Drive no tiene rutas: cada archivo se ubica por `fileId`, y la tabla `drive_files`
guarda `relPath → fileId` para no resolverlo por API en cada acceso. El precio es que
el índice **no se entera de lo que alguien haga a mano en Drive**. Dos casos, los dos
ya cubiertos en `DriveStorage.save`:

| Lo que hace el usuario en Drive | Qué pasaba | Cómo se resuelve |
|---|---|---|
| Manda el archivo a la **papelera** | `files.update` escribía sobre el archivo borrado; nunca reaparecía (la UI y `list` filtran `trashed`) | el update va con `trashed: false` → lo revive |
| Lo **saca de la carpeta** (o lo borra de una carpeta compartida) | el archivo queda huérfano en la raíz ("Mi unidad"); el update escribía ahí y en la carpeta del cliente no aparecía nada | se piden los `parents` en la misma respuesta y, si no es el correcto, se reubica con `addParents`/`removeParents` |
| Vacía la papelera (borrado **definitivo**) | 404 | se borra la entrada del índice y se crea el archivo de nuevo |

> Síntoma típico: "borré los archivos y ahora no me los vuelve a guardar". Sí los guarda
> —con contenido nuevo y fecha nueva— pero fuera de la carpeta. Se ve mirando el `parents`
> del `fileId` que tenga el índice.

## 6.f Expedientes — visor de los documentos del cliente

Página `/expedientes`: se busca por cédula y muestra TODO lo que el cliente tiene en el
servidor (SAC, contactos, pagaré, DataCrédito, demanda, anexos), agrupado por la carpeta
real y etiquetado por tipo. PDFs e imágenes se previsualizan en la misma página (vía
`/docs`); lo demás se descarga.

**Por qué existe el botón de borrar aquí y no se usa Drive:** los archivos que sube el
sistema los posee `servidor@`, y la carpeta suele ser de otra persona. En "Mi unidad"
solo el DUEÑO puede mandar algo a la papelera, así que a un editor Drive únicamente le
ofrece *"Quitar de la vista"* — que no borra y encima deja el archivo huérfano fuera de
su carpeta. El backend actúa COMO `servidor@`, de modo que desde aquí el borrado sí es real.

La cédula va en la URL (`/expedientes?cedula=40939171`): recargar —o que Vite recargue el
módulo en desarrollo— no borra la búsqueda, y el enlace se puede compartir.

- `GET /api/expedientes/:cedula` → carpetas + archivos. Busca en los DOS procesos **en
  paralelo** (en serie tardaba ~15 s; así responde en <2 s).
- `DELETE /api/expedientes/:cedula/archivo` `{ relPath }` → borra.
  El `relPath` debe caer dentro de una carpeta DE ESA cédula; si no, 403 (probado con
  rutas de otra carpeta y con `../`).

## 7. Pendientes (TODO)

- [ ] **Generar demanda e2e** con el motor (validar prefijo GARANTIAS, firma y editor en Drive).
- [x] ~~**Poderes** aún se guardan en `_poderes/`~~: ya van a
      `DEMANDAS/{banco}/EJECUTIVAS SINGULARES/PODERES/{año}/{nombre}.docx` (helper `relPoder`),
      tanto al generarlos como al subirlos a mano. Validado e2e por la API.
      Queda por borrar la carpeta vieja `_poderes/` con los .docx de nombre cuid.
- [ ] **Multi-banco**: hoy solo FINANDINA. `detectarBanco` (rutas.ts) cae al default porque
      el Excel no trae columna de banco fiable (`EMPRESA` suele venir "------"). Para varios
      bancos: usar la carpeta (drop manual, ya funciona) o un **selector de banco al subir**.
- [x] ~~**Cambio a producción (Workspace)**~~: hecho — `.env` en `delegation`, índice
      `drive_files` vaciado, delegación validada contra el Drive real.
- [ ] **Falta el ANEXO 5 (SIRNA)**: no está suelto en `DEMANDAS/` (solo copias de
      `SIRNA OCTUBRE 2024.pdf` dentro de `DEMANDAS/GMAC/...`). Subir el certificado vigente a
      `DEMANDAS/` y volver a bajarlo, o el anexo sale como carátula sin PDF.
- [ ] **Anexos frescos en EC2**: hoy se copian a disco una vez y envejecen (los certificados
      se renuevan). Opción B: que el backend los **hidrate desde Drive** antes de llamar al
      motor (mismo patrón que `hidratarCedula`), conservando `mtime`.
- [ ] 🔒 **Seguridad**: el "Mi unidad" de `servidor@` tenía ~13 webshells (compromiso de un
      server viejo), en cuarentena `__REVISAR_SEGURIDAD__`. Revisar `dbcred.php` y **rotar las
      credenciales de BD** filtradas.
- [ ] Datos legacy (184 GB): están en Drive vía **accesos directos** (shortcuts) desde la
      Unidad Compartida; los datos reales siguen en "Mi unidad" de `servidor@` (riesgo si se
      borra esa cuenta). Migración real de carpetas = manual (la API no mueve carpetas a Shared Drive).

## 8. Utilidades de Drive (`scripts/drive-poc/`)

- `poc-oauth.js` — flujo OAuth loopback (genera `token.json`) para el modo pruebas.
- `poc.js` — POC service account.
- `ensure-root.js` — crea/encuentra una carpeta raíz en una Unidad Compartida.
- `move-to-shared.js` — reparent/cuarentena/shortcuts de "Mi unidad" → Unidad Compartida
  (modos `--shortcuts`, `--quarantine`, `--files-only`, `--go`). One-off, ya cumplió.

## 9. Docs relacionados

- `docs/DISENO-STORAGE-DRIVE.md` — diseño original de la capa storage.
- `docs/DEPLOY-PRODUCCION.md` — despliegue.
- `docs/BITACORA-2026-07-31.md` — bitácora de sesión.
- `docs/ROADMAP-AGENTE-Y-MICROSERVICIOS.md` — rumbo a futuro.
- `sac_scripts/ARQUITECTURA.md` — arquitectura del motor.
