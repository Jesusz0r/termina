# scripts/

Build, dev, and diagnostic entry points. Run with `node --experimental-strip-types --no-warnings scripts/<name>.ts`.

- `build.ts` — bundles main/preload/agent-core with esbuild (runs before `vite build`; also regenerates the theme tokens — see below).
- `dev.ts` — development launcher. `build-core.ts` — Rust core build. `prepare-resources.ts` — packaged-app resources.
- `theme-tokens.ts` — parses the theme blocks out of `src/styles.css` into `src/theme-tokens.gen.ts`, the module the terminal and Monaco palettes import. Runs on every build; `tests/unit/scripts/theme-tokens.test.ts` fails when the checked-in output goes stale. Never hand-edit the `.gen.ts` file.

## Live provider probes (kept deliberately)

Small, self-documenting diagnostics that validate provider cache/behavior contracts against the live APIs. Each prints its own usage, spends at most a few cents, touches no session state, and is intentionally **not** wired into `package.json`, CI, or any request path. Keep them while their roadmap questions stay open; delete a probe when its contract is settled and encoded in `agent-core/`.

- `codex-breakpoint-probe.ts` — explicit-breakpoint acceptance boundary on the Codex Responses route.
- `codex-cache-probe.ts` — Codex cache identity/transport/mode matrix (has unit tests).
- `codex-comparison-probe.ts` — follow-up comparison arm (has unit tests).
- `opencode-cache-probe.ts` — cache behavior on the OpenCode Go relay.
- `xai-cache-probe.ts` — xAI stable-key acceptance and retention.
