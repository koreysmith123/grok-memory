#!/usr/bin/env bash
set -euo pipefail
INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  systemctl --user disable --now grok-memory.service 2>/dev/null || true
  SERVICE_FILE="$HOME/.config/systemd/user/grok-memory.service"
  if [ -f "$SERVICE_FILE" ] && grep -Fq "$INSTALL_DIR" "$SERVICE_FILE"; then rm "$SERVICE_FILE"; fi
  systemctl --user daemon-reload 2>/dev/null || true
elif [ -f "$HOME/.local/state/grok-memory/daemon.pid" ]; then
  PID="$(cat "$HOME/.local/state/grok-memory/daemon.pid")"
  kill "$PID" 2>/dev/null || true
  rm "$HOME/.local/state/grok-memory/daemon.pid"
fi
node "$INSTALL_DIR/scripts/remove-config.mjs" "$INSTALL_DIR"
echo "Grok Memory integration removed. PostgreSQL data and this checkout were preserved."
echo "Delete the database/volume only if you intentionally want to erase all memories."
