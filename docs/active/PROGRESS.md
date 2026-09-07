# PROGRESS.md — Termina session state

> Clock in: read Next Steps. Clock out: update this file. Detail lives in `HARNESS-BACKLOG.md`.

## In progress

- Uncommitted working tree (2026-09-05): `agent-core/main.ts`, `agent-core/tui.ts`, `electron/main.ts`, `shared/types.ts`, `src/editor.ts`, `tests/unit/agent-core/harness-kernel.test.ts` — reconcile on clock-in.

## Next

- AUDIT-REPORT §3 modularization (`electron/main.ts`, `electron/worldlines.ts`, `core/src/main.rs` first).
- Coverage gaps: full harness, provider-change E2E, Rust suite, live probes for the 5 credential-less providers.

## Done (recent)

- Fresh-clone verify (2026-09-06): clean clone @ `34c9c51`, `pnpm install`, esbuild + `vite build` green, vite dev server boots (5199; 5173 held by the live dev session), `test:unit` 312/314 — the 2 failures (`projection`, `session-segmented`) reproduce identically on the main checkout, pre-existing environment issue.
- Release v0.1.33: CI success, Developer ID signing + notarization in the macOS job log, published with assets.
- v0.1.33 UI batch (`42a5fb8`): TUI-only bash approval (host dialog + `bash_approval_request` removed), activity tab bar in the terminal-tabs chip language, worldline header summary (backlog #3), `/new` as a `/clear` alias, hydration tab-yank fix, quick-open walk abort, modal-pick editor focus.
- Provider/model-family refactor (2026-09-06): extracted nine provider modules under `agent-core/auth/providers/`, shared family rules under `agent-core/models/families/`, and protocol-aware capability composition under `models/capabilities.ts`; existing auth, catalog, and serializer public owners remain canonical. Copilot Opus Messages thinking, cross-provider family rules, Go/Zen routing differences, and catalog policy composition have regression coverage. Fresh typecheck → 113 tests across 13 files → Electron/Core and Vite build passed (existing chunk-size warning). Sandbox loopback `EPERM` resolved by rerunning the same isolated fixture suite outside the restriction. Independent review passed after moving OpenAI provider overrides out of the family helper. No full monolithic harness, Electron E2E, Rust tests, or live probes rerun for this agent-only extraction. Installed app unchanged; unrelated edits preserved. Architecture, exact checks, limitations, and current primary-source URLs: [PROVIDER-REFACTOR.md](PROVIDER-REFACTOR.md).
- Other-provider audit (2026-09-05): fixed Copilot catalog-driven protocol selection and nested context limits, xAI tool-free `tool_choice` and non-reasoning effort errors, xAI video picker entries, and hidden Codex catalog entries. Live Codex probes (Sol/Luna/Astra) and corrected Grok probes returned HTTP 200/completed. Zen free model passed; eight paid probes were blocked by insufficient balance. Five providers had no credentials and received documentation/fixture review only. Typecheck → 107 targeted tests across 10 files → Electron/Core and Vite build passed (existing chunk-size warning); `git diff --check` passed. Full monolithic harness not completed; no Electron E2E rerun for these agent-only changes. Existing binaries used after `pnpm exec` attempted reinstall and aborted without a TTY. Details and current primary-source URLs: `PROVIDER-CONFIGURATION-AUDIT.md`. Installed app unchanged; unrelated edits preserved. Large owner files assessed; changes remain local to existing provider responsibilities.
- Go all-model audit (2026-09-05): all 35 live catalog entries probed with synthetic 32-token requests using patched routing; 31 returned HTTP 200 (DeepSeek Flash after one timeout/retry), four older catalog entries reported upstream unavailability. No further protocol mismatch found. Endpoint tests now cover all 28 documented Go models plus three Zen MiniMax guards. Typecheck → 39 focused unit tests → build passed; E2E not rerun for test/docs-only follow-up. Details: `OPENCODE-GO-AUDIT.md`. Installed app remains unchanged.
- OpenCode Go / Pi startup fixes (2026-09-05, uncommitted): Go now uses model-specific protocols (MiniMax uses Messages on Go), per https://opencode.ai/docs/go/#endpoints and https://opencode.ai/docs/zen/#endpoints. Failing Muse Spark traces used Completions; a synthetic Responses probe returned HTTP 200/completed. Fresh Pi tabs use Pi defaults unless copying another Pi tab, avoiding Core-only `opencode-zen` names that exit Pi with code 1. Verified typecheck → 42 focused unit tests → build → 4 Electron tests, including the startup regression failing before/passing after. Sandbox blocked local HTTP/Electron initially; those checks passed outside it. Broad unit/harness attempts were interrupted after stalling; full suite not completed. Installed `/Applications/Termina.app` has not been replaced. Existing unrelated edits preserved; large owner files assessed, changes remain local routing/launch policy.
- Activity tabs below terminal (`828d96f`); backlog #1 implemented.
- Quick open + command palette (`c1536d0`); backlog #2 implemented.
- Terminal fit coalesce behind explicit font load (`c0cafdd`); backlog #4 implemented.
- Bash approval is TUI-only (`42a5fb8`); the host dialog from `13158e5` was removed.
- Model resume pin; boot loads all catalogs (`01da0c4`).
