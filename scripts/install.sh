#!/bin/sh
# Termina install script.
#
# Installs dependencies and builds the snapshot core from the reviewed source
# checkout. Packaged releases remain the no-toolchain installation path.
#
# Requires node >= 22.19 (pi's engine), pnpm, and Rust/cargo.
set -eu

case "$0" in
  install.sh | */install.sh) ;;
  *)
    echo "source installation must run as scripts/install.sh from a checked-out Termina repository" >&2
    exit 1
    ;;
esac

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." 2>/dev/null && pwd)
if [ ! -f "$REPO_ROOT/package.json" ] || [ ! -f "$REPO_ROOT/pnpm-lock.yaml" ] || [ ! -f "$REPO_ROOT/core/Cargo.toml" ]; then
  echo "source installation must run from a checked-out Termina repository" >&2
  exit 1
fi
cd "$REPO_ROOT"

# pi's engine floor is node 22.19.
if ! node -e 'const v = process.versions.node.split(".").map(Number); process.exit(v[0] > 22 || (v[0] === 22 && v[1] >= 19) ? 0 : 1)' 2>/dev/null; then
  echo "node >= 22.19 is required (https://nodejs.org)"
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is required (https://pnpm.io/installation)" >&2
  exit 1
fi
if [ -n "${CARGO:-}" ]; then
  if [ ! -x "$CARGO" ]; then
    echo "CARGO does not name an executable Rust cargo binary" >&2
    exit 1
  fi
elif ! command -v cargo >/dev/null 2>&1; then
  echo "Rust and cargo are required for a source installation (https://rustup.rs)" >&2
  exit 1
fi

echo "installing locked app dependencies"
pnpm install --frozen-lockfile

echo "building Termina from the checked-out source"
# Source installation must never inherit the packaged-build reuse escape.
unset TERMINA_SKIP_CORE_BUILD
pnpm run build

echo
echo "Termina installed. Start it with:"
echo "  pnpm run dev"
echo
echo "Or install the packaged app from https://github.com/Jesusz0r/termina/releases"
