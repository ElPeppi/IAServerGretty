# GrettyAI — Arquitectura del monorepo

Repo único con tres piezas que se despliegan juntas (objetivo: AWS).

```
IAServerGretty/
├── frontend/     Página web (React + Vite). Login, dashboard, lista y VISOR de demandas.
├── backend/      API/orquestador (Express + Prisma + PostgreSQL). Auth, documentos, notas.
├── sac_scripts/  MOTOR de generación (Node). Lee Excel + ZIPs, consulta SAC/RUNT/RUES/Rama,
│                 produce la demanda Word + ANEXOS.pdf + ANTECEDENTES.pdf y las NOTAS.
└── workflow_*.json, "workflow n8n emailrecived"/   Flujos n8n (correo entrante con adjuntos).
```

## Flujo de una demanda

1. **Frontend** sube Excel (+ correo del poder + ZIPs) → `POST /api/generate/...` del **backend**.
2. **Backend** llama al **motor** (`sac_scripts`, `POST /generar-singular`) — reemplaza la antigua
   llamada a n8n (`N8nService` → `EngineService`).
3. **Motor** devuelve, por cliente: `{ demanda, anexos, antecedentes, asignacion, notas }`.
4. **Backend** crea un `Document` + sus archivos (assets) + las `notas` (procedencia/faltantes),
   y guarda los archivos en `backend/uploads/` (servidos en `/uploads`). Más adelante → S3.
5. **Frontend (visor)**: al seleccionar una demanda, IZQUIERDA = la demanda; DERECHA = anexos,
   antecedentes y la asignación de la que salió, más las notas.

## Decisiones tomadas

- **Monorepo** dentro de IAServerGretty. ✅
- **Motor como servicio aparte**: el backend lo invoca por HTTP. El motor pesado (puppeteer/OCR)
  queda aislado del API. (Recomendado; pendiente de confirmar.)
- **Almacenamiento**: carpeta local del servidor (`backend/uploads`) para empezar; migrar a S3 luego.

## Notas de procedencia (ya implementadas en el motor)

`sac_scripts` acumula notas por cliente y las devuelve en `result.clientes[].notas`
(`{ campo, nivel: 'info'|'warning', mensaje }`). Cubren: fuente de la dirección, Cámara de
Comercio del empleador faltante (RUES), placas sin RUNT, correo de juzgado no hallado,
localidad de Barranquilla no determinada, y poder faltante en los anexos.

## Estado

- [x] Motor: `/generar-singular` devuelve `documentos[]` con los archivos (base64) + `notas` por cliente.
- [x] Backend: `EngineService` (llama al motor) + `FileStorage` (guarda en `uploads/`, listo para S3).
- [x] Backend: modelo `Document` extendido (`anexosUrl`, `antecedentesUrl`, `asignacionUrl`, `poderUrl`,
      `notes`, `clientCedula`) + migración Prisma.
- [x] Backend: endpoint `POST /api/generate/singular` (Excel + correoPoder) que crea un `Document` por cliente.
- [x] Frontend: tipo `Document` + API `generateApi.singular` + **visor de 2 paneles**
      (demanda izq · anexos/antecedentes/asignación/notas der) + correoPoder en el modal.
- [ ] Deploy AWS: definir cómo llegan los documentos SAC/DECEVAL al motor (hoy carpeta de red).
- [ ] `docker-compose` unificado (frontend + backend + motor + postgres + n8n).

## Cómo correrlo (local)

```bash
# 1. Motor (sac_scripts) — puerto 3456
cd sac_scripts && npm install && node server.js

# 2. Backend — puerto 3001
cd backend && npm install
cp .env.example .env            # ajustar DATABASE_URL, ENGINE_BASE_URL, BASE_URL
npx prisma migrate dev          # aplica los nuevos campos y regenera el cliente Prisma
npm run dev

# 3. Frontend — puerto 5173
cd frontend && npm install && npm run dev
```

> Tras cambiar el schema hay que correr `prisma migrate dev` (o `prisma generate`) para que el
> cliente Prisma conozca los campos nuevos; si no, el backend no compila.

## Escalabilidad (320 demandas hoy, creciendo gradual)

- ✅ **PostgreSQL** maneja millones de filas; 320 → miles es trivial.
- ✅ **Índices** en `documents` (`lawyerId+createdAt`, `status`, `clientCedula`, `createdAt`) para que
  filtros y orden no se degraden al crecer.
- ✅ **Paginación + búsqueda** en `GET /documents` (server-side): `?search=&page=&pageSize=` →
  `{ items, total, page, pageSize }`. La lista pagina de a 24 y busca por nombre/cédula/título/RFC
  en la base (con debounce en el front). Ya no carga todo de una.
- ⏭️ **Lotes muy grandes de generación**: el motor devuelve los archivos en base64 en una sola
  respuesta. Para lotes normales (decenas) va bien; para cientos de una sola vez, conviene que el
  motor suba cada archivo (a la NAS/S3) y devuelva solo URLs.
- ✅ **Almacenamiento** en la NAS crece lineal; si el servir por VPN se siente lento, S3+CDN para la web.

## Gestión de la base de datos (demandas)

```bash
cd backend
npm run db:clear                         # borra documentos de PRUEBA (seed/example.com)
CLEAR_ALL=1 npm run db:clear             # borra TODOS los documentos
DOCS_DIR="/mnt/compartida/.../GARANTIAS" npm run db:import-docs   # importa demandas ya generadas en la NAS
```

- Las demandas **nuevas** aparecen solas al generarlas desde la página (`/generate/singular`).
- Las **ya generadas** en la NAS se ven importándolas con `db:import-docs`. El backend las sirve
  desde `/docs` (requiere la variable `DOCS_DIR` apuntando a la carpeta de la NAS).
- Nota: el **.docx** se previsualiza con el visor de Office, que necesita una **URL pública**
  (en `localhost` no renderiza, pero "Abrir/descargar" sí funciona; los PDF de anexos/antecedentes
  se ven siempre).
```
