# AGENTS.md — Termina

Hybrid coding tool: left = real pi TUI in a pty, right = Monaco + file explorer. Desktop app: Electron + Vite + TypeScript + node-pty + Rust `core/` (`termina-core`).

## Decision priority (when rules conflict)

1. Correctness / data integrity / main-process responsiveness (source trees, snapshots, write leases, session files)
2. Security / process isolation (main vs renderer, env sanitization, sandboxes)
3. Explicit task requirements
4. Hot-path performance
5. Existing public contracts (IPC `area:action`, sidecar events, release tags)
6. Established architecture and conventions
7. Simplicity / reuse / locality
8. Developer convenience

Use this order for implementation tradeoffs. If a task requires changing a data-integrity or security invariant, surface the conflict before changing it. Keep blocking or expensive work off the main-process event loop.

## One canonical implementation

One responsibility → one owner. Reuse, extend, or replace — never add a parallel path. When replacing: update all callers, delete the old, remove dead IPC/types/tests/docs.

- `core/` owns application Git/snapshot operations, including capture, hashing, and merge. Application code must not spawn the `git` CLI; this does not prohibit developer Git commands or isolated test-fixture setup.
- `electron/worldline-git.ts` — only public TS client for `core/`; private process/protocol helpers live in `electron/worldline-git/`.
- `electron/session-fork.ts` → `electron/session-worker.ts` — only session fork path.
- `shared/preferences.ts` — only prefs validator; `electron/preferences.ts` — only file store.
- `electron/plan-board.ts` — Plan Board parse/progress/dispatch. `electron/worldlines.ts` — comparisons/promotion/evidence/runs. `electron/evidence.ts` only measures.
- `electron/sidecar.ts` owns sidecar parse/tail. Only writers: `electron/bridge-extension.ts` + `agent-core/host.ts` + `logEvent` in `agent-core/main.ts`.
- `electron/session-search.ts` owns Session Search walk. `electron/sandbox.ts` owns sandbox profiles.
- `electron/main.ts` owns terminal/workspace lifecycle and IPC. Main owns authoritative app state; `src/` owns rendering and transient UI state, and requests privileged operations through preload. Keep orchestration out of the core client, `pty-terminal.ts`, and `session-fork.ts`.

An owner may be a module or a directory with private helpers; its public API stays single. The paths above are entry points, not a requirement to put all implementation in one file.

When a touched file exceeds 800 lines, assess extraction. Extract cohesive responsibilities with a distinct lifecycle, test surface, or reason to change; keep helpers with their owner. Line count is a review trigger, not a reason for unrelated refactoring. Section comments do not replace module boundaries.

## Rules

**No backwards compat.** Don't add shims, deprecated aliases, or feature-flagged old paths. Migrate internal callers, delete the old interface. Temporary compat only at the narrowest boundary when an external file on disk forces it (prefs on disk, snapshot format, sidecar from a running `pi`); delegate to the canonical impl and remove when the constraint lifts. When a feature is removed, remove its IPC/types/helpers/tests/docs too.

**No overengineering / YAGNI.** Prefer in order: use existing → compose → small change → small helper → new abstraction → new subsystem. Don't add config/options/abstractions for hypothetical needs. `TERMINA_EVENTS_DIR`, `TERMINA_CORE_BIN`, `TERMINA_SKIP_CORE_BUILD`, `CSC_NAME` stay configurable. The smallest correct, boring code wins.

**Reuse before inventing.** Search first. Reuse if semantics match. Don't duplicate business rules to avoid an abstraction; incidental syntax duplication is okay, duplicated responsibility is not.

**Dependencies must earn their cost:** language → stdlib → Electron/Vite/Monaco/xterm/node-pty → existing deps → Rust core → small local impl → new dep. `@lydell/node-pty` stays external in esbuild. Don't reimplement snapshot/merge in TS.

**Product:** sensible defaults over config; progressive disclosure; terminal stays source of truth; never expose sidecars/leases/core protocol in UI.

## Process isolation

