# Traspaso de trabajo — GrettyAI Legal

_Estado al 22 de septiembre de 2026. Rama: `main`._

Documento para retomar el trabajo en otro PC. Cubre: qué quedó hecho, qué falta,
cómo dejar el otro equipo listo, y las cosas abiertas.

---

## 1. Lo primero al llegar al otro PC

1. **Pushear lo pendiente** (desde el PC actual, o ver §2):
   ```bash
   git push origin main
   ```
2. En el otro PC: `git pull`, y luego instalar dependencias en los tres módulos:
   ```bash
   cd backend      && npm ci && npx prisma generate
   cd ../frontend  && npm ci
   cd ../sac_scripts && npm ci
   ```
3. **Secretos (NO están en git, copiarlos aparte por USB/gestor seguro):**
   - `backend/.env` (Drive: `DRIVE_SA_KEY`, `DRIVE_IMPERSONATE_USER`, `DRIVE_ROOT_FOLDER_ID`, `STORAGE_DRIVER=drive`; `DATABASE_URL`)
   - `backend/sa-key.json` (llave del service account de Drive)
   - `sac_scripts/.env`
   - Ojo: `backend/_descargas/` contiene documentos reales de deudores (gitignored). No copiar salvo que se necesite.

---

## 2. Commits pendientes de push (2)

| Commit | Qué arregla |
|--------|-------------|
| `ae78b5e` | **Demanda .docx corrupta** — quita las fuentes embebidas de la plantilla de pago directo (causaban "Word encontró contenido no legible"). 3.1MB → 0.09MB. |
| `6066313` | **Poderes del ANEXO 1** — garantías ahora genera el `PODER *.docx` individual por cliente, y `fillPoder` limpia el bit 3 (data descriptor) del zip para que se pueda re-leer. |

Verificar con: `git log origin/main..HEAD --oneline`

**Tras el push + deploy, PROBAR:** regenerar un caso de garantía mobiliaria (ej. ALEX
72166331 o CARLOS MAURICIO 72217378) y confirmar:
- La **demanda .docx** abre en Word **sin** el aviso de recuperación.
- El **ANEXO 1** muestra el correo del banco **con el poder sobrepuesto**.

---

## 3. Qué se hizo esta sesión (contexto)

Todo gira en torno al **trámite de PAGO DIRECTO / garantía mobiliaria** de Finandina,
que antes no generaba. Cadena de arreglos (los primeros ya están en `origin/main`):

**Almacenamiento / SAC**
- `ad35e5a` — El SAC de pago directo ahora cae en el árbol `GARANTIA MOBILIARIAS`
  (antes siempre en `EJECUTIVAS SINGULARES`). El árbol lo decide el backend al subir;
  el motor propaga `proceso` en el aviso SSE y `notificationRoutes` lo usa.
- `bff8f01` — Detección del SAC: `/\bSAC\b/` no reconocía `SAC_123...` (el `_` rompe la
  frontera de palabra). Nuevo regex `/(?:^|[^A-Z])SAC(?:[^A-Z]|$)/`.
- **Movimiento de datos (una vez, ya hecho):** se movieron 90 archivos SAC (29 cédulas)
  del árbol singular al de garantía mobiliaria en Drive. Scripts: `backend/mover-sac-pago-directo.js`
  (dry-run por defecto, `--apply` para ejecutar) y `backend/verificar-mover.js`.

**Fuente de datos del vehículo (CTL / RUNT)** — commit `f97a685` (mensaje "fddd")
- Prioridad: **CTL** (certificado de tradición) si está → si no, **RUNT** de la carpeta →
  si no hay ninguno, intenta **bajar el RUNT** del portal (`runt.js`, best-effort: captcha
  por OCR + rate-limit, solo si el RUNT es lo único que falta).
- Parser nuevo del CTL en `extraccion.js` (emparejado por geometría de fragmentos).
- Si hay CTL, el RUNT deja de ser obligatorio (`documentos.js`).

**Documentos generados**
- `1bbd15f` — Sube el `ANEXOS.pdf` a Drive (antes se generaba local y se perdía).
- `2e167b4` — Genera y sube el `ANTECEDENTES.pdf` (SAC direcciones + obligaciones).
- `ae78b5e` — (pendiente) quita fuentes embebidas → demanda no corrupta.
- `6066313` — (pendiente) poder individual + fix de re-lectura del zip.

**Regeneración y UI**
- `6a383ac` — "Regenerar" de un pago directo usa el motor de garantías (antes usaba el
  singular y rechazaba la cédula con "no está en el Excel").
- `3316107` — Opción **"Regenerar también las ya generadas"** en el modal de generar demandas.

**Frontend / infra**
- `145cba4` — Pantalla en blanco tras deploy: `main.tsx` escucha `vite:preloadError` y
  autorecarga una vez cuando un chunk queda obsoleto (mitigación; ver §4 para el fix de raíz).

---

## 4. Cosas abiertas / pendientes

- **[Raíz del "pantalla en blanco"]** El fix real es en **Nginx del servidor** (no está en el
  repo): servir `index.html` con `no-cache` y los assets hasheados como `immutable`:
  ```nginx
  location = /index.html { add_header Cache-Control "no-cache"; }
  location /assets/     { add_header Cache-Control "public, max-age=31536000, immutable"; }
  location /            { try_files $uri /index.html; }
  ```

- **[Casos omitidos por OCR]** Algunos casos (ej. TATIANA ZAYAZ, CARLOS VILLALBA MOJICA) se
  omiten con "no se pudo leer: fecha de suscripción del contrato de prenda / monto garantizado".
  Esos dos datos salen por **OCR del contrato de prenda** (`extraccion.js`). Falta revisar si es
  escaneo ilegible (re-escanear) o redacción que el regex no cubre. Anclas: fecha por el parser
  de pagaré; monto por la frase *"asciende a la suma de …"*.

- **[RUNT faltante]** Para algunos casos no existe el RUNT en ningún lado (hay que conseguirlo).
  La auto-descarga por `runt.js` es best-effort (falla en varios por captcha/rate-limit).

- **[Scripts sin versionar]** En `backend/` quedaron utilidades de diagnóstico sin commitear:
  `mover-sac-pago-directo.js`, `verificar-mover.js`, `diag-sac-alex.js`, `diag-docx.js`.
  Decidir si borrarlos o versionarlos. También `scripts/drive-poc/.gitignore` tiene un cambio
  suelto (agrega `token.json.bak`) sin relación.

- **[Cosmético]** El commit `f97a685` quedó con mensaje "fddd". Ya está pusheado; renombrarlo
  reescribe historia pública, no vale la pena.

---

## 5. Arquitectura rápida (recordatorio)

- **Drive es la fuente de verdad**; el disco del motor es caché efímero. El backend hidrata
  (Drive→local) antes de generar y limpia después.
- Árbol: `DEMANDAS/{banco}/{proceso}/GARANTIAS/{cédula}` con
  `{proceso}` = `EJECUTIVAS SINGULARES` (singular) o `GARANTIA MOBILIARIAS` (pago directo).
- Motor (`sac_scripts`, puerto 3456) genera; backend (3001) orquesta y sube a Drive; frontend
  (Vite) consume. Prod: Nginx sirve `frontend/dist`, pm2 corre `gretty-backend` y `gretty-motor`,
  deploy con `scripts/deploy.sh` (push a `main` → GitHub Actions).
