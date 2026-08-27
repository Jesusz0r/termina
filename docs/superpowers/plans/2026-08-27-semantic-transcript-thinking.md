# Semantic Transcript and Thinking Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace agent-core's flat monochrome transcript with bounded semantic assistant, thinking, tool, and error entries, and make provider-supplied thinking visible by default with one persisted hide/show command.

**Architecture:** `AgentTui` owns the private transcript model, incremental sanitizer, Markdown spans, terminal-cell wrapping, caches, scroll anchors, and ANSI painting. `agent-core/main.ts` sends semantic lifecycle calls while preserving plain non-TTY output and existing session/sidecar data. Main owns one serialized preference-patch commit path and transmits the persisted thinking state to core terminals through a startup flag or fixed private CSI command.

**Tech Stack:** TypeScript 5.8, Node.js, ANSI/xterm 5.5, Electron menus and IPC, existing agent-core harness and Electron E2E scripts.

**Spec:** `docs/superpowers/specs/2026-08-27-terminal-images-semantic-transcript-design.md`

**Prerequisite:** Complete `docs/superpowers/plans/2026-08-27-terminal-file-drop.md` first. Both plans touch `agent-core/main.ts`, `agent-core/tui.ts`, `electron/main.ts`, `src/main.ts`, and shared bridge types; this order keeps their canonical migrations linear.

## Global Constraints

- Keep semantic transcript state private to `AgentTui`; do not add a renderer chat model, IPC transcript, or session format.
- Render only provider-supplied visible thinking/reasoning; never expose encrypted reasoning or invent chain-of-thought.
- Keep `MAX_TRANSCRIPT = 400_000` and add `MAX_TRANSCRIPT_ENTRIES = 2_000`.
- Parse only paragraphs, line breaks, emphasis, strong emphasis, inline code, fenced code, headings, ordered/unordered lists, and block quotes.
- Treat raw HTML, tables, Markdown images, unsupported nesting, and unclosed streaming delimiters as literal text.
- Add no Markdown, Unicode-width, styling, or state dependency.
- Keep parsing and painting linear/bounded and the existing 16 ms coalesced paint schedule.
- Apply extended palette indices 16/17/18 only to core xterm instances.
- Extended index 16 is pending, 17 is success, and 18 is error; textual status remains visible without color.
- Default `showThinking` to `true`; default shortcut is `CmdOrCtrl+Shift+H`.
- Preserve session JSONL, provider blocks, sidecar schema, Pi behavior, and non-TTY readability.
- Migrate internal callers and remove the flat semantic output path; do not leave a compatibility renderer.
- Preserve the user's existing uncommitted changes and integrate them instead of reverting them.
- Use ASD-STE100 comments for new or changed comments.

---

## File Structure

- Modify `agent-core/tui.ts`: private semantic entries, sanitizer, bounds, width, Markdown, caches, scrolling, private CSI, and paint roles.
- Modify `agent-core/main.ts`: semantic stream and tool lifecycle calls, cancellation, non-TTY fallback, and startup flag parsing.
- Modify `src/terminal-themes.ts`: standard palettes plus core-only extended semantic entries.
- Modify `src/pty-view.ts`: remember terminal engine and apply the correct palette before/after engine discovery.
- Modify `shared/types.ts`: `showThinking` and typed user preference patches.
- Modify `shared/preferences.ts`: canonical default, patch filtering, and complete normalization.
- Modify `shared/commands.ts`: `toggle-thinking` command.
- Create `shared/terminal-control.ts`: one canonical startup argument and private CSI constants shared by main and agent-core.
- Modify `electron/main.ts`: serialized preference commits, core launch flag, checked Terminal menu item, and live CSI updates.
- Modify `electron/preload.ts`: migrate the existing preference bridge to patches.
- Modify `src/main.ts`: patch-producing Settings flow, thinking command, context menu, and post-save apply.
- Modify `scripts/agent-core-harness-test.mjs`: transcript, sanitizer, Markdown, width, tools, CSI, bounds, and non-TTY coverage.
- Modify `scripts/settings-test.mjs`: preference, command, menu, race, and persistence coverage.
- Modify `docs/AGENT-CORE.md`: semantic transcript and thinking-control behavior.

