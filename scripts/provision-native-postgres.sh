#!/usr/bin/env bash
set -euo pipefail

if pg_isready -d "$DATABASE_URL" >/dev/null 2>&1; then exit 0; fi
if [ "$(uname -s)" != "Linux" ] || ! command -v apt-get >/dev/null 2>&1; then
  echo "PostgreSQL with pgvector is unavailable; set DATABASE_URL or install Docker." >&2
  exit 1
fi

as_root() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi; }
as_postgres() { if [ "$(id -u)" -eq 0 ]; then runuser -u postgres -- "$@"; else sudo -u postgres "$@"; fi; }

as_root apt-get update
as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y postgresql-17 postgresql-17-pgvector

if ! pg_lsclusters --no-header 2>/dev/null | awk '$1=="17" && $2=="grok-memory" {found=1} END {exit !found}'; then
  as_root pg_createcluster 17 grok-memory --port 54329 --start
else
  as_root pg_ctlcluster 17 grok-memory start || true
fi

as_postgres psql -p 54329 -d postgres -v ON_ERROR_STOP=1 \
  -v admin_password="$POSTGRES_PASSWORD" -v app_password="$APP_DB_PASSWORD" <<'SQL'
ALTER ROLE postgres PASSWORD :'admin_password';
DO $$ BEGIN CREATE ROLE grok_memory_app LOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER ROLE grok_memory_app PASSWORD :'app_password';
SELECT 'CREATE DATABASE grok_memory' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='grok_memory')\gexec
SQL

for _attempt in $(seq 1 30); do
  if pg_isready -d "$DATABASE_URL" >/dev/null 2>&1; then exit 0; fi
  sleep 1
done
echo "Native PostgreSQL was installed but did not become ready at 127.0.0.1:54329." >&2
exit 1
