# scripts/

Build, dev, and diagnostic entry points. Run with `node --experimental-strip-types --no-warnings scripts/<name>.ts`.

- `build.ts` — bundles main/preload/agent-core with esbuild (runs before `vite build`; also regenerates the theme tokens — see below).
- `dev.ts` — development launcher. `build-core.ts` — Rust core build. `prepare-resources.ts` — packaged-app resources.
- `theme-tokens.ts` — parses the theme blocks out of `src/styles.css` into `src/theme-tokens.gen.ts`, the module the terminal and Monaco palettes import. Runs on every build; `tests/unit/scripts/theme-tokens.test.ts` fails when the checked-in output goes stale. Never hand-edit the `.gen.ts` file.
- `spike.ts` — bundles one file from `scripts/spikes/` and runs it under plain Node (`pnpm run spike -- <name>`).
- `prefix-measure.ts [project-root]` — read-only system-section byte counts plus synthetic deferred-MCP and cross-prompt overlay measurements. No provider calls, token estimates, or instruction text in its output. See `docs/reference/AGENT-CORE.md` for the baseline and limitations.

## Release-gate spikes (kept)

`scripts/spikes/` is not a scratch pad. The remaining files are the only owners of `test:native`, `test:promotion-native-boundary`, `test:release-macos`, and `test:spikes`. Those scripts are the portable native layer of `test:release` and the macOS packaging layer. Do not delete them.

- `owned-fixtures.ts` — shared teardown registry. `spike.ts` and every remaining spike import it.
- `capture.ts` — `test:native` / `test:release` / `test:spikes`.
- `merge.ts` — `test:native` / `test:release` / `test:spikes`.
- `tree-delta.ts` — `test:native` / `test:release` / `test:spikes`.
- `gitignore.ts` — `test:native` / `test:release` / `test:spikes`.
- `terminal-roster.ts` — `test:native` / `test:release` / `test:spikes`.
- `core-session-promotion.ts` — `test:native` / `test:release` / `test:spikes`.
- `promotion-transaction.ts` — `test:native` / `test:release` / `test:spikes`.
- `watcher-idle.ts` — `test:native` / `test:release` / `test:spikes`.
- `promotion-native-boundary.ts` — `test:promotion-native-boundary` (also last step of `test:native`).
- `platform.ts` — `test:release-macos` and `test:spikes`. Not in the Ubuntu `test:native` graph.

Throwaway spikes with no `package.json` / CI owner were deleted (#325): `core-latency-probe`, `core-inc-bisect`, `tree-format-validate`, `divider-probe`, `store-lifecycle`, `owned-cleanup`, `promotion-retention`.

## Live provider probe (kept deliberately)

One opt-in diagnostic. It prints its own usage, spends at most a few cents, touches no session state, and is intentionally **not** wired into `package.json`, CI, or any request path.

- `codex-cache-probe.ts` + `codex-cache-probe-transport.ts` — Codex cache identity/transport/mode matrix (has unit tests). Keep-reason: `agent-core/auth/cache-identity.ts` still cites this live evidence, and the experiment is not a CI gate. Delete it when that contract is fully encoded in `agent-core/` tests.

Per-provider one-offs were deleted (#325): `codex-breakpoint-probe`, `codex-comparison-probe`, `opencode-cache-probe`, `xai-cache-probe`. Their session-header contracts live in `agent-core/auth/cache-identity.ts`.
