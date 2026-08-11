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

### Modo producción (Workspace, Unidad Compartida)
```
STORAGE_DRIVER=drive
DRIVE_AUTH=delegation
DRIVE_SA_KEY=./sa-key.json
DRIVE_IMPERSONATE_USER=servidor@jramosabogados.com
DRIVE_SHARED_DRIVE_ID=0AA8hMZ5Qyvr9Uk9PVA
DRIVE_ROOT_FOLDER_ID=<carpeta raíz de la oficina dentro de la unidad>
DOCS_DIR=<carpeta de salida del motor en disco, p.ej. .../GARANTIAS>   # solo para el gate SAC
ENGINE_BASE_URL=<url del motor>
```
- La service account (`gretty-backend@grettysia-drive-connection.iam.gserviceaccount.com`,
  Client ID `111992794330854899979`) debe estar autorizada en Admin console → Delegación
  de dominio, scope `https://www.googleapis.com/auth/drive`.
- `servidor@` debe ser **Administrador de contenido** de la Unidad Compartida.

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

> `DOCS_DIR` en modo Drive ya NO sirve archivos; solo lo usa el gate "info SAC"
> (`tieneInfoSac`) para verificar en el disco del motor que se descargaron los `SAC_*.pdf`.

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

**Probado end-to-end en la app (modo oauth):** subir asignación → Drive; "Actualizar
asignaciones" → tree-walk importa por banco/año. **Falta** probar generar una demanda
completa (necesita el motor corriendo) para ver el prefijo GARANTIAS en vivo.

## 7. Pendientes (TODO)

- [ ] **Generar demanda e2e** con el motor (validar prefijo GARANTIAS, firma y editor en Drive).
- [ ] **Poderes** aún se guardan en `_poderes/`; ruteardos a `DEMANDAS/{banco}/EJECUTIVAS SINGULARES/PODERES/{año}`.
- [ ] **Multi-banco**: hoy solo FINANDINA. `detectarBanco` (rutas.ts) cae al default porque
      el Excel no trae columna de banco fiable (`EMPRESA` suele venir "------"). Para varios
      bancos: usar la carpeta (drop manual, ya funciona) o un **selector de banco al subir**.
- [ ] **Cambio a producción (Workspace)**: (1) `.env` a modo `delegation`; (2) **limpiar el
      índice** `DELETE FROM drive_files;` (los fileId de pruebas apuntan a Drive personal);
      (3) verificar permisos de `servidor@` en la Unidad Compartida. Ver §5.
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