### Task 1: Introduce the private semantic transcript and bounded sanitizer

**Files:**
- Modify: `agent-core/tui.ts:215-405, 880-995`
- Test: `scripts/agent-core-harness-test.mjs:2468-2740`

**Interfaces:**
- Produces these public `AgentTui` operations:
  ```ts
  export type TranscriptHandle = Readonly<{ entryId: number; token: symbol }>;
  export type ToolTranscriptState = "success" | "error" | "cancelled";

  appendPlain(text: string): void;
  appendAssistant(text: string): void;
  appendThinking(text: string): void;
  startTool(name: string, detail: string): TranscriptHandle;
  finishTool(handle: TranscriptHandle, state: ToolTranscriptState, output?: string): void;
  appendError(text: string): void;
  cancelPendingTools(): void;
  setThinkingVisible(visible: boolean): void;
  ```
- Removes public `append(text)` after all callers migrate in Task 3.
- Keeps `frame()` as the plain frame inspection API used by the harness.

- [ ] **Step 1: Write failing semantic ordering and bound tests**

  Instantiate `AgentTui`, append assistant/thinking/plain/error entries, start two tools, finish them out of order through their returned handles, and assert `frame()` keeps insertion order and one visual tool entry per handle. Add empty/duplicate provider-ID-independent cases by using identical names/details. Append 2,100 one-character settled entries and assert the oldest are evicted. Append one 410,000-character active assistant entry and assert a truncation marker plus a Unicode-safe line-boundary tail.

- [ ] **Step 2: Write failing incremental sanitizer tests**

  Feed CSI, OSC, DCS, C1, and single-character escapes split across chunks through `appendAssistant`. Include malformed/overlong escapes followed by `SAFE`. Assert no escape survives and `SAFE` remains. Repeat through `finishTool` output and `appendError`.

- [ ] **Step 3: Run the harness to verify failure**

  Run: `npm run test:agent-core`

  Expected: FAIL because semantic methods and entry-count bounds do not exist.

- [ ] **Step 4: Replace `plain` with one private entry collection**

  Use a discriminated private union with monotonic local IDs, settled state, sanitized text, optional tool state, and per-width render cache. Track active assistant/thinking IDs and a `Map<TranscriptHandle, toolEntryId>`. Merge consecutive active chunks, close streams on section changes, never evict pending tools, delete cache/handle indexes on eviction, and truncate only an over-budget active stream.

- [ ] **Step 5: Implement one bounded incremental sanitizer**

  Store sanitizer state per active streamed entry. Cap an escape sequence at the existing `MAX_CSI = 32` or a named equivalent used by all escape families. Remove complete terminal control sequences and remaining controls except newline/tab. On malformed or overlong input, reset sanitizer state and resume at the next ordinary character.

- [ ] **Step 6: Run the harness**

  Run: `npm run test:agent-core`

  Expected: PASS for semantic ordering, handle identity, eviction, truncation, and sanitizer tests; pre-existing TUI tests remain green.

- [ ] **Step 7: Commit the model**

  ```bash
  git add agent-core/tui.ts scripts/agent-core-harness-test.mjs
  git commit -m "refactor: add semantic agent transcript"
  ```

### Task 2: Add one cell-width primitive and incremental Markdown renderer

**Files:**
- Modify: `agent-core/tui.ts:140-230, 880-995`
- Test: `scripts/agent-core-harness-test.mjs:2468-2740`

**Interfaces:**
- Consumes: transcript entries and invalidation from Task 1.
- Produces exported testable width operations already owned by the TUI module:
  ```ts
  export function cellWidth(text: string, startColumn?: number): number;
  export function wrapText(text: string, width: number): string[];
  ```
- Produces private `StyledSpan = { text: string; style: number }` and cached rendered rows keyed by entry revision plus terminal width.

- [ ] **Step 1: Replace code-point width assertions with failing cell-width cases**

  Cover combining `e\u0301`, CJK `界`, emoji and emoji ZWJ sequences, variation selectors, tabs at columns 0 and 3, clipping at a wide-character boundary, box padding, and cursor position after mixed-width input. Assert no grapheme is split.

