# Deploy a producción — GrettyAI (paso a paso)

Tres piezas: **frontend** (estático, Vite), **backend** (Node/Express + PostgreSQL + Prisma, puerto 3001) y **motor** (`sac_scripts`, Puppeteer + LibreOffice, puerto 3456). Fuente única de documentos: el **NAS `\\10.0.10.10`**.

## 0. Decisión de arquitectura (léelo primero)

**Destino elegido: AWS EC2.** Razón: el NAS se va a **migrar a Google Drive** más adelante (ver `docs/DISENO-STORAGE-DRIVE.md` y los skeletons de storage). Una vez en Drive, el almacenamiento es cloud y **la VPN al NAS desaparece** — el EC2 queda 100% cloud-native. Por eso AWS es la ruta correcta a futuro, aunque hoy el NAS siga en la oficina.

El **motor** y el **backend** necesitan acceso a los documentos (demandas, poderes, asignaciones, firma), además de **Chrome (Puppeteer)**, **LibreOffice** (docx→pdf) y salida a internet para el **SAC**.

Fases:
- **Hoy (NAS en la oficina)** → el EC2 alcanza el NAS por **VPN (OpenVPN)**; ver §8 (EC2) + §8-bis (OpenVPN). Es una medida **interina**.
- **Después (NAS → Google Drive)** → se cablea `DriveStorage` (skeleton ya existe), `DOCS_DIR`/`SAC_OUT_DIR` dejan de apuntar al NAS, y **se elimina la VPN**. Sin cambios en el resto del deploy (EC2, Nginx, PM2, DNS, CI/CD siguen igual).

> **Ruta principal de este runbook: AWS.** Empieza en **§8 (EC2)** para el provisioning, y usa §1–§7 para los pasos comunes (env, DB, build, PM2, Nginx, DNS) que aplican igual sobre el EC2.
>
> Alternativa on-premise (servidor en la LAN del NAS, sin VPN, expuesto por Cloudflare Tunnel): válida si algún día se quiere, pero **no es el plan** dado que se va a Drive.

---

## 1. Servidor (una vez)

En el equipo que será el servidor (misma red que el NAS):

- **Node.js LTS** (v20+).
- **PostgreSQL 15+** (o el que ya usen; la DB se llama `legaldb`).
- **LibreOffice** (ya instalado en el equipo actual: `soffice`).
- **Google Chrome / Chromium** (para Puppeteer).
- **Acceso al NAS**: la ruta `\\10.0.10.10\compartida\...` debe estar accesible (en Windows, con credenciales guardadas; en Linux, montada por `cifs`).
- **PM2** para mantener los procesos vivos: `npm i -g pm2`.
- **Nginx** (reverse proxy + servir el frontend).

---

## 2. Variables de entorno

### backend/.env
```env
DATABASE_URL="postgresql://postgres:PASSWORD@localhost:5432/legaldb"
PORT=3001
NODE_ENV=production

# Dominio público (para armar URLs y CORS)
BASE_URL=https://tudominio.com
FRONTEND_URL=https://tudominio.com

# NAS: DEBE ser la MISMA carpeta que SAC_OUT_DIR del motor
DOCS_DIR=\\10.0.10.10\compartida\DOCUMENTOS ACTUALIZADOS 2019\DEMANDAS\FINANDINA\EJECUTIVAS SINGULARES\GARANTIAS

# Motor
ENGINE_BASE_URL=http://localhost:3456
ENGINE_TIMEOUT_MS=3600000

# Carpeta de los Excel de asignación (para el botón "Actualizar asignaciones")
ASIGNACIONES_DIR=\\10.0.10.10\compartida\...\ASIGNACIONES

# Firma del abogado (PNG)
FIRMA_PATH=\\10.0.10.10\compartida\...\PLANTILLAS\Firma.png

# Notificaciones SSE motor→backend (mismo secreto en ambos)
ENGINE_NOTIFY_SECRET=un-secreto-largo
```

