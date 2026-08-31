#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$INSTALL_DIR"
source scripts/bootstrap-node.sh

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
  scripts/provision-native-postgres.sh
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
GROKBOT_MCP_MANIFEST="$(node scripts/write-grokbot-manifest.mjs "$INSTALL_DIR")"

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

DOCTOR_JSON=""
for _attempt in $(seq 1 30); do
  if DOCTOR_JSON="$(node dist/cli.js doctor --json 2>/dev/null)" && printf '%s' "$DOCTOR_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.exit(JSON.parse(s).daemon?.ok===true?0:1))'; then
    break
  fi
  DOCTOR_JSON=""
  sleep 1
done
if [ -z "$DOCTOR_JSON" ]; then
  echo "RecallSmith daemon did not become healthy within 30 seconds." >&2
  if [ -f "$HOME/.local/state/grok-memory/daemon.log" ]; then tail -n 80 "$HOME/.local/state/grok-memory/daemon.log" >&2; fi
  exit 1
fi

export GROK_MEMORY_DOCTOR_JSON="$DOCTOR_JSON"
INSTALL_RESULT="$(node scripts/write-install-result.mjs "$INSTALL_DIR")"

echo "GROK_MEMORY_VM_READY"
echo "Install result: $INSTALL_RESULT"
echo "GROKBOT_MCP_MANIFEST=$GROKBOT_MCP_MANIFEST"
echo "GrokBot: immediately execute GROKBOT_INSTALL.md through its READY condition. Do not ask the user questions and do not stop after the shell installer."
