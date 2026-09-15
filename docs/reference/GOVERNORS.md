# Governors

> **Status:** advisory map. This file does not govern. It records what
> actually fails a change. It is not a second policy file and it does
> not replace `AGENTS.md`.

`AGENTS.md` states owners and conventions for agents. This map says
whether a tripwire exists. If no test, script, or workflow fails the
change, the claim is **convention**, **advisory**, or **unchecked**.

Last checked: 2026-09-15. Source trees: `.github/workflows/`,
`package.json` scripts, `scripts/no-git-cli.sh`, unit tests that pin a
shape. Fixture pins and third-party versions live in
[`TOOLING-WATCH.md`](TOOLING-WATCH.md).

## How to read

| Word | Meaning |
|---|---|
| **Governor** | A check that fails pull-request CI or a wired unit test |
| **Release-only** | Runs on tags `v*` or `workflow_dispatch`, not on every pull request |
| **Convention** | Stated in `AGENTS.md` or contributor docs; no tripwire |
| **Unchecked** | Stated as required; no test and no CI job |
| **Measurement-only** | Produces numbers; does not fail a run or a settle |

## Pull-request CI

`.github/workflows/lint.yml` runs on `push` and `pull_request`.

| Check | Path / command | Honesty |
|---|---|---|
| No git CLI in app TypeScript | `scripts/no-git-cli.sh` via job `no-git-cli`; local `pnpm run lint:no-git-cli` | **Governor.** Static `git grep` over `agent-core`, `electron`, `src`, `shared`. `tests/` is exempt. Dynamic commands (`bash -c`, MCP configs) are out of scope and **unchecked**. |
| App typecheck | `pnpm run typecheck` (`tsc --noEmit`) | **Governor** |
| Test typecheck | `pnpm run typecheck:tests` | **Governor** |
| Build Rust core and bundles | `node --experimental-strip-types scripts/build.ts` | **Governor.** Compiles `core/` and stages `dist-electron`. The Vite renderer build is skipped. |
| Unit tests | `pnpm run test:unit` (`vitest run`) | **Governor.** Needs the built core: `tests/unit/electron/core-client-read-budget.test.ts` spawns `termina-core`. |
| Install | `pnpm install --frozen-lockfile` after `corepack enable` | **Governor.** `package.json` `packageManager` is `pnpm@11.13.1`. |
| Toolchain | Node `22.23.2`, Rust `1.97.1` | **Governor** on CI only. No `rust-toolchain` file in the repo. Local rustc is **unchecked**. |

`pnpm run test` is `typecheck` then `test:unit`. Pull-request CI runs
those steps plus `typecheck:tests` and `scripts/build.ts`. It does
**not** run Rust tests, native spikes, or Playwright.

## Release CI

`.github/workflows/release.yml` runs on tags `v*` and `workflow_dispatch`.

`tests/unit/build/release-graph.test.ts` and
`tests/unit/build/release-workflow.test.ts` pin the script graph and
the workflow shape. Those unit tests run on every pull request. The
release jobs themselves are **release-only**.

| Check | Path / command | Honesty |
|---|---|---|
| Release graph | `pnpm run test:release` = `pnpm run test` + `typecheck:tests` + `test:rust` + `test:native` | **Release-only.** `test:rust` is `cargo test --manifest-path core/Cargo.toml`. |
| Native spikes | `pnpm run test:native` (capture, merge, tree-delta, gitignore, terminal-roster, core-session-promotion, promotion-transaction, watcher-idle, promotion-native-boundary) | **Release-only** on Ubuntu. The `platform` spike is not in this graph. |
| macOS packaging layer | `pnpm run test:release-macos` = `spike -- platform` + `test:sandbox-security-live` + `test:e2e-release-smoke` | **Release-only**, `macos-15` only, before Package. |
| Frozen lockfile and toolchain | Same Node, Rust, and pnpm pins as lint | **Release-only** (and **governor** on pull requests via lint) |

`.github/workflows/pages.yml` deploys `website/` on pushes to `main`.
It is not a code governor.

## Unit tests that pin a slice

These run inside `pnpm run test:unit` on every pull request. They
govern only the claim they assert.

| Claim | Test | Honesty |
|---|---|---|
| `electron/worldline-git.ts` is the public TypeScript client; `electron/worldline-git/core-process.ts` stays private | `tests/unit/electron/core-client.test.ts` | **Governor** for that import slice |
| One esbuild external list; `@lydell/node-pty` and platform packages stay external; preload stays CommonJS | `scripts/bundle-defs.ts`, `tests/unit/scripts/bundle-defs.test.ts` | **Governor** |
| `src/theme-tokens.gen.ts` matches `src/styles.css` | `tests/unit/scripts/theme-tokens.test.ts` | **Governor** for freshness. Do not hand-edit the generated file. |
| Release script order and `release.yml` shape | `tests/unit/build/release-graph.test.ts`, `tests/unit/build/release-workflow.test.ts` | **Governor** for graph text, not a substitute for running Rust or e2e on the pull request |
| Focused suite paths and `test:e2e` = `playwright test` | `tests/unit/build/test-infra.test.ts` | **Governor** for `package.json` script strings |
| User-guide sandbox/MCP phrases match `electron/sandbox.ts` and `agent-core/mcp/config.ts` | `tests/unit/docs/support-contract.test.ts` | **Governor** for those phrases only |
| `dompurify` stays `3.4.14` (lockfile override) | `tests/unit/security/dompurify.test.ts`, `pnpm-workspace.yaml` | **Governor** for that pin |
| Laziness fixture numbers | `tests/unit/scripts/laziness-metrics.test.ts` | **Measurement-only.** Pins `tests/fixtures/traces/laziness-baseline/`. Does not change runtime. |
| No Quiet Wins settle | `agent-core/trace/quiet-wins.ts`, `tests/unit/agent-core/quiet-wins.test.ts` | **Governor** for a success claim after file edits with no observed bash check. Wired in `settleTraceTask`. |
| One-ticket-one-run cite | `electron/verify-map.ts`, `tests/unit/electron/verify-map.test.ts` | **Governor** for the cite API. Not hooked to `verify:run`; main has no finding-ticket store. |
| Handoff contract | `scripts/handoff-check.ts`, `tests/unit/scripts/handoff-check.test.ts` | **Governor** when the script runs. Rejects a missing field or a confidence value that is not `high` / `medium` / `low`. Not a settle gate. |
| Audit ledger reconcile | `scripts/audit-ledger.ts`, `tests/unit/scripts/audit-ledger.test.ts` | **Governor** when the script runs. Pins `tests/fixtures/audit-ledger/`. |
| Evidence source-state pin | `electron/evidence.ts` `measure`, `tests/unit/electron/evidence-pin.test.ts` | **Governor** for capture + recheck on `measure`. A moved tree throws. The renderer toasts that path. |

