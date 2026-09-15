# Clean Code / YAGNI / KISS — renderer (`src/` + `tests/unit/ui/`)

**Audit only.** No production or test edits. No GitHub issues. No refactors.

Walked `main` at `f66decf` (2026-09-15). Domain is exclusive: the renderer tree and its unit tests. `electron/preload.ts` was read only to compare the `window.termina` surface with renderer callers.

## Scope

| In | Out |
|---|---|
| `src/**` text sources (`*.ts`, `styles.css`, `index.html`) | `electron/`, `agent-core/`, `core/` |
| `tests/unit/ui/**` | `docs/audits/2026-09-13/` (not on `main`; not imported) |
| `electron/preload.ts` (bridge surface vs callers) | `src/theme-tokens.gen.ts` (generated; not a hand-edit target) |
| | `src/assets/fonts/*` (binaries; not reviewed) |
| | `node_modules/`, `dist/` |

House rules applied: `src/` owns rendering and transient UI state; privileged work goes through preload; tokens live in `src/styles.css` `:root` / `html[data-theme]`; terminal stays the source of truth; never expose sidecars / leases / core protocol in the UI; extract past 800 lines only when a distinct pane lifecycle exists.

## Already ticketed — do not re-open

| Ticket | Why it is not a new renderer finding |
|---|---|
| **#323** | `electron/main.ts` god-file split. Not this tree. |
| **#324** | `agent-core/main.ts` split. It *mentions* `src/main.ts` 3054 and `src/editor.ts` 1100 as related oversize, but the ticket is the agent-core cut. |
| **#326** | Includes renderer `applyPreferences(next, persist, activateShortcuts, confirmReset)` in `src/main.ts:788`. Style cleanup, already listed. |
| **#327** | Stale sidecar / terminal-runtime *docs*. Not renderer code. |
| **#335** | Unused / test-only exports repo-wide. Renderer samples below are the `#335` slice for this tree, not a new ticket. |

`src/main.ts` is a **review trigger** (3054 lines, ~3.8× the 800-line line). Activity, timeline, and the terminal-type menu already live under `src/main/`. Further extraction is justified only for a remaining distinct pane lifecycle — not a clone of #323/#324.

## Ledger counts

Every in-scope text path appears once. Walk = inventory = matched.

