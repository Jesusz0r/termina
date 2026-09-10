#!/bin/sh
# core/ owns application Git operations (AGENTS.md: one canonical
# implementation). Application TypeScript must never spawn the git CLI or
# import a git library; test fixtures under tests/ are exempt.
#
# Static tripwire only: dynamic commands (bash -c strings, MCP server
# configs) are out of scope.
set -eu
cd "$(dirname "$0")/.."
matches=$(git grep -n -E \
  -e "(spawnSync|spawn|execFileSync|execFile|execSync|exec|execaSync|execa)\(\s*['\"]git['\"]" \
  -e "from\s+['\"](simple-git|isomorphic-git|dugite|nodegit)" \
  -e "require\(\s*['\"](simple-git|isomorphic-git|dugite|nodegit)" \
  -- agent-core electron src shared 2>&1) || code=$?
code=${code:-0}
if [ "$code" -eq 0 ]; then
  printf '%s\n' "$matches"
  echo "error: forbidden git CLI usage in app code (see above)" >&2
  exit 1
elif [ "$code" -ne 1 ]; then
  echo "error: git grep failed (exit $code): $matches" >&2
  exit 2
fi
echo "ok: no git CLI usage in app code"