## `AGENTS.md` owners

The owner list in `AGENTS.md` is **convention**. A module test that
exercises behavior is not a uniqueness gate.

| Owner (from `AGENTS.md`) | Enforcement | Honesty |
|---|---|---|
| `core/` owns application Git; app TypeScript must not spawn `git` | `scripts/no-git-cli.sh` + lint job `no-git-cli` | **Governor** (static). Developer Git and `tests/` fixtures are allowed. |
| `electron/worldline-git.ts` public client | `tests/unit/electron/core-client.test.ts` | **Governor** for the import slice |
| `electron/session-fork.ts` → `electron/session-worker.ts` | Behavioral tests exist | **Convention** as a uniqueness rule |
| `shared/preferences.ts` / `electron/preferences.ts` | Behavioral tests exist | **Convention** as a uniqueness rule |
| Plan Board, worldlines, evidence, sidecar, session-search, sandbox, terminal-runtime, agent-activity, subagents, `electron/main.ts` | Behavioral tests exist | **Convention** as a uniqueness rule |
| `shared/guards.ts`, `shared/fsync.ts`, `shared/grep-pattern.ts` | Behavioral tests exist | **Convention** as a uniqueness rule |
| Line-count review at 800 lines | None | **Unchecked** |
| No Quiet Wins; one-ticket-one-run | Quiet-wins settle + `createVerifyMap().cite` | **Governor** for those two APIs. Session-routine text in `AGENTS.md` is also **convention** for work that never calls them. |
| No backwards-compat shims; YAGNI; WIP=1; STE comments | None | **Convention** / **unchecked** |
| Live provider-doc search before `agent-core` protocol edits | None | **Convention** / **unchecked** |
| IPC `area:action`; terminals `term-N`; tags `v<version>` | Release workflow matches `v*` | **Convention** except the tag glob on release |
| App-created snapshot author `termina <dev@termina.local>` | None for contributor commits | **Convention.** Not a git-identity gate on pull requests. |
| E2E isolation | `tests/e2e/fixtures.ts` when Playwright runs | **Convention** on pull requests: the full matrix is not in lint CI. |

## Not governors

Do not treat these as gates.

| Item | Why |
|---|---|
| This file and [`TOOLING-WATCH.md`](TOOLING-WATCH.md) | Maps and watches. They add no CI. |
| `CONTRIBUTING.md` | Setup and workflow. Advisory. |
| `docs/reference/USER-GUIDE.md` | Product description. Advisory, except the sandbox/MCP phrases pinned by `tests/unit/docs/support-contract.test.ts`. |
| `docs/reference/AGENT-CORE.md`, `docs/reference/WORLDLINES.md` | Architecture references. Not CI. |
| `docs/reference/LAZINESS-BASELINE.md` | Measurement write-up for issue #125. |
| `docs/reference/CALIBRATION.md` | Policy for handoff fields. The checker is the governor, not this file. |
| `docs/reference/AUDIT-LEDGER.md` | Ledger rule. The checker is the governor, not this file. |
| `docs/reference/PINNED-CONTEXT.md` | Tier map. The evidence pin test is the governor, not this file. |
| `#123` / `#124` settle gates | Removed in `f77883c` (`agent-core/main/settle-gate.ts` deleted). Do not restore them. `#237` is the current settle gate (see the unit-test row). |
| `#125` laziness metrics | `scripts/laziness-metrics.ts` is measurement-only. The unit test pins the fixture corpus. It does not settle a run. |
| `cargo clippy` / `cargo fmt --check` | Named in `CONTRIBUTING.md`. No workflow step. **Unchecked.** |
| `pnpm run test:e2e` (full Playwright matrix) | Local / on-demand. Not in `lint.yml`. |
| `pnpm run test:rust` on every pull request | **Release-only** via `test:release`. |
| Live provider probes under `scripts/` | `scripts/README.md`: not wired into `package.json`, CI, or request paths. |
| `node scripts/e2e.mjs` (still named in `CONTRIBUTING.md`) | Path does not exist. The Playwright entry is `pnpm run test:e2e`. |

## Related

- [`TOOLING-WATCH.md`](TOOLING-WATCH.md) — fixture queue, third-party pins, retained deviations
- `AGENTS.md` — owners and conventions (not this file)
