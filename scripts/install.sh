#!/bin/sh
# Termina install script.
#
# Downloads the prebuilt snapshot core from GitHub Releases and installs
# the app dependencies. The app then needs no cargo and no git: the Rust
# core is a binary, and every Git operation runs inside it.
#
# Requires node >= 22.19 (pi's engine) and npm.
set -e
cd "$(dirname "$0")/.."

OS=""
case "$(uname -s)" in
  Darwin) OS="darwin" ;;
  Linux) OS="linux" ;;
  *) echo "unsupported platform: $(uname -s)"; exit 1 ;;
esac

ARCH="$(uname -m)"
case "$ARCH" in
  arm64 | aarch64) ARCH="arm64" ;;
  x86_64 | amd64) ARCH="x64" ;;
  *) echo "unsupported architecture: $ARCH"; exit 1 ;;
esac

# Intel Macs get no builds: the release matrix covers darwin arm64 only.
if [ "$OS" = "darwin" ] && [ "$ARCH" = "x64" ]; then
  echo "unsupported platform: darwin x64 (arm64 Macs only)"
  exit 1
fi

# pi's engine floor is node 22.19.
if ! node -e 'const v = process.versions.node.split(".").map(Number); process.exit(v[0] > 22 || (v[0] === 22 && v[1] >= 19) ? 0 : 1)' 2>/dev/null; then
  echo "node >= 22.19 is required (https://nodejs.org)"
  exit 1
fi

mkdir -p dist-electron
CORE_URL="https://github.com/Jesusz0r/termina/releases/latest/download/termina-core-${OS}-${ARCH}"
echo "downloading the snapshot core: ${CORE_URL}"
curl -fsSL --retry 3 --retry-delay 2 --retry-all-errors -o dist-electron/termina-core "$CORE_URL"
chmod +x dist-electron/termina-core

echo "installing the app dependencies (includes the pinned pi package)"
npm install

echo
echo "Termina installed. Start it with:"
echo "  TERMINA_SKIP_CORE_BUILD=1 npm run dev"
echo
echo "Or install the packaged app from https://github.com/Jesusz0r/termina/releases"