- [ ] **Step 2: Add failing Markdown frame cases**

  Cover `*em*`, `**strong**`, `` `code` ``, triple-backtick fences with optional language, `#` headings, ordered/unordered lists, block quotes, paragraphs, and hard line breaks. Assert raw HTML, tables, image syntax, excessive nesting, and unclosed emphasis/code/fences remain literal. Stream closing delimiters in a later chunk and assert only the unfinished block changes from literal to styled output.

- [ ] **Step 3: Run the harness to verify old wrapping/rendering fails**

  Run: `npm run test:agent-core`

  Expected: FAIL on wide cells, combining graphemes, tabs, and Markdown markers.

- [ ] **Step 4: Implement the canonical width primitive**

  Use `Intl.Segmenter` for grapheme boundaries and one local zero-width/wide-range classifier. Add one `splitGraphemes` helper and use it for both transcript text and editable input characters. Route `wrapText`, clip, pad, scroll math, boxes, input cursor, and transcript truncation through it. Remove code-point-count helpers that would create a second width rule.

- [ ] **Step 5: Implement the bounded Markdown scan and cache**

  Parse one invalidated block in a forward scan. Cap delimiter state and nesting at eight. Emit internal spans, never ANSI. Cache completed blocks; while streaming, invalidate only the unfinished paragraph/list/quote/fence. On resize, invalidate width-dependent row caches but retain parsed spans.

- [ ] **Step 6: Paint ANSI only after cell wrapping**

  Begin and end every transcript row with `\x1b[0m`. Map assistant, thinking, headings, inline code, fenced code, quotes, metadata, and errors to the approved standard palette roles. Keep `frame()` plain; verify styled output by starting a TTY-backed fake and inspecting captured `stdout.write` data.

- [ ] **Step 7: Run harness and typecheck**

  Run: `npm run test:agent-core && npm run typecheck`

  Expected: PASS.

- [ ] **Step 8: Commit rendering**

  ```bash
  git add agent-core/tui.ts scripts/agent-core-harness-test.mjs
  git commit -m "feat: render markdown in the agent transcript"
  ```

### Task 3: Migrate streaming, tools, errors, and interruption to semantic calls

**Files:**
- Modify: `agent-core/main.ts:3100-3260, 3500-3750, 3830-3860, 4300-4405`
- Modify: `agent-core/tui.ts`
- Test: `scripts/agent-core-harness-test.mjs`

**Interfaces:**
- Consumes: exact `AgentTui` methods from Task 1.
- Keeps: `formatToolAnnounce()` and `formatToolFollowup()` for non-TTY output only.
- Produces `toolTranscriptDetail(use: ToolUse): string` and `toolTranscriptOutput(outcome: ToolOutcome): string`, both capped before entry insertion.
- Removes: `transcriptSection` and decorative `◆ Thinking`/`◆ Assistant` headings from the TTY path.

- [ ] **Step 1: Add failing lifecycle tests**

  Add a harness helper that drives assistant/thinking chunks, starts concurrent tools with identical provider IDs, completes them in reverse order, and interrupts before a third completes. Assert distinct entries show `done`, `failed`, and `cancelled`, bounded output previews, explicit status text, and no duplicate result block. Assert a provider error becomes an error entry. Assert the non-TTY formatter still emits readable headings and tool text.

- [ ] **Step 2: Run the harness to confirm the flat call path fails**

  Run: `npm run test:agent-core`

  Expected: FAIL because `streamOut` and the tool loop still call plain `out()`.

- [ ] **Step 3: Split semantic TTY output from plain non-TTY output**

  Implement:

  ```ts
  function plainOut(text: string): void {
    if (surface) surface.appendPlain(text);
    else process.stdout.write(text);
  }

  function streamOut(section: "thinking" | "assistant", text: string): void {
    if (!text) return;
    if (surface) {
      if (section === "thinking") surface.appendThinking(text);
      else surface.appendAssistant(text);
      return;
    }
    // Retain readable non-TTY headings before process.stdout.write.
  }
  ```

  Route provider failures to `appendError` when a surface exists. Do not change provider block parsing or stored messages.

