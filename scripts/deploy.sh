#!/usr/bin/env bash
#
# deploy.sh — Actualiza producción tras un cambio (código y/o base de datos).
# Correr EN EL SERVIDOR, desde la raíz del repo:  ./scripts/deploy.sh
#
# Idempotente: si no hay migraciones nuevas, "migrate deploy" no hace nada.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "──────────────────────────────────────────"
echo " Deploy GrettyAI — $(date)"
echo "──────────────────────────────────────────"

echo "▸ git pull"
git pull --ff-only

# ── Respaldo de la DB antes de migrar ───────────────────────────────────────
# DATABASE_URL no está en el entorno cuando esto lo lanza el runner de GitHub
# Actions (ni en una shell recién abierta): se saca del .env del backend. Sin
# ella, pg_dump caía a una URL sin contraseña, se quedaba esperando input y el
# respaldo se perdía JUSTO antes de aplicar migraciones. Se extrae solo esa
# variable en vez de hacer `source` del .env entero: ahí hay secretos y valores
# con espacios que la shell interpretaría.
if [ -z "${DATABASE_URL:-}" ] && [ -f "$ROOT/backend/.env" ]; then
  DATABASE_URL="$(grep -E '^DATABASE_URL=' "$ROOT/backend/.env" | head -1 | cut -d= -f2- | tr -d '"')"
  export DATABASE_URL
fi

if command -v pg_dump >/dev/null 2>&1; then
  BK="/var/backups/gretty"
  # `mkdir` sin guarda + `set -e` abortaba el deploy entero si faltaban permisos.
  if mkdir -p "$BK" 2>/dev/null; then
    echo "▸ backup DB → $BK"
    if pg_dump "${DATABASE_URL:-postgresql://postgres@localhost:5432/legaldb}" \
        > "$BK/legaldb-$(date +%Y%m%d-%H%M%S).sql"; then
      echo "  backup OK"
    else
      echo "  ⚠ BACKUP FALLIDO — se sigue, pero las migraciones se aplicarán sin red"
    fi
  else
    echo "  ⚠ sin permisos de escritura en $BK — backup omitido"
  fi
fi

# ── Backend ─────────────────────────────────────────────────────────────────
echo "▸ backend: deps + migraciones + build"
cd "$ROOT/backend"
npm ci
npx prisma migrate deploy      # aplica SOLO migraciones nuevas (no toca datos existentes)
npx prisma generate
npm run build
pm2 restart gretty-backend

# ── Motor ───────────────────────────────────────────────────────────────────
echo "▸ motor: deps + restart"
cd "$ROOT/sac_scripts"
npm ci
pm2 restart gretty-motor

# ── Frontend ────────────────────────────────────────────────────────────────
echo "▸ frontend: build (Nginx sirve frontend/dist)"
cd "$ROOT/frontend"
npm ci
npm run build

pm2 save
echo "✓ Deploy completo."
