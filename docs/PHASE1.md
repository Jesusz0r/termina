# Phase 1 — Workspaces and Pi ownership (Worldlines Release 1)

> **Status:** complete — primary-only behavior stays green and no generated
> bridge file appears in the opened project (the Phase 1 acceptance gate).

## What changed

### Pinned Pi binary (WORLDLINES §6.7)

- `@earendil-works/pi-coding-agent@0.84.1` is pinned as an exact application
  dependency.
- Agent terminals launch `dist/cli.js` from that package, resolved through
  `import.meta.resolve` (the exports map has only an import condition, so
  `require.resolve` fails). `PI_EDITOR_PI_BIN` still overrides.

### App-owned bridge (WORLDLINES §6.3)

- The bridge template stays in `electron/main.ts`; the materialized file is
  written to `app.getPath("userData")/pi-ditor-bridge.ts` and passed to pi
  with `-e <path>` — never into the project.
- The bridge loads before project trust and never appears in source capture.
- On folder open, the app removes the legacy generated project bridge
  (`.pi/extensions/pi-ditor-bridge.ts`) only when it carries the Pi/ditor
  generated marker. A user file that shares the name stays untouched.
- A template change takes effect on the next app start (content compare).

### Workspaces (WORLDLINES §6.2)

- `WorkspaceState`: id, root, primary, generation, writerId, watcher,
  terminalIds. The primary workspace is created on folder open and at boot;
  a folder switch tears it down (watcher, user-edit map, lease).
- Every terminal carries a `workspaceId` (`InstanceSummary.workspaceId`).
  Background Verify processes and dispatch workers inherit the owner's workspace.
- The watcher belongs to a workspace; every change bumps its generation.
  Watcher attribution, baselines, and user-edit recording are scoped to the
  workspace's terminals.
- User edits are stored per workspace (`userEditsByWorkspace`); context
  files (`edits-<id>.md`) are written per terminal from its workspace map.
- Write lease: `writerId` on the workspace plus `assertWorkspaceWritable`,
  which blocks user file saves, explorer mutations, and review reverts
  while a lease is held. The acquire/release API lands with Phase 2's
  run-start preflight, which is its first caller.

### Renderer

- Dirty-model tracking: user edits mark a tab dirty (`hasDirtyModels`,
  `flushAll`). The File menu gains **Save All** (Cmd+Alt+S).
- Conflict protection: a watcher push never replaces a model with unsaved
  user edits. The tab gets a `conflict` class, a warning toast fires once,
  and the user decides (save overwrites, or revert).
- Busy lock: while any agent terminal of the workspace is busy, the editor
  is read-only (`setLocked`). Verified: engages on `agent_start`, releases
  on `agent_settled`.
- `window.__editorMgr` is exposed for the e2e suites.

## Fixed in passing

- `scripts/verify-test.mjs` searched for the events dir as
  `pi-editor-events`; the app's dir is `pi-ditor-events`. The suite's
  context-file checks could never pass. One-character fix in the suite.

## Verification

- `npx tsc --noEmit` — clean.
- `node scripts/build.mjs` + `npx vite build` — clean.
- Phase 0 spikes: 73/73 (re-run after the refactor).
- E2E suites on fresh instances (bridge now loads via `-e`):
  explorer 7/7, timeline 9/9, edits-to-agent 9/9, verify 11/11,
  mine-ownership 6/6, review 5/5, baseline-race 11/11, tui-loop 3/3.
- Manual smoke: pinned binary spawns (child of Electron, named `pi`),
  legacy bridge removed from the fixture while the user extension stayed,
  app bridge in userData, busy lock engages/releases, dirty models survive
  disk pushes with the conflict badge.

## Known limits for the next phase

- Acquire/release of the write lease (Phase 2 run-start preflight).
- Mine paths and test detection still use the primary workspace root.
- `rel()` defaults to the primary root; candidate workspaces (Phase 3) pass
  their own root.
- The renderer's explorer shows the primary workspace; candidate explorer
  roots arrive with Phase 3.