Renderer never talks directly to the agent or performs privileged fs/pty/snapshot work. Preload exposes only the typed `window.pi` bridge; validate privileged requests in main. Write leases prevent two writers on one tree — don't bypass. Use the existing candidate sandboxes / offline evidence profile for isolation; a separate process or tree alone is not a sandbox. Preserve `PI_SESSION_*` env sanitization when launching `pi`.

## Performance

Main must stay responsive. Keep IPC small, fetch heavy data on demand, cap caches/timelines, avoid O(n²), use incremental DOM updates. Captures/merges/hash run in Rust for a reason. Don't regress hot paths.

## Styling

Tokens live in `src/styles.css` `:root` / `html[data-theme]` (`--bg`, `--bg-panel`, `--border`, `--text`, `--accent`, etc.). Use them; don't invent inline colors or new themes without reason.

## Live provider docs for `agent-core`

Session memory is not truth. Before editing `agent-core/` for model ids, context windows, thinking/effort fields, cache markers/keys/TTLs, protocol (Messages/Responses/Completions/generateContent), or auth headers — search live docs **in this turn**:

- Anthropic: `https://platform.claude.com/docs`
- OpenAI: `https://developers.openai.com/api/docs`
- Gemini: `https://ai.google.dev/gemini-api/docs`
- xAI: `https://docs.x.ai` · Zen: `https://opencode.ai/docs/zen` · OpenRouter: `https://openrouter.ai/docs`

Follow the existing owner for the behavior: `agent-core/auth.ts` (auth/provider policy), `agent-core/models.ts` (live catalog), `agent-core/main.ts` / `agent-core/openai-compat.ts` (requests), and `agent-core/cache.ts` (cache diagnostics). Don't add a second catalog/cache/protocol mapper. Include the relevant documentation URLs in the change summary; if docs are unavailable, state that limitation and do not invent provider behavior.

## Glossary

Run = one agent session (`agent_start` → `agent_settled`). Sidecar = JSONL per terminal in `TERMINA_EVENTS_DIR`. Baseline = file at run start. Snapshot = file at a moment. Dot = timeline point. Worker = one dispatched plan task. Fork point = timeline event + Pi session entry + immutable source state. Worldline = isolated candidate tree + session. Candidate/Reference(A)/Alternative(B)/Challenge/Evidence contract/Write lease/Workspace — see `docs/reference/AGENT-CORE.md`.

## Event flow

Agent runs a tool → the engine's sidecar writer records it → main tails the sidecar → main pushes typed IPC → renderer updates the UI.

## Conventions & verification

- IPC `area:action` (`verify:run`, `timeline:get`), terminals `term-N`, app-created snapshot commits `termina <dev@termina.local>`, release tags `v<version>`.
- Preserve unrelated working-tree changes. Keep edits scoped to the task; when changing a contract, migrate its callers and remove obsolete artifacts together.
- Use `package.json` as the source for commands. Development: `pnpm run dev`. Typecheck: `pnpm run typecheck`. Unit tests: `pnpm run test:unit` (or a relevant focused script). Build: `pnpm run build`. Rust: `cargo test --manifest-path core/Cargo.toml`.
- For code changes, run typecheck and relevant tests. Run the build for bundling/packaging changes and Rust tests for `core/` changes. For Electron/UI integration changes, build first, then run the relevant Playwright suite with `pnpm run test:e2e`. Documentation-only changes need path/command checks, not an application test run. Report checks run and any failures or checks not run.
- E2E isolation is defined in `tests/e2e/fixtures.ts`: fresh roots for projects, events, worlds, Electron user data, and a HOME with its own `.pi/agent` tree. Never use or modify the host `~/.pi/agent` tree. Use Playwright's Electron launcher; keep process termination and cleanup scoped to resources the test owns, and wait for children to exit before deleting their files.
- Gotchas: `@lydell/node-pty` external; cargo needed for `core/`; packaged app ships its own `node` (`cleanEnv` prepends `resourcesPath/node/bin`); macOS paths canonical (`/tmp` → `/private/tmp`); events dir is `app.getPath("temp")/termina-events`; bridge is app-owned in user-data dir.
