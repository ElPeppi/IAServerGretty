# Despliegue en AWS (con VPN a la NAS de la oficina)

## Contexto / decisión
- `10.0.10.10` es la **NAS** de la oficina (servidor de archivos), encendida 24/7.
- Ya existe una **VPN** para acceso remoto.
- **Motor + backend (+ frontend)** se despliegan en **AWS**. El servidor de AWS se conecta
  por VPN a la red de la oficina y monta la carpeta compartida de la NAS.
- Resultado: no hace falta ningún PC de trabajo encendido; la NAS hace de almacenamiento.

## Topología

```
[ EC2 en AWS ]                         (VPN)            [ Oficina ]
  Motor (sac_scripts) :3456   ───────────────────────►  NAS \\10.0.10.10\compartida
  Backend (API)       :3001   monta la NAS como unidad   (siempre encendida)
  Frontend (web)
  PostgreSQL (RDS o local)
  └ scraping SAC/RUNT/RUES/Rama  → internet (y SAC puede salir por la VPN = IP oficina)
```

## Pasos

### 1. VPN del EC2 hacia la oficina
- **Opción A (reusa la VPN actual):** el EC2 corre un **cliente VPN** (WireGuard/OpenVPN)
  que se conecta al servidor VPN de la NAS/router de la oficina. Es lo más simple.
- **Opción B (más robusta):** AWS **Site-to-Site VPN** contra el router/firewall de la oficina.

### 2. Montar la NAS en el EC2
- **Windows EC2:** usar las rutas UNC `\\10.0.10.10\compartida\...` directamente (cero cambios).
- **Linux EC2:** montar con cifs, por ejemplo en `/etc/fstab`:
  ```
  //10.0.10.10/compartida  /mnt/compartida  cifs  credentials=/etc/nas.cred,vers=3.0,iocharset=utf8  0  0
  ```

### 3. Variables de entorno del MOTOR (ya soportadas — sin tocar código)
Apuntar a la carpeta montada (Linux) o dejar las UNC por defecto (Windows):
- `SAC_OUT_DIR`            → carpeta de salida (GARANTIAS)
- `PLANTILLA_SINGULAR`     → plantilla xlsx
- `PLANTILLA_DEMANDA`      → plantilla demanda .docx
- `PLANTILLA_PODER`        → plantilla poder .docx
- `ANEXOS_DEMANDAS`        → certificados (J Ramos, SIRNA)
- `ANEXOS_FINANDINA`       → certificados (Super, CCO Finandina)
- `SAC_TEMP_DIR`, `SAC_USER`, `SAC_PASS`, `SAC_ZIP_PASS` según corresponda.

### 4. Variables del BACKEND
- `ENGINE_BASE_URL=http://localhost:3456`  (el motor en el mismo EC2)
- `BASE_URL=https://<dominio-o-ip>`        (para las URLs de `/uploads`)
- `DATABASE_URL` (RDS PostgreSQL recomendado), `JWT_SECRET`, `FRONTEND_URL`.

### 5. Procesos siempre activos
- Motor (3456) y backend (3001) bajo **pm2 / systemd / docker** para que reinicien solos.
- Frontend: build estático servido por S3+CloudFront, Nginx, o el propio backend.

### 6. (Opcional, más adelante) S3 para velocidad
- `CompositeStorage` = guarda en la NAS (por VPN) **y** en S3.
- La web sirve rápido desde S3; la NAS queda como copia/respaldo local.

## Consideraciones
- **SMB sobre VPN es más lento** que en LAN; para volúmenes altos, mover a S3 lo que sirve la web.
- **Dependencia del internet de la oficina:** si se cae, el motor en AWS no ve la NAS (S3 lo mitiga).
- **IP de SAC:** si Finandina restringe por IP, enrutar el tráfico a SAC por la VPN (sale con IP oficina).

## Costos — cómo dejarlo barato
Con la NAS por VPN **no se usa S3** (era la alternativa sin servidor local). Las piezas caras de
AWS no son S3 sino:
- **NAT Gateway (~$32/mes)** → evitar: poner el EC2 en **subred pública** con IP pública.
- **VPN Gateway gestionado (~$36/mes)** → evitar: **WireGuard** en el propio EC2 ($0).
- **RDS (~$15+/mes)** → evitar: **PostgreSQL en el mismo EC2** ($0).
- **S3** → no se usa (la NAS es el almacenamiento).

Objetivo: **un solo EC2** (t3.small/medium) que corre motor + backend + web + postgres + WireGuard.
Factura aproximada: **~$20–35/mes**. El backend guarda los archivos directamente en la **NAS montada**
(`UPLOADS_DIR`/`SAC_OUT_DIR` → ruta de la NAS), sin EBS extra ni S3.

> Si más adelante la web se siente lenta sirviendo desde la NAS, se activa S3 con `CompositeStorage`
> (cambio de configuración, sin rehacer código).
