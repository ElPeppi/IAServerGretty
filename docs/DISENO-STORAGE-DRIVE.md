# Diseño: capa de almacenamiento intercambiable (NAS ↔ Google Drive)

Diseño para migrar el almacenamiento de documentos de la **NAS** (filesystem) a
**Google Drive** (API), sin acoplar el resto del código a ninguno de los dos.
NO implementado — este doc + los esqueletos en `docs/diseno-storage-drive/` son la
referencia. Los `.ts` de esqueleto van a `backend/src/infrastructure/storage/`
cuando se cablee (e instalando `googleapis`).

## 1. Idea central

Todo archivo se identifica por un `relPath` = `"{cedula}/{nombre}"` (ya se usa así
hoy: el motor escribe en `SAC_OUT_DIR/{cedula}/...` y el backend referencia por ruta
relativa). Una interfaz `IStorage` traduce ese `relPath` a lo real:

- **FsStorage** → ruta de disco (la NAS de hoy).
- **DriveStorage** → `fileId` dentro de una *Shared Drive*.

El resto del código (controllers, SignedPdfService, editor) usa `IStorage` y nunca
sabe cuál está detrás. Se elige por env `STORAGE_DRIVER=nas|drive`.

## 2. Estado actual (de dónde partimos)

- **Backend** `NasStorage` (`saveBuffer`, `overwrite`, `urlForRelPath`,
  `relPathFromUrl`, `absFromRelPath`, `enabled`, `root`). Lo usan `GenerateController`,
  `SignedPdfService`, `DocumentController` (editor), `FileController`.
- **Servir `/docs`**: `express.static(DOCS_DIR)` sirve por ruta.
- **Motor** (`sac_scripts`): descomprime los ZIP y escribe inputs (pagaré, SAC,
  DataCrédito) en `SAC_OUT_DIR/{cedula}` con `fs`; ahí mismo genera los outputs
  (demanda, anexos, antecedentes) y además los **devuelve en base64** al backend
  (`construirDocumentos`).

Conclusión clave: **el motor puede correr 100% en disco local** (staging) y solo los
**outputs** (ya en base64) suben a Drive vía el backend. → El motor casi no cambia.

## 3. Interfaz `IStorage`

Ver `docs/diseno-storage-drive/IStorage.ts`. Métodos:

| Método | Uso |
|---|---|
| `save(relPath, data, mime?)` | crear o reemplazar (outputs, asignación, PDF firmado) |
| `overwrite(relPath, data)` | editor SuperDoc sobrescribe el .docx |
| `read(relPath)` | leer bytes (p. ej. el docx antes de firmar) |
| `stream(relPath)` | servir `/docs` sin cargar todo en memoria |
| `exists(relPath)` | validaciones |
| `urlFor(relPath)` | → `/docs/{cedula}/...` |
| `relPathFromUrl(url)` | URL guardada → relPath |
| `delete?(relPath)` | opcional |

`NasStorage` actual ≈ ya cumple esto → se renombra a `FsStorage implements IStorage`.

## 4. `DriveStorage` (googleapis)

Ver `docs/diseno-storage-drive/DriveStorage.ts`.

- **Auth:** service account (JWT) **miembro de la Shared Drive** con rol *Administrador
  de contenido* → **sin domain-wide delegation**. Scope `drive`. Todas las llamadas con
  `supportsAllDrives: true` y el `driveId` de la Shared Drive.
- **Resolver `relPath` → `fileId`:** partir por `/`; cada carpeta se busca
  (`files.list` por nombre+parent+mimeType=folder) o se crea; el último segmento es el
  archivo. Se cachea.
- `save`: resolver carpeta padre → buscar archivo por nombre → existe? `files.update`
  (media) : `files.create` (media + parents).
- `overwrite`: `files.update({ fileId, media })`.
- `stream`/`read`: `files.get({ fileId, alt: 'media' }, { responseType: 'stream' })`.

## 5. Índice `relPath ↔ fileId` (imprescindible)

Drive no tiene rutas; resolver por query cada vez es lento y gasta cuota. Tabla Prisma:

```prisma
model DriveFile {
  relPath   String   @id
  fileId    String
  updatedAt DateTime @updatedAt
  @@map("drive_files")
}
```

`DriveStorage` consulta el índice primero; si falta, resuelve por API y lo cachea.

## 6. Servir `/docs`

Reemplazar `express.static(DOCS_DIR)` por un controller:

```
GET /docs/*  → (authz)  → storage.stream(relPath) → pipe al response (+ Content-Type)
```

- `FsStorage`: lee de disco (igual que hoy).
- `DriveStorage`: baja de Drive y reenvía (proxy). ⚠️ Latencia: Drive no es LAN. Para
  documentos legales sensibles NO usar links públicos de Drive; servir por proxy con la
  auth del backend.

## 7. Factory / selección

Ver `docs/diseno-storage-drive/index.ts`.

```ts
export const storage: IStorage =
  process.env.STORAGE_DRIVER === 'drive' ? new DriveStorage() : new FsStorage();
```

Env nuevos: `STORAGE_DRIVER`, `DRIVE_SA_KEY` (ruta al JSON del service account),
`DRIVE_SHARED_DRIVE_ID`, `DRIVE_ROOT_FOLDER_ID`.

## 8. El motor (sac_scripts)

**Camino recomendado (b) — el backend es el único que habla con Drive:**

- El motor sigue en **filesystem local** (disco del EC2 como staging). `SAC_OUT_DIR`
  apunta a una carpeta local, no a la NAS.
- **Outputs:** el motor ya devuelve demanda/anexos/antecedentes en **base64**. El
  backend solo cambia `fileRef()` para hacer `storage.save(...)`. **Cero cambios en la
  generación del motor.**
- **Inputs (ZIP):** hoy el motor los recibe por HTTP y los descomprime en local → ya
  quedan en el staging local; no necesitan ir a Drive para que la generación funcione.
  Si se quiere **archivar** los inputs en Drive, el backend puede subirlos también (o el
  motor devolverlos), pero es opcional.

**Alternativa (a):** portar el motor a un `storage.js` espejo de `IStorage` (Drive en
JS). Solo si se quiere el motor 100% sin disco. Más trabajo.

## 9. Migración de datos (one-shot)

Script: recorrer la NAS, subir cada archivo a la Shared Drive, poblar `drive_files`.

## 10. Alcance del refactor

| Pieza | Cambio |
|---|---|
| `NasStorage` → `FsStorage` | renombre, implementa `IStorage` |
| `DriveStorage` | **nuevo** (~150 líneas) + `googleapis` |
| Índice `drive_files` | migración Prisma |
| `/docs` static → controller `stream` | medio |
| `GenerateController`, `SignedPdfService`, `DocumentController`, `FileController` | usan `storage` (la factory) |
| Motor | **0** para outputs (camino b); inputs solo si se quiere archivar |

## 11. Riesgos

- **Latencia** del proxy `/docs` (Drive no es LAN).
- **Consistencia** del índice `relPath↔fileId` (si alguien mueve/borra en Drive a mano).
- **Rate limits** de la API (mitiga el índice: menos queries).
- **Límites de Shared Drive:** ~400.000 ítems por unidad, ~750 GB/día de subida.

## 12. Ventaja operativa

Con Drive API se elimina la dependencia **VPN + montar la NAS** en el EC2 (WireGuard,
SMB sobre VPN). El servidor habla con Drive por internet. Menos piezas de red, aunque
el cómputo pesado (Puppeteer, OCR, LibreOffice) no cambia. Con Google Workspace Business
Standard el costo es **$0 extra** (API gratis, storage 2 TB pooled ya incluido).