| Field | Count |
|---|---|
| Walked production text | 35 |
| Walked `tests/unit/ui` | 33 |
| **Walked / inventory / matched** | **68** |
| Production lines | 16,107 |
| Test lines | 4,496 |
| **Lines reviewed** | **20,603** |
| Named `export` symbols in `src/` (gen skipped) | 159 |
| Used from another production file | 93 |
| Test-only (imported outside the defining file only by tests) | 24 |
| Unused outside the defining file | 42 |
| `window.termina` methods with no production renderer caller | 3 |
| Renderer-scope commands unregistered | 0 |
| Section-banner comments in `src/main.ts` | 13 |
| Functions / constructors with 4+ value arguments | 11 |
| Confirmed findings (this report) | 12 |
| Already-ticketed cites (not new) | 2 (#326, #335) |
| Unknown items | 0 |

Skipped, not in the 68: `src/theme-tokens.gen.ts` (91 lines, generated), `src/assets/fonts/DepartureMono-Regular.woff`, `src/assets/fonts/DepartureMono-Regular.woff2`.

## Inventory

### Production (35)

| Lines | Path | Role |
|---:|---|---|
| 3054 | `src/main.ts` | Renderer entry: projects, panes, prefs, commands, layout, IPC glue |
| 3594 | `src/styles.css` | Tokens + chrome |
| 1100 | `src/editor.ts` | Monaco tabs / save / mine / snapshots |
| 798 | `src/worldlines.ts` | Worldlines panel |
| 793 | `src/components/explorer.ts` | File tree |
| 609 | `src/pty-view.ts` | xterm pane |
| 579 | `src/timeline.ts` | Timeline dots |
| 444 | `src/settings.ts` | Settings modal |
| 431 | `src/review.ts` | Change Review |
| 373 | `src/quick-open.ts` | Quick Open / content / palette |
| 348 | `src/terminal-links.ts` | PTY file-link parse |
| 329 | `src/main/activity-pane.ts` | Plan + modified |
| 303 | `src/components/explorer-keyboard.ts` | Explorer keys |
| 300 | `src/worldline-project-state.ts` | Worldline pane field apply |
| 294 | `src/explorer-file.ts` | Pure explorer path/icon helpers |
| 288 | `src/components/modals.ts` | Confirm / input / toasts |
| 276 | `src/activity-tabs.ts` | Activity tab reducer + DOM |
| 230 | `src/main/timeline-pane.ts` | Timeline IPC |
| 216 | `src/index.html` | Shell + first-paint splash |
| 208 | `src/main/terminal-menu.ts` | New-terminal menu |
| 196 | `src/session-search.ts` | Session Search modal |
| 191 | `src/components/explorer-refresh.ts` | Watcher refresh |
| 178 | `src/worldline-evidence.ts` | Evidence copy |
| 142 | `src/terminal-themes.ts` | xterm palettes |
| 139 | `src/pty-sequence-ledger.ts` | PTY sequence admission |
| 138 | `src/components/explorer-filter.ts` | Explorer filter |
| 121 | `src/components/context-menu.ts` | Context menu |
| 114 | `src/components/explorer-content.ts` | Content-search hits |
| 85 | `src/components/explorer-rows.ts` | Row DOM |
| 80 | `src/settings-shortcuts.ts` | Shortcut format / capture |
| 47 | `src/preferences-boot.ts` | Prefs boot retry |
| 36 | `src/commands.ts` | Command dispatcher |
| 35 | `src/known-state.ts` | IPC-state allowlists |
| 30 | `src/editor-language.ts` | Monaco language id |
| 8 | `src/global.d.ts` | `window.termina` typing |

### Tests (33)

| Lines | Path |
|---:|---|
| 466 | `tests/unit/ui/explorer-file.test.ts` |
| 335 | `tests/unit/ui/worldline-project-ownership.test.ts` |
| 305 | `tests/unit/ui/fake-dom.ts` |
| 252 | `tests/unit/ui/worldline-caps.test.ts` |
| 250 | `tests/unit/ui/terminal-links.test.ts` |
| 228 | `tests/unit/ui/activity-tabs.test.ts` |
| 213 | `tests/unit/ui/chrome-ux.test.ts` |
| 212 | `tests/unit/ui/surface-toasts.test.ts` |
| 194 | `tests/unit/ui/timeline-progress.test.ts` |
| 183 | `tests/unit/ui/renderer-core-hardening.test.ts` |
| 170 | `tests/unit/ui/ipc-rejections.test.ts` |
| 161 | `tests/unit/ui/pane-resize.test.ts` |
| 146 | `tests/unit/ui/renderer-hardening.test.ts` |
| 139 | `tests/unit/ui/modals-aria.test.ts` |
| 123 | `tests/unit/ui/e2e-navigation-harness.test.ts` |
| 121 | `tests/unit/ui/instance-summary.test.ts` |
| 97 | `tests/unit/ui/editor-deleted-conflict.test.ts` |
| 97 | `tests/unit/ui/editor-save-ack.test.ts` |
| 92 | `tests/unit/ui/quick-open-aria.test.ts` |
| 72 | `tests/unit/ui/project-editor-routing.test.ts` |
| 69 | `tests/unit/ui/review-identity.test.ts` |
| 68 | `tests/unit/ui/editor-canonical-path.test.ts` |
| 66 | `tests/unit/ui/preferences-boot.test.ts` |
| 62 | `tests/unit/ui/modals-input.test.ts` |
| 58 | `tests/unit/ui/review-accept.test.ts` |
| 54 | `tests/unit/ui/verify-attention.test.ts` |
| 53 | `tests/unit/ui/explorer-refresh-canonical.test.ts` |
| 52 | `tests/unit/ui/known-state.test.ts` |
| 48 | `tests/unit/ui/menu-tui-scope.test.ts` |
| 42 | `tests/unit/ui/timeline-keyboard.test.ts` |
| 30 | `tests/unit/ui/e2e-plan-board-shape.test.ts` |
| 24 | `tests/unit/ui/worldline-actions.test.ts` |
| 14 | `tests/unit/ui/worldline-summary.test.ts` |

## Findings

### R1 — Status bar and timeline print lease / sidecar reason tokens

**KISS / product rule.** `presentActivity` in `src/main.ts:1272-1281` interpolates the raw activity reason into the status bar (`blocked: ${reason}`). `TimelineView.setPrefix` (`src/timeline.ts:113-120`) and `tooltip` (`src/timeline.ts:458-465`) do the same. The allowlist in `src/known-state.ts:29-35` includes `lease-wait` and `sidecar-paused`.

Those strings are main-owned protocol. House rule: never expose sidecars / leases / core protocol in the UI. A blocked agent should read as blocked (or a user phrase), not as a lease or sidecar name.

`writerId` stays on the flush IPC path and is not shown. Recorder labels (`indexing` / `paused` / `degraded` / `budget`) are product copy, not this leak.

### R2 — `src/main.ts` is still three chrome lifecycles in one file

**Clean Code / 800-line trigger.** 3054 lines, 13 section banners (`commands`, `layout`, `terminal find`, `split pane`, `agent events`, `worldlines`, `startup`, …). Comments do not replace modules.

Already extracted with a distinct pane lifecycle:

- `src/main/activity-pane.ts` (plan + modified + their IPC)
- `src/main/timeline-pane.ts` (timeline fetch / merge / trim)
- `src/main/terminal-menu.ts` (＋ menu)

Still inlined, each with its own state machine:

| Slice | Approx. | Why it is a lifecycle |
|---|---|---|
| Preferences boot / paint / persist | `770-880` | Generation fence, sticky banner, settings callbacks |
| Layout + three divider drags | `1592-1800`, `2240-2438` | localStorage layout, explorer/terminal/editor minimize, modified-list resize |
| Terminal find bar | `1931-2048` | Own DOM, decorations, ResizeObserver |

Do **not** split the rest of `main.ts` as a #323-style god-file ticket. Project tabs, roster apply, and `window.termina.on*` wiring are renderer orchestration and belong at the entry. Extract only the three slices above (or leave them) — one owner each, no parallel path.

Largest remaining functions: `createPaneShell` ~121 lines (`882-1003`), `boot` ~84 (`2968-3052`). Dense, not a second abstraction.

### R3 — Unused and test-only exports (renderer slice of #335)

**YAGNI.** 42 exports are unused outside the defining file; 24 are test-only. Do not bulk-delete. `#335` already owns triage.

**Unused outside the defining file (un-export or keep with a reason):**

| File | Symbols |
|---|---|
| `src/worldline-project-state.ts` | `WorldlineProjectPane`, `WorldlineLabeledPane`, `refreshWorldlinePaneLabel`, `WorldlineCandidateTestPane`, `WorldlineCandidateTestBindings`, `WorldlineProjectEffects`, `WorldlineTabBadge`, `WorldlineBusyPane`, `WorldlineBusyBindings`, `WorldlineInstancesBindings` |
| `src/activity-tabs.ts` | `ActivityTab`, `ACTIVITY_TAB_KEY`, `ActivityTabState`, `ActivityTabEvent`, `ActivityTabsDeps` |
| `src/pty-sequence-ledger.ts` | `PtySequenceRecord`, `PtySequenceResult`, `PtySequenceLedgerOptions`, `PtySequenceLedgerStats` |
| `src/main/{activity,timeline,terminal-menu}-pane.ts` | host `*State` / `*Bindings` / `*Elements` interfaces (9) |
| `src/components/explorer-{refresh,content,filter,keyboard}.ts` | `*Host` interfaces (4) |
| `src/preferences-boot.ts` | `PREFS_BOOT_RETRY_DELAY_MS`, `PrefsBootResult`, `LoadPreferencesOptions` |
| `src/explorer-file.ts` | `FileIconKind`, `ChangedPaneSource` |
| `src/commands.ts` | `CommandHandler` |
| `src/quick-open.ts` | `QuickOpenMode` |
| `src/terminal-links.ts` | `ParsedTerminalFileLink`, `parseTargetReference` |
| `src/known-state.ts` | `UnknownState` |

`refreshWorldlinePaneLabel` and `parseTargetReference` are live internals that do not need to be public. `PtySequenceLedger.stats()` (`src/pty-sequence-ledger.ts:131`) has **zero** callers — dead method, not just a dead type.

**Test-only (keep only if a behavioral test pins them — `#335` policy):**

`activity-tabs.ts` reducer API (`ACTIVITY_TABS`, `reduceActivityTab`, `stepActivityTab`, `activityEmptyVisible`, …) — `tests/unit/ui/activity-tabs.test.ts` is the pin, legitimate.

Also test-only: `stepTimelineIndex`, `extensionOf`, `paletteRowDetail`, `WORLDLINE_PAIR_ROLES_LINE`, `MAX_INLINE_CHANGED_ROWS`, `MAX_FILE_LIST_MODAL_ROWS`, `parseTerminalFileLinks`, `cellColumnsForLine`, `UNKNOWN_STATE`, `PREFS_BOOT_ATTEMPTS`, `prefsBootErrorMessage`, `WorldlineLabel`, `WorldlineInstancePane`, `PTY_RENDERER_SEQUENCE_GAP_WINDOW` (electron unit), `TERMINAL_THEMES` (agent-core harness).

### R4 — Long argument lists beyond #326

**Clean Code (3+ needs justification).** `#326` already lists `applyPreferences`. Renderer also has:

| Site | Args |
|---|---|
| `PtyView` constructor `src/pty-view.ts:50-59` | **9** (container + 6 callbacks + appearance + optional open-file) |
| `applyWorldlineHydration` `src/worldline-project-state.ts:272-278` | **6** |
| `openFileSmart` / `openFileSmartInner` `src/main.ts:1449-1471` | **5** |
| `EditorManager` constructor `src/editor.ts:205` | **5** |
| `makeModal` `src/components/modals.ts:73-78` | **5** |
| `renderAcceptedPtyRecords` `src/main.ts:2442-2448` | **5** |
| `applyWorldlineRemoval` | 4 |
| `worldlineHeaderSummary` | 4 |
| `isMarkedChanged` | 4 |
| `showFileListModal` | 4 |
| `ReviewView.show` | 4 |

`PtyView` is the only one that is hard to read at the call site (`src/main.ts:912-937`). A single deps object would match `ActivityTabsDeps` / pane bindings. The rest are optional last args or already-ticketed style.

### R5 — Blocked-reason copy is derived twice

**Duplicate derivation.** The same `asKnownState` + `` `blocked: ${reason}` `` sentence is built in:

1. `presentActivity` (`src/main.ts:1272`) — status bar + tab tooltip
2. `TimelineView.setPrefix` (`src/timeline.ts:113`) — prefix chip
3. `TimelineView.tooltip` (`src/timeline.ts:458`) — newest-dot title

Main owns `pane.activity`. Timeline also stores `this.activity` from the prefix payload. Two owners for one semantic. One present-function (even a 10-line helper next to `known-state.ts`) would close the drift that produced R1 in three places.

### R6 — Two test-command caches

**Duplicate state.** Workspace detect lives in module globals `testCommand` / `testCommandRequestToken` (`src/main.ts:1315-1342`). Candidate detect lives on `pane.testCommand` / `pane.candidateTestEpoch` via `refreshWorldlineCandidateTest`. `renderVerify` then does `pane.testCommand ?? testCommand` (`1354`).

The fallback is the product rule (candidate tree vs project tree). The smell is the extra global plus `__refreshTestCommand` / `__getTestCommand` test hooks. The pane field plus “no label ⇒ project detect” is enough.

### R7 — Dead modal-option CSS

**YAGNI.** `src/styles.css:3194-3214` defines `.modal-options`, `.modal-option`, `.modal-option:hover`. No TS or HTML assigns those classes. `modals.ts` builds confirm/input/file-list only. Leftover from the file header’s “pi's extension UI protocol (select/confirm/input/editor)” (`src/components/modals.ts:2`) — that select list is gone.

Dynamic class names (`state-${…}`, `rec-${…}`, `verdict-${…}`, `evidence-${…}`, `toast-${…}`, `t-${…}`, `tool-${…}`) are live. Do not treat those as dead.

`--selection` is unused in the stylesheet on purpose (`src/styles.css:27-29`); Monaco / xterm read it through generated tokens. Not dead.

### R8 — Parallel theme tables (no new themes)

**Reuse.** Canonical tokens are `:root` / `html[data-theme]` in `src/styles.css`. `theme-tokens.gen.ts` is the generated TS view — correct.

Extra palettes that re-state hues:

| Table | What is extra |
|---|---|
| `src/terminal-themes.ts` `CORE_EXTENDED` | Per-theme hex triples for agent-core ANSI |
| `src/terminal-themes.ts` `darkTerminal` / friends | Magenta/cyan literals with “no token counterpart” |
| `src/editor.ts:31-96` | Monaco `termina-dark` / `termina-atom` plus one-off hex (`#3f4930`, `#2c313c`, `#528bff`, `#495162`, `56b6c2`) |
| `src/index.html:10-58` | Splash hard-codes dark `#0b0d09` / `#b8f04a` (first-paint; acceptable) |
| `html[data-theme="atom"]` | Omits `--on-accent` (inherits `:root` `#10130a`). The other three themes set it. |

Do not add a fifth theme. If anything moves, fold the remaining literals into the generated token set or document each as ANSI-only once.

### R9 — Three `window.termina` methods unused by production renderer

**Unused wrappers (bridge vs callers).** Preload exposes the full `TerminaBridge`. Renderer production never calls:

| Method | Who does call it |
|---|---|
| `readClipboard` | `tests/e2e/terminal-clipboard.spec.ts` via `page.evaluate` |
| `cancelWorldline` | `tests/e2e/worldlines.spec.ts` (nonexistent id). UI has Discard, not Cancel. |
| `projectOpenPath` | e2e fixtures (`explorer`, `resize`, `multiproj`) |

These are not unused *renderer* functions — there is no local wrapper. They are bridge surface the UI does not use. `cancelWorldline` is the only product-shaped gap (in-flight cancel vs discard). Do not add a Cancel button from this audit. Trimming the bridge is an electron/types change, out of this domain.

Every other preload method has a production caller in `src/`.

### R10 — All renderer-scope commands are registered

**Hunt: unused UI commands — none found.** `shared/commands.ts` marks `open-folder`, `close-window`, `close-terminal`, `abort-terminal` as `scope: "main"`. The palette filters those out (`src/quick-open.ts:311-315`) so they cannot silently no-op. Every `scope: "renderer"` id is `commands.register`’d in `src/main.ts`. Settings lists all definitions so main-scope shortcuts can still be rebound. That is intentional, not speculative chrome.

### R11 — Settings are not speculative

**YAGNI — clean.** General is one checkbox (`autoOpenAgentFiles`). Appearance is theme / type / wrap / minimap. Keyboard is the command table. `showThinking` is a preference persisted by `toggle-thinking` and the terminal context menu, not a settings row — progressive disclosure, not a missing page.

Worldlines already hide Challenge / Evidence / Export / Discard behind `⋯` (`src/worldlines.ts:3-5`). Keep that.

### R12 — Near-800 files and stale section comments

**Review trigger, not a split ticket.**

| File | Lines | Note |
|---|---:|---|
| `src/worldlines.ts` | 798 | One view; `makeCard` / `fillDetails` / actions are one lifecycle |
| `src/components/explorer.ts` | 793 | Already split into filter / keyboard / refresh / content / rows |
| `src/editor.ts` | 1100 | Cited on #324 as related oversize; `EditorManager` is the owner |
| `src/styles.css` | 3594 | 15 section banners; tokens stay here |

Stale comments (clean-up only, no behavior):

- `src/activity-tabs.ts:2` and `src/styles.css:1054` — `HARNESS-BACKLOG #1`
- `src/components/modals.ts:2` — “pi's extension UI protocol”
- `src/editor.ts:784` — documents write-lease bypass in a renderer comment (implementation detail; do not surface in UI)

`window.__projectViews`, `__editorMgr`, `__panes`, `__openSettings`, `__timelineView`, `__sessionSearch`, `__refreshMine`, `__refreshTestCommand`, `__getTestCommand`, `__terminalFocusScope`, `__timelineTab`, `__reviewDebug` are e2e seams. Established, not YAGNI. Do not add more.

Status-badge `A`/`M`/`D` is copy-pasted in `activity-pane.ts:194`, `modals.ts:261`, `worldlines.ts:705`. Incidental; not a second owner.

`src/main.ts:1430` `normalizePath` (`..` collapse) is not a second `canonicalizePath` (macOS `/tmp` alias). Different rules.

## Tests (`tests/unit/ui/`)

The suite matches the tree: reducer pins for activity tabs, worldline pane apply, explorer path math, terminal links, prefs boot, IPC rejection AST walk (`ipc-rejections.test.ts` — good; not a source-string inventory).

Source-string tests (`activity-tabs.test.ts` reads HTML/CSS/TS; `instance-summary.test.ts` / `worldline-project-ownership.test.ts` read `worldline-project-state.ts`) pin structure. That is why so many activity-tab and worldline types stay exported. Triage with `#335`, do not delete the pins.

`fake-dom.ts` (305) is the shared DOM stub. One owner. Fine.

No test-only *production* path (no `if (e2e)` feature flags in `src/`).

## What is already in good shape

- Privileged fs / pty / snapshot work stays on `window.termina`; renderer does not spawn `git`.
- Activity / timeline / terminal-menu extractions follow “one pane lifecycle → one module.”
- `known-state.ts` is the single allowlist owner (the leak is *display* of two tokens, not a second table).
- `explorer-file.ts` is the single visual-kind table; `editor-language.ts` stays the language map.
- Quick Open does not execute main-scope commands.
- Token pipeline (`styles.css` → `scripts/theme-tokens.ts` → `theme-tokens.gen.ts`) is the one color owner for chrome.
- Incremental worldline / modified-list DOM updates; no second list model.

## Suggested order if someone later remediates

Audit only — this is priority, not work.

1. Map `lease-wait` / `sidecar-paused` to user copy (or omit the reason) in **one** helper; use it from status + timeline. Closes R1 + R5.
2. Un-export the `#335` renderer internals that tests do not pin (`refreshWorldlinePaneLabel`, host interfaces, `parseTargetReference`, `stats()`).
3. Delete `.modal-options` / `.modal-option` and the “pi's extension” header.
4. Param-object `PtyView` constructor if a pane file is touched anyway.
5. Extract prefs / layout / find from `src/main.ts` only with a distinct lifecycle and tests — not a #323 clone.

Do not invent settings, themes, or a Cancel Worldline button from this list.

## Checks this audit ran

- Full `src/` + `tests/unit/ui/` path walk and line counts (`wc` / directory walk).
- Named-export usage across `src/` and `tests/`.
- `window.termina` method usage vs `electron/preload.ts`.
- `COMMAND_DEFINITIONS` vs `commands.register`.
- CSS class / id mention scan (dynamic `state-*` / `rec-*` / `verdict-*` treated as live).
- 4+ argument signature scan; function-size scan on the large files.
- Read of preload, `known-state`, activity / worldline / settings / explorer / editor / timeline owners, and `#323` `#324` `#326` `#327` `#335` issue text.

No `pnpm` typecheck, unit, or e2e — documentation-only deliverable.