### sac_scripts/.env
```env
SAC_PORT=3456
SAC_OUT_DIR=\\10.0.10.10\compartida\...\EJECUTIVAS SINGULARES\GARANTIAS
SAC_TEMP_DIR=C:/temp/sac_temp

# Credenciales SAC
SAC_URL=https://servicios.bancofinandina.com/Sac
SAC_USER=usuario
SAC_PASS=clave

# Plantillas y anexos (por defecto apuntan al NAS; sobreescribir si cambian)
# PLANTILLA_PODER, PLANTILLA_DEMANDA, ANEXOS_PODERES, etc.

# Notificaciones al backend (mismo secreto que ENGINE_NOTIFY_SECRET)
SAC_NOTIFY_URL=http://localhost:3001/api/notifications/engine
SAC_NOTIFY_SECRET=un-secreto-largo
```

> `DOCS_DIR` (backend) y `SAC_OUT_DIR` (motor) **deben ser idénticos**.

---

## 3. Base de datos

```bash
cd backend
npm ci
npx prisma migrate deploy      # aplica TODAS las migraciones (incluye asignaciones/poderes)
npx prisma generate
# Primer arranque: crear el usuario admin real (NO dejar el seed de pruebas en prod)
```

---

## 4. Build

```bash
# Frontend → genera frontend/dist (estático)
cd frontend && npm ci && npm run build

# Backend → compila a backend/dist
cd ../backend && npm run build

# Motor: no compila (JS puro)
cd ../sac_scripts && npm ci
```

---

## 5. Levantar backend + motor con PM2

```bash
# desde backend/
pm2 start dist/main.js --name gretty-backend

# desde sac_scripts/  (entrypoint = server.js, según package.json "start")
pm2 start server.js --name gretty-motor

pm2 save
pm2 startup     # que arranquen al reiniciar el equipo
```

---

## 6. Nginx (servir frontend + proxy API + SSE)

`/etc/nginx/sites-available/gretty` (Linux) o `nginx.conf` (Windows):

```nginx
server {
    listen 80;
    server_name tudominio.com www.tudominio.com;

    # Frontend estático (Vite dist)
    root  /ruta/a/frontend/dist;
    index index.html;

    # SPA: todo lo que no sea archivo → index.html
    location / {
        try_files $uri $uri/ /index.html;
    }

    # API
    location /api/ {
        proxy_pass http://localhost:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    # Documentos servidos desde el NAS por el backend
    location /docs/ {
        proxy_pass http://localhost:3001;
        proxy_set_header Host $host;
    }

    # SSE (notificaciones en vivo) — SIN buffering y timeout largo
    location /api/notifications/stream {
        proxy_pass http://localhost:3001;
        proxy_set_header Host $host;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
    }

    client_max_body_size 50m;   # subir Excel/Word grandes
}
```

Recargar: `nginx -t && nginx -s reload`.

---

## 7. Dominio GoDaddy + HTTPS

Dos formas:

### 7A. Cloudflare Tunnel (recomendado — sin abrir puertos, HTTPS gratis)
1. Crear cuenta Cloudflare (gratis) y **añadir el dominio**.
2. En **GoDaddy → DNS → Nameservers**, cambiar a los que da Cloudflare (propagación horas).
3. En el servidor: instalar `cloudflared`, `cloudflared tunnel login`, `cloudflared tunnel create gretty`.
4. `config.yml` del túnel: ingress `tudominio.com` → `http://localhost:80` (Nginx).
5. `cloudflared tunnel route dns gretty tudominio.com` y correr `cloudflared tunnel run gretty` (como servicio).
   → HTTPS lo pone Cloudflare, no hace falta Certbot ni abrir el router.

### 7B. Port-forward + Certbot (el dominio se queda en GoDaddy)
1. IP pública **fija** en la oficina (o DDNS).
2. Router: reenviar **80 y 443** al servidor.
3. **GoDaddy → DNS**: `A @ → IP_publica`, `A www → IP_publica`.
4. En el servidor: `certbot --nginx -d tudominio.com -d www.tudominio.com` → HTTPS.

---

## 8. Variante AWS EC2 (solo si no hay servidor en la oficina)