- [ ] **Step 4: Migrate the concurrent tool loop with local handles**

  Before `Promise.all`, pair each `ToolUse` with `surface?.startTool(use.name, toolTranscriptDetail(use))`. After each outcome, call `finishTool(handle, outcome.isError ? "error" : "success", toolTranscriptOutput(outcome))`. Keep sidecar `toolCallId` unchanged. On interrupt, thrown turn failure, or finalizer exit, call `cancelPendingTools()` once.

- [ ] **Step 5: Remove the legacy semantic headings and generic append caller**

  Migrate every `surface.append(...)` call to `appendPlain`, `appendAssistant`, `appendThinking`, or `appendError`, then delete `AgentTui.append` and `transcriptSection`. Keep session replay's `resumed N messages` as plain text; do not replay live layout.

- [ ] **Step 6: Run harness and typecheck**

  Run: `npm run test:agent-core && npm run typecheck`

  Expected: PASS; `rg -n "surface\?\.append\(|transcriptSection" agent-core` returns no match.

- [ ] **Step 7: Commit semantic integration**

  ```bash
  git add agent-core/main.ts agent-core/tui.ts scripts/agent-core-harness-test.mjs
  git commit -m "feat: render semantic agent events"
  ```

### Task 4: Scope semantic palette entries to core xterm instances

**Files:**
- Modify: `src/terminal-themes.ts:1-85`
- Modify: `src/pty-view.ts:12-205`
- Modify: `src/main.ts:445-485, 1995-2025`
- Test: `scripts/agent-core-harness-test.mjs`

**Interfaces:**
- Produces:
  ```ts
  export function terminalTheme(theme: ThemeId, engine?: "pi" | "core"): ITheme;
  PtyView.setEngine(engine: "pi" | "core" | undefined): void;
  ```
- Consumes: semantic ANSI indices 16 pending, 17 success, and 18 error.

- [ ] **Step 1: Add failing palette isolation tests**

  Assert all four core themes contain exactly three semantic `extendedAnsi` entries with readable foreground/background contrast fixtures, while Pi/shell themes have no override. Capture a semantic tool frame and assert indices 16, 17, and 18 plus textual `running`, `done`, and `failed` labels.

- [ ] **Step 2: Run harness and typecheck**

  Run: `npm run test:agent-core && npm run typecheck`

  Expected: FAIL because the current palette is not engine-scoped and `setEngine` is absent.

- [ ] **Step 3: Implement one theme factory and engine update**

  Keep existing standard palette objects canonical. `terminalTheme` returns the standard theme for non-core engines and a shallow copy with the three extended entries for core. Store the current theme ID and engine in `PtyView`; call the factory from constructor, `setTheme`, and `setEngine`. In `onInstances`, call `pane.view.setEngine(summary.engine)` before tab repaint. This must recolor buffered output if engine identity arrives late.

- [ ] **Step 4: Run tests and build**

  Run: `npm run test:agent-core && npm run typecheck && npm run build`

  Expected: PASS.

- [ ] **Step 5: Commit palette scoping**

  ```bash
  git add src/terminal-themes.ts src/pty-view.ts src/main.ts scripts/agent-core-harness-test.mjs
  git commit -m "feat: theme semantic core transcript states"
  ```

### Task 5: Replace full preference snapshots with serialized typed patches

**Files:**
- Modify: `shared/types.ts:250-330, 465-478`
- Modify: `shared/preferences.ts:1-180`
- Modify: `electron/preload.ts:95-110`
- Modify: `electron/main.ts:500-510, 735-765, 4890-4910, 5360-5380`
- Modify: `src/main.ts:381-425`
- Modify: `scripts/settings-test.mjs`

**Interfaces:**
- Produces:
  ```ts
  export type UserPreferencePatch = Partial<Omit<AppPreferences, "openProjects">>;
  export type PreferenceUpdate = { patch: UserPreferencePatch; activateShortcuts: boolean };
  export function normalizeUserPreferencePatch(raw: unknown): UserPreferencePatch;
  updatePreferences(update: PreferenceUpdate): Promise<AppPreferences>;
  ```
