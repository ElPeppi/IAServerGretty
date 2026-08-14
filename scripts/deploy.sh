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

# ── Respaldo de la DB antes de migrar (por si acaso) ────────────────────────
if command -v pg_dump >/dev/null 2>&1; then
  BK="/var/backups/gretty"
  mkdir -p "$BK"
  echo "▸ backup DB → $BK"
  pg_dump "${DATABASE_URL:-postgresql://postgres@localhost:5432/legaldb}" \
    > "$BK/legaldb-$(date +%Y%m%d-%H%M%S).sql" || echo "  (backup omitido)"
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
