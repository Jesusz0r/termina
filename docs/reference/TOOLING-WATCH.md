# Tooling watch

> **Status:** watch record. Advisory. This file does not bump pins, add
> CI jobs, or govern. Refresh the dates when you re-read the sources.
> Do not treat a stale date as a release blocker.

Last checked: 2026-09-15.

Sources: `package.json`, `pnpm-lock.yaml`, `core/Cargo.toml`,
`core/Cargo.lock`, `.github/workflows/lint.yml`,
`.github/workflows/release.yml`, `scripts/bundle-defs.ts`,
`scripts/prepare-resources.ts` (`PINNED_NODE_VERSION`),
`tests/e2e/fixtures.ts`, `tests/fixtures/`.

Cadence: **quarterly**, or sooner when a security advisory lands, or
when a cited script or schema changes. This pass did not bump any
version.

## Fixture queue

Checked-in artifacts that go stale when the producer or the pin test
moves.

| Path | Why it rots | Pin today | Cadence | Last checked |
|---|---|---|---|---|
| `tests/fixtures/traces/laziness-baseline/` | 19 synthetic `turn-*.json` files. Schema or `scripts/laziness-metrics.ts` changes move the rates. | `tests/unit/scripts/laziness-metrics.test.ts` pins the #125 fixture baseline. Measurement-only. | Quarterly, or when the metrics script or the trace-v2 schema changes | 2026-09-15 |
| `docs/reference/LAZINESS-BASELINE.md` | Hand-written table next to the same corpus | Same unit test | With the corpus | 2026-09-15 |
| `src/theme-tokens.gen.ts` | Generated from `src/styles.css` | `tests/unit/scripts/theme-tokens.test.ts`; `scripts/theme-tokens.ts` on `dev` / `build` | On stylesheet change | 2026-09-15 |
| `tests/unit/electron/fixtures/core-client-admission-shim.ts`, `core-client-stderr-shim.ts` | Protocol shims | `tests/unit/electron/core-client.test.ts` | When `CoreClient` protocol changes | 2026-09-15 |

`tests/e2e/fixtures.ts` builds a fresh project, events dir, worlds dir,
user-data dir, and `HOME` per run. It is a harness, not a checked-in
corpus. Isolation is **convention** on pull requests: the full
Playwright matrix is not in `.github/workflows/lint.yml`.

No other `tests/fixtures/` trees exist today.

## Third-party pins (`package.json` / `pnpm-lock.yaml`)

Declared ranges from `package.json`. Lock versions from
`pnpm-lock.yaml` importers. Do not bump them in this watch.

| Package | Declared | Lock (2026-09-15) | Cadence |
|---|---|---|---|
| `electron` | `^37.2.0` | `37.10.3` | Quarterly |
| `vite` | `^7.0.0` | `7.3.6` | Quarterly |
| `monaco-editor` | `^0.56.0` | `0.56.0` | Quarterly |
| `@xterm/xterm` | `^6.0.0` | `6.0.0` | Quarterly |
| `@xterm/addon-fit` | `^0.11.0` | `0.11.0` | Quarterly |
| `@xterm/addon-search` | `^0.16.0` | `0.16.0` | Quarterly |
| `@xterm/addon-webgl` | `^0.19.0` | `0.19.0` | Quarterly |
| `@lydell/node-pty` | `^1.2.0-beta.14` | `1.2.0-beta.15` | Quarterly (beta; native) |
| `typescript` | `^5.8.0` | `5.9.3` | Quarterly |
| `@playwright/test` | `^1.62.1` | `1.62.1` | Quarterly |
| `pnpm` | `packageManager` `pnpm@11.13.1` | corepack activates that version on CI | Quarterly |

Also recorded (same lockfile; not bumped):

| Package | Declared | Lock |
|---|---|---|
| `electron-updater` | `^6.8.9` | `6.8.9` |
| `electron-builder` | `^26.15.3` | `26.15.3` |
| `esbuild` | `^0.25.0` | `0.25.12` |
| `vitest` | `^4.1.11` | `4.1.11` |
| `dompurify` | `3.4.14` (exact) | `3.4.14` (`pnpm-lock.yaml` / `pnpm-workspace.yaml` override) |
| `@types/node` | `22.20.1` (exact) | `22.20.1` |

## CI and packaged runtimes