1. EC2 (t3.small/medium, Ubuntu). Elastic IP.
2. Instalar Node, Postgres, **LibreOffice**, **Chromium**, PM2, Nginx (igual que arriba).
3. **VPN al NAS**: WireGuard entre el EC2 y la oficina → montar `\\10.0.10.10` por `cifs` sobre la VPN. `DOCS_DIR`/`SAC_OUT_DIR` = ese montaje.
4. Security Group: abrir **80 y 443** (NO 3001/3456).
5. **GoDaddy → DNS**: `A @ → Elastic IP`, `A www → Elastic IP`.
6. `certbot --nginx` para HTTPS.
7. Resto (build, migrate, pm2, nginx) idéntico a las secciones 3–6.

> Contras AWS: la VPN al NAS es el punto frágil y añade latencia a cada lectura/escritura de documentos; el motor (Puppeteer + LibreOffice) es pesado. Por eso on-premise es preferible.

---

## 8-bis. VPN al NAS con OpenVPN

1. **Servidor OpenVPN** en la oficina (en el router si lo soporta, o en un equipo/mini-PC de la LAN).
2. **Cliente OpenVPN** en el EC2 → se conecta al servidor de la oficina y **enruta `10.0.10.0/24`** por el túnel.
3. Montar el NAS **solo sobre el túnel** (Linux `cifs`):
   ```
   //10.0.10.10/compartida  /mnt/nas  cifs  credentials=/etc/nas.cred,uid=appuser,iocharset=utf8  0  0
   ```
   `DOCS_DIR`/`SAC_OUT_DIR` apuntan a `/mnt/nas/...`.
4. **El puerto 445 (SMB) NUNCA se abre a internet** — solo viaja dentro del túnel OpenVPN.
5. Que el cliente OpenVPN arranque como servicio (systemd) y reconecte solo.

---

## 9. Actualizar producción (cuando cambie código o DB)

Todo el proyecto está en git. El flujo es **git pull → rebuild → migraciones → reiniciar**. Un solo script lo hace ([scripts/deploy.sh](../scripts/deploy.sh)):

```bash
cd /ruta/IAServerGretty && ./scripts/deploy.sh
```

Qué hace cada cambio:

| Cambio | Qué corre el script | Efecto |
|---|---|---|
| **Frontend** (React/Vite) | `npm ci && npm run build` en `frontend/` | Nginx sirve el nuevo `frontend/dist` al instante (Vite pone hash en los archivos → sin caché vieja) |
| **Backend** (TS) | `npm ci && npm run build` + `pm2 restart gretty-backend` | Backend nuevo en segundos |
| **Motor** (`sac_scripts`) | `npm ci` + `pm2 restart gretty-motor` | Motor nuevo |
| **Base de datos** (schema Prisma) | `npx prisma migrate deploy` | Aplica SOLO las migraciones nuevas (idempotente, no borra datos) |

### Regla de oro con la base de datos
- **En tu PC** (desarrollo): cambias `schema.prisma` → `npx prisma migrate dev --name descripcion`. Eso crea el SQL en `prisma/migrations/`. **Haces commit de esa carpeta** y push.
- **En el servidor**: `git pull` + `npx prisma migrate deploy`. **NUNCA** corras `migrate dev` en producción (puede resetear datos). `deploy` solo aplica lo pendiente.
- Antes de una migración grande: `pg_dump` de respaldo (el script lo hace).

### Opcional: deploy automático con GitHub Actions
Un workflow que, al hacer push a `main`, entra por SSH (o SSM) al EC2 y corre `./scripts/deploy.sh`. Cero comandos manuales. (Puedo armártelo si quieres.)

---

## 10. Checklist final

- [ ] `prisma migrate deploy` corrido en prod.
- [ ] Usuario admin **real** creado; borrado el usuario seed (`admin@legaloffice.com`).
- [ ] `DOCS_DIR` == `SAC_OUT_DIR` y el NAS accesible desde el servidor.
- [ ] `ASIGNACIONES_DIR` apunta a la carpeta de los Excel de asignación.
- [ ] `FIRMA_PATH` válido.
- [ ] `ENGINE_NOTIFY_SECRET` == `SAC_NOTIFY_SECRET`.
- [ ] `BASE_URL`/`FRONTEND_URL` = el dominio https.
- [ ] LibreOffice y Chrome instalados (probar firma y una generación).
- [ ] PM2 `save` + `startup` (sobrevive reinicios).
- [ ] Prueba E2E: subir asignación → generar poderes → generar demandas → firmar.

