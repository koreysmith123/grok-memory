#!/usr/bin/env bash
set -euo pipefail

if command -v node >/dev/null 2>&1 && [ "$(node -p 'Number(process.versions.node.split(".")[0])')" -ge 22 ]; then
  # install.sh sources this helper so PATH changes survive. Return to the
  # installer when Node is already suitable instead of terminating it.
  return 0 2>/dev/null || exit 0
fi

if [ "$(uname -s)" != "Linux" ]; then
  echo "Node.js 22 or newer is required. Install it, then rerun ./install.sh." >&2
  exit 1
fi

case "$(uname -m)" in
  x86_64) NODE_ARCH="x64" ;;
  aarch64|arm64) NODE_ARCH="arm64" ;;
  *) echo "Unsupported CPU architecture for automatic Node.js setup: $(uname -m)" >&2; exit 1 ;;
esac

NODE_VERSION="${GROK_MEMORY_NODE_VERSION:-22.23.2}"
NODE_ROOT="$HOME/.local/lib/grok-memory/node-v${NODE_VERSION}-linux-${NODE_ARCH}"
NODE_BIN="$HOME/.local/bin"
if [ ! -x "$NODE_ROOT/bin/node" ]; then
  command -v curl >/dev/null 2>&1 || { echo "curl is required to install Node.js." >&2; exit 1; }
  TEMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TEMP_DIR"' EXIT
  ARCHIVE="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
  BASE_URL="https://nodejs.org/dist/v${NODE_VERSION}"
  curl -fsSLo "$TEMP_DIR/$ARCHIVE" "$BASE_URL/$ARCHIVE"
  curl -fsSLo "$TEMP_DIR/SHASUMS256.txt" "$BASE_URL/SHASUMS256.txt"
  EXPECTED="$(awk -v file="$ARCHIVE" '$2 == file { print $1 }' "$TEMP_DIR/SHASUMS256.txt")"
  [ -n "$EXPECTED" ] || { echo "Node.js checksum was not published." >&2; exit 1; }
  if command -v sha256sum >/dev/null 2>&1; then ACTUAL="$(sha256sum "$TEMP_DIR/$ARCHIVE" | awk '{print $1}')";
  else ACTUAL="$(shasum -a 256 "$TEMP_DIR/$ARCHIVE" | awk '{print $1}')"; fi
  [ "$ACTUAL" = "$EXPECTED" ] || { echo "Node.js checksum verification failed." >&2; exit 1; }
  mkdir -p "$(dirname "$NODE_ROOT")" "$NODE_BIN"
  tar -xJf "$TEMP_DIR/$ARCHIVE" -C "$(dirname "$NODE_ROOT")"
fi

mkdir -p "$NODE_BIN"
for tool in node npm npx corepack; do ln -sfn "$NODE_ROOT/bin/$tool" "$NODE_BIN/$tool"; done
export PATH="$NODE_BIN:$PATH"
hash -r
node --version