| Pin | Where | Last checked |
|---|---|---|
| Node `22.23.2` | `lint.yml` and `release.yml` `setup-node`; packaged runtime `PINNED_NODE_VERSION` in `scripts/prepare-resources.ts`; `tests/unit/build/prepare-resources.test.ts` | 2026-09-15 |
| Rust `1.97.1` | `dtolnay/rust-toolchain` in `lint.yml` and `release.yml` | 2026-09-15 |
| pnpm `11.13.1` | `package.json` `packageManager`; `corepack enable` | 2026-09-15 |
| `actions/checkout` `11bd71901bbe5b1630ceea73d27597364c9af683` (v4.2.2) | `lint.yml`, `release.yml` | 2026-09-15 |
| `actions/setup-node` `49933ea5288caeca8642d1e84afbd3f7d6820020` (v4.4.0) | `lint.yml`, `release.yml` | 2026-09-15 |
| `dtolnay/rust-toolchain` `efa25f7f19611383d5b0ccf2d1c8914531636bf9` (v1.2.0) | `lint.yml`, `release.yml` | 2026-09-15 |

`.github/workflows/pages.yml` still uses floating action tags (`actions/checkout@v4`,
`configure-pages@v5`, `upload-pages-artifact@v3`, `deploy-pages@v4`).
That is a website deploy, not a code governor. See deviations.

## Rust crates (`core/Cargo.toml` / `core/Cargo.lock`)

Direct `termina-core` dependencies. Lock versions as of 2026-09-15.
Cadence: quarterly with the JavaScript pins. Do not bump here.

| Crate | `Cargo.toml` | Lock |
|---|---|---|
| `base64` | `0.23.1` | `0.23.1` |
| `flate2` | `1.1.9` | `1.1.9` |
| `git2` | `0.21.0` (feature `unstable-sha256`) | `0.21.0` |
| `libc` | `0.2.189` | `0.2.189` |
| `serde` | `1.0.229` | `1.0.229` |
| `serde_json` | `1.0.151` | `1.0.151` |
| `sha1` | `0.11.0` | `0.11.0` |
| `sha2` | `0.11.0` | `0.11.0` |

`core/` edition is `2024`. CI rustc is `1.97.1`. There is no
`rust-toolchain` / `rust-toolchain.toml` in the tree.

## Retained deviations

Intentional gaps. Reasons only. No new gate.

| Deviation | Reason |
|---|---|
| `@lydell/node-pty` (and `@lydell/node-pty-darwin-arm64`, `-win32-x64`, `-linux-x64`) stays in the esbuild `external` list | Native binding loads at runtime. Bundling it breaks the pty. `scripts/bundle-defs.ts` and `tests/unit/scripts/bundle-defs.test.ts` keep one list. `AGENTS.md` names this gotcha. |
| `electron` and `electron-updater` stay external | Same list: they are the host runtime, not bundle inputs. |
| Preload bundle stays CommonJS (`dist-electron/preload.cjs`) | Sandboxed preloads cannot load ESM. |
| `no-git-cli.sh` is a static tripwire | Dynamic `git` inside `bash -c` strings or MCP configs is out of scope. `tests/` may spawn `git` for fixtures (`tests/e2e/fixtures.ts` does). |
| Rust tests (`pnpm run test:rust`) are not on every pull request | Cost. They run in `test:release` on tags / `workflow_dispatch`. Unit tests still need a **built** core on pull requests. |
| Full Playwright matrix (`pnpm run test:e2e`) is not in pull-request CI | Cost. macOS release runs `test:e2e-release-smoke` only. |
| `cargo clippy` and `cargo fmt --check` are not in CI | Named as convention in `CONTRIBUTING.md`. **Unchecked.** |
| No repo `rust-toolchain` file | CI pins `1.97.1`. A local rustc can differ (this check used 1.83.0). |
| `@lydell/node-pty` is a beta (`^1.2.0-beta.14` → lock `1.2.0-beta.15`) | The app needs a maintained node-pty fork. Keep the pin; do not silently swap implementations. |
| `dompurify` exact `3.4.14` plus pnpm override | Monaco ships a vendored copy. The override and `tests/unit/security/dompurify.test.ts` keep the sanitizer on the installed module. |
| `#123` / `#124` settle gates are gone | Removed in `f77883c`. Do not restore them as implied governors. |
| `#125` laziness metrics stay measurement-only | Fixture rates are not a fail-closed policy. |
| Live provider probes under `scripts/` stay off CI | `scripts/README.md`: they spend money and are not request-path code. |
| `pages.yml` uses floating action tags | Website deploy only. `lint.yml` / `release.yml` pin SHAs. Do not add a pages job to the code gate. |

## Refresh record

| Date | What was read | Bumps |
|---|---|---|
| 2026-09-15 | Workflows, `package.json`, both lockfiles, `scripts/no-git-cli.sh`, `scripts/bundle-defs.ts`, `tests/e2e/fixtures.ts`, `tests/fixtures/traces/laziness-baseline/` (19 files) | None (watch only) |
