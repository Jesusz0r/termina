#!/bin/sh
# core/ owns application Git operations (AGENTS.md: one canonical
# implementation). Application TypeScript must never spawn the git CLI or
# import a git library; test fixtures under tests/ are exempt.
set -eu
cd "$(dirname "$0")/.."
if git grep -n -E \
  -e "(spawnSync|spawn|execFileSync|execFile|execSync|exec|execaSync|execa)\(\s*['\"]git['\"]" \
  -e "from\s+['\"](simple-git|isomorphic-git|dugite|nodegit)" \
  -e "require\(\s*['\"](simple-git|isomorphic-git|dugite|nodegit)" \
  -- agent-core electron src shared; then
  echo "error: forbidden git CLI usage in app code (see above)" >&2
  exit 1
fi
echo "ok: no git CLI usage in app code"