---

## 11. Deploy automático (GitHub Actions)

Workflow ya incluido: [.github/workflows/deploy.yml](../.github/workflows/deploy.yml). Al hacer `push` a `main` (o con el botón manual en la pestaña **Actions**), corre `scripts/deploy.sh` en el servidor.

Usa un **self-hosted runner** instalado en el EC2 — la opción **más segura**: el runner "jala" los jobs saliendo hacia GitHub, así que **no hay que abrir el puerto 22 ni guardar llaves de AWS**.

### Instalar el runner (una vez, en el EC2 como `appuser`)
1. GitHub → repo → **Settings → Actions → Runners → New self-hosted runner** (Linux x64).
2. Copiar los comandos que muestra (descarga + `./config.sh`). Al configurar, cuando pida labels añade **`gretty-prod`** (el workflow usa `runs-on: [self-hosted, gretty-prod]`).
3. Instalarlo como servicio para que reviva solo:
   ```bash
   sudo ./svc.sh install appuser
   sudo ./svc.sh start
   ```
4. Listo: cada push a `main` despliega solo. El runner necesita `node`, `npm`, `pm2` y acceso al repo en `/home/appuser/IAServerGretty` (ajusta la ruta del workflow si es otra).

### Alternativa: deploy por SSH (si no quieres runner)
Usar `appleboy/ssh-action` con secretos `EC2_HOST`, `EC2_USER`, `EC2_SSH_KEY`. **Contra de seguridad**: requiere el **puerto 22 abierto** (las IPs de GitHub Actions son amplias y cambiantes → difícil de restringir). Por eso se prefiere el runner. Si aun así lo quieres, te lo armo.

---

## 12. Costos AWS y encendido/apagado

### ¿Por qué te cobran?
| Concepto | Cuándo cobra | Aprox. (us-east-1) |
|---|---|---|
| **EC2 (cómputo)** | **solo mientras el instance está *running*** (por segundo) | t3.medium ≈ **$0.0416/h ≈ $30/mes** 24/7 |
| **EBS (disco)** | **siempre**, aunque el instance esté *stopped* | gp3 30 GB ≈ **$2.4/mes** |
| **IP pública / Elastic IP** | por hora, esté o no adjunta (política AWS 2024) | ≈ **$3.6/mes** por IPv4 |
| **Transferencia de datos SALIENTE** | al enviar datos a internet (IN es gratis) | ~$0.09/GB tras 100 GB/mes gratis |
| **Snapshots / backups a S3** | por GB-mes almacenado | centavos |

Evitamos lo caro: **sin RDS, sin ALB, sin NAT Gateway** (todo en un EC2 = ~**$35–40/mes**). Precios varían por región; confirma en la página de precios de AWS.

### On-demand
"On-demand" = pagas por segundo de uso, **sin contrato ni pago adelantado**. Si **detienes** (`stop`) el instance, **dejas de pagar el cómputo** (sigues pagando EBS + IP). No hay que reservar nada.

### ¿El servidor solo unas horas? ¿Arrancar todo a mano cada día?
- **NO arrancas los servicios a mano.** Con `pm2 startup` + `pm2 save`, más OpenVPN, Nginx y Postgres como servicios (systemd), **todo revive solo al encender el instance**. Solo enciendes la **máquina** (un click) y el resto sube automático.
- Para **apagar/encender por horario** (ej. 7am–8pm entre semana) sin tocar nada: **EventBridge Scheduler** (o el AWS Instance Scheduler) prende/apaga el EC2 en automático.
- **Ojo**: si lo apagas, la app queda **offline** en esas horas (nadie puede usarla, ni corren procesos). Para una oficina jurídica normalmente conviene **24/7** o al menos horario laboral.
- La **Elastic IP se conserva** al hacer stop/start, así que el dominio sigue apuntando bien (por eso se usa EIP y no la IP efímera).

**Ahorro real**: 12h × 5 días ≈ 260 h/mes ≈ **$11/mes de cómputo** (vs $30 en 24/7). EBS + IP se siguen pagando. El ahorro es modesto; si la disponibilidad importa, deja 24/7.
```
