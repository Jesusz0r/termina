#!/bin/bash
set -euo pipefail

package_log=$(mktemp "${TMPDIR:-/tmp}/termina-package.XXXXXX")
trap 'rm -f "$package_log"' EXIT

set -- --publish never
if [ "$(uname -s)" = Darwin ] && [ -n "${CSC_LINK:-}" ] && [ -n "${APPLE_ID:-}" ] \
  && [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
  set -- "$@" -c.mac.notarize=true
fi

if pnpm exec electron-builder "$@" 2>&1 | tee "$package_log"; then
  exit 0
else
  package_status=${PIPESTATUS[0]}
fi

# Repeat only named transient network failures. Configuration, authentication,
# and signing errors need a correction before another packaging attempt.
if ! grep -Eq 'ECONNRESET|ETIMEDOUT|EAI_AGAIN|TLS handshake timeout' "$package_log"; then
  exit "$package_status"
fi

echo "Transient network failure; retrying packaging once"
pnpm exec electron-builder "$@"