- Main-only project persistence calls the same private queue with `{ openProjects: string[] }`.
- Removes the old `updatePreferences(preferences, activateShortcuts)` signature from all internal callers.

- [ ] **Step 1: Add failing preference normalization and race checks**

  In `scripts/settings-test.mjs`, assert renderer patches cannot set `openProjects`. Fire Settings, shortcut, thinking, and project-opening requests without awaiting between them; await all results and assert the final state contains every unrelated field. To force a save rejection, remove the test user's `preferences.json`, create a directory at that exact path, invoke a thinking patch, and assert rejection; remove the directory, send the next patch, and assert it commits. Verify the failed state never reaches renderer preferences or a live core TUI.

- [ ] **Step 2: Run focused settings E2E**

  Run: `npm run test:e2e -- settings --skip-build`

  Expected: FAIL because the bridge still sends complete snapshots and main assigns before saving.

- [ ] **Step 3: Implement canonical patch filtering**

  Add `normalizeUserPreferencePatch` beside full preference normalization. Whitelist each user-owned key, normalize values using the same canonical rules, and omit `openProjects`. In the renderer, compute the patch by comparing the next Settings state with the last local state; send only changed fields.

- [ ] **Step 4: Implement one non-poisoning main commit queue**

  Add `private preferenceCommits: Promise<void> = Promise.resolve()`. Each queued closure merges its patch into the latest committed `this.preferences`, normalizes, awaits `preferencesStore.save(candidate)`, and only then assigns state, native theme, shortcut map, menu, and live effects. Set the chain to `operation.then(() => undefined, () => undefined)` so a rejection does not block later operations. Route `persistOpenProjects` through the same queue.

- [ ] **Step 5: Migrate preload and renderer callers**

  Change the IPC payload and bridge signature atomically. Settings may keep immediate visual preview, but must reconcile to the normalized returned state; the thinking command added in Task 6 must wait for success before changing renderer state.

- [ ] **Step 6: Run settings, type, and build checks**

  Run: `npm run typecheck && npm run build && npm run test:e2e -- settings --skip-build`

  Expected: PASS.

- [ ] **Step 7: Commit preference serialization**

  ```bash
  git add shared/types.ts shared/preferences.ts electron/preload.ts electron/main.ts src/main.ts scripts/settings-test.mjs
  git commit -m "fix: serialize preference patch commits"
  ```

### Task 6: Add persisted thinking controls and private CSI handling

**Files:**
- Modify: `shared/types.ts`
- Modify: `shared/preferences.ts`
- Modify: `shared/commands.ts:18-60`
- Create: `shared/terminal-control.ts`
- Modify: `electron/main.ts:604-700, 735-780, 1900-1965`
- Modify: `src/main.ts:420-490, 1480-1610`
- Modify: `agent-core/main.ts:3900-4465`
- Modify: `agent-core/tui.ts:253-850`
- Modify: `scripts/agent-core-harness-test.mjs`
- Modify: `scripts/settings-test.mjs`

**Interfaces:**
- Consumes: preference patch queue from Task 5 and `setThinkingVisible()` from Task 1.
- Produces constants in `shared/terminal-control.ts` used by main, agent-core, and tests:
  ```ts
  export const SHOW_THINKING_CSI = "\x1b[?9001h";
  export const HIDE_THINKING_CSI = "\x1b[?9001l";
  export const HIDE_THINKING_ARG = "--hide-thinking";
  ```
- Adds `showThinking: boolean` default `true` and command ID `toggle-thinking`.

- [ ] **Step 1: Add failing TUI visibility and CSI tests**

  Append thinking between two assistant entries. Hide and show it; assert content is retained, tail-follow remains pinned, and a scrolled view anchors to the nearest non-thinking entry. Feed complete and every split position of show/hide CSI; assert the draft is unchanged. Feed malformed and overlong private CSI; assert it is discarded and does not toggle.

- [ ] **Step 2: Add failing preference/menu/shortcut tests**

  In the harness, assert default `showThinking === true`, command count increments by one, registry label is `Toggle Thinking`, and default shortcut is `CmdOrCtrl+Shift+H`. In `scripts/settings-test.mjs`, assert the context menu is dynamic only on a core pane, a successful shortcut toggle persists and reaches live/new core terminals, and a rejected save leaves every visible state unchanged. Verify the native Terminal menu checkbox manually in Task 7 because Chromium DevTools cannot inspect Electron's native menu.

