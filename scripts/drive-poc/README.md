# POC Google Drive — consultar + modificar

Prueba mínima antes de migrar el almacenamiento del NAS a Google Drive.
Valida el mecanismo real de la migración (`docs/DISENO-STORAGE-DRIVE.md`):
**service account miembro de una Shared Drive**, sin domain-wide delegation.

El script (`poc.js`) hace: auth → **listar** archivos → **crear** un `.txt` de prueba →
**leer** su contenido → **sobrescribir** y volver a leer. Si termina en 🎉, consultar y
modificar funcionan.

---

## Requisito de cuenta

Necesitas **Google Workspace** (para tener *Unidades compartidas* / Shared Drives).
Con Workspace Business Standard el uso de la API es **$0 extra**.

> ¿Solo tienes Gmail personal (sin Shared Drives)? Los service accounts **no pueden
> subir** a "Mi unidad" (no tienen cuota propia). Avísame y te armo la variante con
> **OAuth** (tu propia cuenta) en vez de service account.

---

## Setup (una sola vez, ~10 min)

**1. Proyecto + API**
   1. Entra a <https://console.cloud.google.com> y crea (o elige) un proyecto.
   2. APIs y servicios → Biblioteca → busca **Google Drive API** → **Habilitar**.

**2. Service account + clave**
   1. APIs y servicios → Credenciales → **Crear credenciales** → **Cuenta de servicio**.
   2. Ponle nombre (ej. `gretty-drive`), crea. No hace falta darle roles de IAM.
   3. Abre la cuenta creada → pestaña **Claves** → **Agregar clave** → **Crear clave nueva**
      → tipo **JSON** → se descarga un archivo. Guárdalo como `sa-key.json` **dentro de
      esta carpeta** (`scripts/drive-poc/`). Anota el email de la cuenta
      (`...@...iam.gserviceaccount.com`).

**3. Shared Drive + permiso**
   1. En Google Drive crea una **Unidad compartida** (ej. `GRETTY-DOCS`).
   2. Ábrela → **Administrar miembros** → agrega el **email del service account** con rol
      **Administrador de contenido**.
   3. Copia el **ID** de la unidad desde la URL:
      `https://drive.google.com/drive/folders/`**`<ESTE_ID>`**

**4. Config**
   1. Copia `.env.example` a `.env`.
   2. Rellena:
      - `DRIVE_SA_KEY=./sa-key.json`
      - `DRIVE_SHARED_DRIVE_ID=<el ID del paso 3.3>`
      - `DRIVE_ROOT_FOLDER_ID=` (déjalo vacío para usar la raíz de la unidad)

---

## Correr

```bash
cd scripts/drive-poc
npm install     # solo la primera vez
node poc.js
```

Salida esperada: pasos 1→5 con ✅ y al final 🎉.
El archivo de prueba `poc-gretty-test.txt` queda en la unidad; puedes borrarlo.

---

## Seguridad

- **NO** subas `sa-key.json` ni `.env` a git (ya están en `.gitignore` de esta carpeta).
- La clave del service account da acceso a la Shared Drive: trátala como una contraseña.

---

## Variante OAuth — probar con cuenta personal (`poc-oauth.js`)

Para **probar YA con tu Gmail personal** (sin Workspace ni Shared Drives). Autoriza
con **tu propia cuenta** y valida crear/leer/sobrescribir en tu "Mi unidad".

> Solo valida que la **API de Drive** (consultar + modificar) funciona. **NO** valida
> el mecanismo de producción (service account + Shared Drive) — eso se prueba con
> `poc.js` cuando tengas el Workspace.

**Setup (una sola vez, ~5 min):**

1. **Proyecto + API** — igual que arriba: proyecto en Google Cloud + habilitar **Google Drive API**.
2. **Pantalla de consentimiento** — APIs y servicios → **Pantalla de consentimiento OAuth**
   → tipo **Externo** → rellena nombre de app y tu correo. En **Usuarios de prueba**
   agrega **tu propio Gmail** (el que vas a autorizar).
3. **OAuth client** — Credenciales → **Crear credenciales** → **ID de cliente de OAuth**
   → tipo de aplicación **App de escritorio** → crear → **Descargar JSON**. Guárdalo como
   `oauth-credentials.json` **dentro de esta carpeta** (`scripts/drive-poc/`).
4. **Correr:**
   ```bash
   cd scripts/drive-poc
   npm install        # solo la primera vez
   node poc-oauth.js
   ```
   Se abre el navegador → autorizas con tu cuenta (pantalla "app no verificada" →
   *Continuar*, es normal en modo prueba) → vuelve a la terminal. El token queda en
   `token.json` y se reutiliza en corridas siguientes.

**Secretos (ya en `.gitignore`):** `oauth-credentials.json`, `token.json`.
