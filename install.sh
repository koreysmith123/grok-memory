#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$INSTALL_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22 or newer is required." >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Node.js 22 or newer is required; found $(node --version)." >&2
  exit 1
fi

npm ci
npm run build

if command -v grok >/dev/null 2>&1; then
  GROK_MEMORY_RESOLVED_BINARY="$(command -v grok)"
else
  GROK_MEMORY_RESOLVED_BINARY="$INSTALL_DIR/node_modules/.bin/grok"
fi
if [ ! -x "$GROK_MEMORY_RESOLVED_BINARY" ]; then
  echo "The bundled Grok Build executable could not be located." >&2
  exit 1
fi

if [ ! -f .env ]; then
  node scripts/init-env.mjs
fi
if ! grep -q '^GROK_MEMORY_GROK_BINARY=' .env; then
  printf 'GROK_MEMORY_GROK_BINARY=%s\n' "$GROK_MEMORY_RESOLVED_BINARY" >> .env
fi

set -a
. ./.env
set +a

if [ "${GROK_MEMORY_MANAGED_POSTGRES:-0}" = "1" ] && command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  docker compose up -d postgres
  for _attempt in $(seq 1 45); do
    if docker compose exec -T postgres pg_isready -U postgres -d grok_memory >/dev/null 2>&1; then break; fi
    sleep 1
  done
elif ! command -v pg_isready >/dev/null 2>&1 || ! pg_isready -d "${DATABASE_URL:-postgresql://grok_memory:grok_memory@127.0.0.1:54329/grok_memory}" >/dev/null 2>&1; then
  echo "PostgreSQL with pgvector is required. Install Docker or set DATABASE_URL in .env." >&2
  exit 1
fi

if [ "${GROK_MEMORY_MANAGED_POSTGRES:-0}" = "1" ] && docker compose ps --status running postgres >/dev/null 2>&1; then
  docker compose exec -T postgres psql -U postgres -d grok_memory -v ON_ERROR_STOP=1 -v app_password="$APP_DB_PASSWORD" <<'SQL'
DO $$ BEGIN CREATE ROLE grok_memory_app LOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER ROLE grok_memory_app PASSWORD :'app_password';
SQL
fi
node dist/cli.js migrate
node dist/cli.js warm-embedding
node scripts/merge-config.mjs "$INSTALL_DIR"

if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  mkdir -p "$HOME/.config/systemd/user"
  sed "s|__INSTALL_DIR__|$INSTALL_DIR|g" systemd/grok-memory.service > "$HOME/.config/systemd/user/grok-memory.service"
  systemctl --user daemon-reload
  systemctl --user enable --now grok-memory.service
else
  mkdir -p "$HOME/.local/state/grok-memory"
  if [ -f "$HOME/.local/state/grok-memory/daemon.pid" ] && kill -0 "$(cat "$HOME/.local/state/grok-memory/daemon.pid")" 2>/dev/null; then
    :
  else
    nohup node dist/cli.js daemon >"$HOME/.local/state/grok-memory/daemon.log" 2>&1 &
    echo $! > "$HOME/.local/state/grok-memory/daemon.pid"
  fi
fi

echo "Grok Memory installed. Run: node $INSTALL_DIR/dist/cli.js doctor --json"
echo "If Grok Build is not signed in, run: grok login --device-auth"