- [ ] **Step 3: Run harness and settings suite**

  Run: `npm run test:agent-core && npm run test:e2e -- settings --skip-build`

  Expected: FAIL on missing preference, command, menu, CSI, and startup flag.

- [ ] **Step 4: Implement TUI visibility and private CSI**

  Initialize `thinkingVisible` from the constructor option. In the existing input state machine, recognize only `?9001h` and `?9001l`, including chunk splits, before prompt editing. Rebuild visible-row indexes and preserve entry-based scroll anchor on transitions. Hidden entries remain in bounds/cache accounting.

- [ ] **Step 5: Implement command, menu, and live update**

  Add the renderer command and register one handler that sends `{ patch: { showThinking: !preferences.showThinking }, activateShortcuts: false }`, awaits success, then applies the returned state. Add a fixed checked `Show Thinking` Terminal menu item that forwards `toggle-thinking`. Add a core-only terminal context item with dynamic Show/Hide label. After a successful main commit, write the fixed CSI to every live core PTY only when the value changed; rebuild the checkbox even when shortcuts did not change.

- [ ] **Step 6: Implement initial core state without environment leakage**

  Add a pure `parseHideThinking(argv)` test and parser. When main creates a core terminal and committed `showThinking` is false, append `HIDE_THINKING_ARG` to core args. Pass `thinkingVisible: !parseHideThinking(process.argv)` into `AgentTui`. Import all three control constants from `shared/terminal-control.ts`; do not duplicate literals or add an environment variable.

- [ ] **Step 7: Run harness, settings, typecheck, and build**

  Run: `npm run test:agent-core && npm run typecheck && npm run build && npm run test:e2e -- settings --skip-build`

  Expected: PASS.

- [ ] **Step 8: Commit thinking controls**

  ```bash
  git add shared/types.ts shared/preferences.ts shared/commands.ts shared/terminal-control.ts electron/main.ts src/main.ts agent-core/main.ts agent-core/tui.ts scripts/agent-core-harness-test.mjs scripts/settings-test.mjs
  git commit -m "feat: add persisted thinking visibility"
  ```

### Task 7: Full regression, visual inspection, and documentation

**Files:**
- Modify: `docs/AGENT-CORE.md`
- Verify: all files changed in Tasks 1-6

**Interfaces:**
- Consumes: complete semantic transcript and thinking feature.
- Produces: one canonical verified implementation without the flat semantic path.

- [ ] **Step 1: Document the shipped behavior**

  Explain that provider-visible thinking is shown by default, `CmdOrCtrl+Shift+H` toggles it, encrypted reasoning is never shown, tools render one status box, and live layout is not restored from session JSONL.

- [ ] **Step 2: Scan for obsolete and duplicate implementations**

  Run:

  ```bash
  rg -n "transcriptSection|surface\?\.append\(|private plain =|updatePreferences\(preferences|TERMINA_.*THINK" agent-core electron src shared
  ```

  Expected: no flat transcript, old full-snapshot preference call, or thinking environment variable remains.

- [ ] **Step 3: Run the complete automated suite**

  Run: `npm run test`

  Expected: PASS.

- [ ] **Step 4: Run focused Electron suites**

  Run: `npm run test:e2e -- settings terminal-clipboard`

  Expected: PASS from a fresh build.

- [ ] **Step 5: Inspect all four themes manually**

  In dark, light, high-contrast, and Atom core terminals, inspect assistant emphasis/code, thinking italic/dim text, running/done/failed/cancelled tools, hidden-thinking restoration, narrow resize, CJK/emoji wrapping, and Pi/shell palette isolation. Record any contrast or row-leak failure before proceeding.

- [ ] **Step 6: Verify scope and commit documentation**

  Run: `git diff --check && git status --short && git diff --stat`.

  Then:

  ```bash
  git add docs/AGENT-CORE.md
  git commit -m "docs: describe semantic agent transcript"
  ```
