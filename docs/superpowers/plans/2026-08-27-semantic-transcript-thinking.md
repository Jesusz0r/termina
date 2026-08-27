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
- Apply committed native-theme, menu, shortcut, renderer-preference, and live-TUI effects only after the preference file save succeeds; a reversible Settings visual preview must roll back on rejection.
- Pass hidden startup state to regular, dispatch, restored, promoted, and sandboxed worldline core terminals without an environment variable.
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
- Modify `electron/worldlines.ts`: append the same core startup flag inside the canonical sandbox command builder.
- Modify `electron/preload.ts`: migrate the existing preference bridge to patches.
- Modify `src/main.ts`: patch-producing Settings flow, thinking command, context menu, and post-save apply.
- Modify `scripts/agent-core-harness-test.mjs`: transcript, sanitizer, Markdown, width, tools, CSI, bounds, and non-TTY coverage.
- Modify `scripts/settings-test.mjs`: preference, command, menu, race, and persistence coverage.
- Modify `scripts/terminal-clipboard-test.mjs`: engine-scoped palette and late engine application coverage.
- Modify `docs/AGENT-CORE.md`: semantic transcript and thinking-control behavior.

### Task 1: Introduce the private semantic transcript and bounded sanitizer

**Files:**
- Modify: `agent-core/tui.ts:215-405, 880-995`
- Test: `scripts/agent-core-harness-test.mjs:2468-2740`

**Interfaces:**
- Produces these public `AgentTui` operations:
  ```ts
  declare const transcriptHandleBrand: unique symbol;
  export type TranscriptHandle = Readonly<{ [transcriptHandleBrand]: number }>;
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

  Instantiate `AgentTui`, append assistant/thinking/plain/error entries, start two tools, finish them out of order through their returned handles, and assert `frame()` keeps insertion order and one visual tool entry per handle. Add provider-ID-independent cases by using identical and empty names/details. Call `finishTool` twice and pass a forged/evicted handle through an `unknown` cast; assert one bounded plain error entry and no crash or state merge. Append 2,100 one-character settled entries and assert the oldest are evicted. Append one 410,000-character active assistant entry and assert exactly one truncation marker plus a Unicode-safe line-boundary tail.

- [ ] **Step 2: Write failing incremental sanitizer tests**

  Feed 7-bit and C1 CSI, OSC, DCS, ST, and single-character escapes at every chunk split through each text-bearing operation (`appendPlain`, assistant, thinking, tool detail/output, and error). Use overlong forms terminated before `SAFE`, plus malformed forms terminated by newline before `SAFE`, and assert no escape survives while all of `SAFE` remains. End an entry with an incomplete escape, change section, and assert the partial control is discarded instead of leaking into the next entry.

- [ ] **Step 3: Run the harness to verify failure**

  Run: `npm run test:agent-core`

  Expected: FAIL because semantic methods and entry-count bounds do not exist.

- [ ] **Step 4: Replace `plain` with one private entry collection**

  Use a discriminated private union with monotonic local IDs, settled state, sanitized text, optional tool state, and one replaceable render-cache slot per entry. Keep one `activeStream: { kind: "assistant" | "thinking"; entryId: number } | null`, not separate reusable assistant/thinking pointers, so an assistant chunk after thinking cannot merge backward across the section. Keep `transcriptChars` incrementally instead of rescanning all entries per chunk, plus a `Map<TranscriptHandle, toolEntryId>`. Merge only consecutive active chunks, close and flush sanitizer state on every section change, never evict pending tools, delete cache/handle indexes on eviction, and truncate only an over-budget active stream. The four-tool execution cap means pending entries can exceed an eviction boundary only by that fixed amount; settle-time eviction restores both budgets.

- [ ] **Step 5: Implement one bounded incremental sanitizer**

  Store sanitizer state per active streamed entry and use the same bounded state machine for non-streamed text. Cap each CSI/OSC/DCS sequence at 32 bytes after ESC/C1. Carry state across chunks; accept BEL or ST termination where applicable; discard remaining C0/C1 controls except newline/tab. After an overlong sequence, discard only through its legal terminator (or newline for a malformed sequence), then resume with the next ordinary character. Flush an incomplete control as discarded when its entry closes. Do not use a catch-all backtracking expression.

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

  Cover combining `e\u0301`, CJK `界`, flags, keycaps, emoji and emoji ZWJ sequences, variation selectors, tabs at columns 0 and 3, clipping at a wide-character boundary, box padding, and cursor position/editing after mixed-width input. Split a combining or ZWJ grapheme across input chunks and assert cursor movement, deletion, wrapping, and truncation never split it.

- [ ] **Step 2: Add failing Markdown frame cases**

  Cover `*em*`, `**strong**`, `` `code` ``, triple-backtick fences with optional language, `#` headings, ordered/unordered lists, block quotes, paragraphs, and hard line breaks. Assert raw HTML, tables, image syntax, excessive nesting, and unclosed emphasis/code/fences remain literal. Stream closing delimiters in a later chunk and assert only the unfinished block changes from literal to styled output. Feed 200,000 delimiter/list/quote characters at nesting beyond eight and assert unsupported syntax remains literal. In the JS harness only, read a private monotonic `markdownScannedChars` field before and after the append and assert the delta is at most four times the invalidated suffix length; increment the field by each source range examined, not once per token, and do not expose a production method or constructor option for this test.

- [ ] **Step 3: Run the harness to verify old wrapping/rendering fails**

  Run: `npm run test:agent-core`

  Expected: FAIL on wide cells, combining graphemes, tabs, and Markdown markers.

- [ ] **Step 4: Implement the canonical width primitive**

  Use one module-level `Intl.Segmenter` for grapheme boundaries and one local zero-width/wide-range classifier that treats regional-indicator flags, keycaps, emoji presentation/ZWJ clusters, and East Asian wide/full-width bases as two cells. Add one `splitGraphemes` helper and use it for both transcript text and editable input characters; printable input insertion must resegment the affected boundary when a combining mark or ZWJ sequence arrives in a later chunk. Route `wrapText`, tab expansion from the current column, clip, pad, scroll math, boxes, input cursor, and transcript truncation through it. Remove `unitsLen` and other code-point-count paths that would create a second width rule.

- [ ] **Step 5: Implement the bounded Markdown scan and cache**

  Parse one invalidated block in a forward scan. Cap delimiter state and nesting at eight. Emit internal spans, never ANSI. Cache completed blocks; while streaming, invalidate only the unfinished paragraph/list/quote/fence. Keep only one rendered-row cache slot per entry (`revision`, `width`, rows) so repeated resizes cannot accumulate widths. On resize, replace width-dependent row caches but retain parsed spans. Build a frame by walking cached entries backward only until `visible transcript rows + scroll offset` is filled; never parse or wrap the entire 400,000-character transcript for a tail-follow repaint.

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
- Produces `renderServerTools(blocks: Block[]): string[]`, which logs the existing sidecar events and creates/settles semantic server-tool entries without using a provider ID as the transcript handle.
- Replaces global `transcriptSection` with `nonTtyTranscriptSection`, used only to emit readable plain headings when no `AgentTui` exists; decorative headings disappear from the TTY path.

- [ ] **Step 1: Add failing lifecycle tests**

  Add a harness helper that drives assistant/thinking chunks, starts concurrent tools with identical provider IDs, resolves them in reverse order through deferred promises, and interrupts before another started tool completes. Assert each box updates at actual promise completion time while the stored `tool_result` array remains in request order; distinct entries show `done`, `failed`, and `cancelled`, bounded Unicode-safe output previews with a truncation notice, explicit status text, and no duplicate result block. Feed two `server_tool_use` blocks with empty/duplicate IDs plus corresponding result blocks and assert two distinct local handles settle once. Assert a provider error becomes an error entry. Assert the non-TTY formatter still emits readable headings and tool text.

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
    if (nonTtyTranscriptSection !== section) {
      process.stdout.write(`\n◆ ${section === "thinking" ? "Thinking" : "Assistant"}\n`);
      nonTtyTranscriptSection = section;
    }
    process.stdout.write(text);
  }
  ```

  Route provider failures to `appendError` when a surface exists. Do not change provider block parsing or stored messages.

- [ ] **Step 4: Migrate the concurrent tool loop with local handles**

  For each launched concurrency chunk, pair every `ToolUse` with `surface?.startTool(use.name, toolTranscriptDetail(use))`. Wrap each `executeTool(use)` promise with its own settlement callback so `finishTool` runs when that tool actually completes; if it rejects, finish that handle as `error` with a bounded sanitized message and rethrow. Then await `Promise.all` on the wrapped promises so the returned outcome array and stored session blocks retain input order. If `interrupted` is set before visual settlement, finish that handle as `cancelled` even though the existing session tool-result contract remains unchanged. Keep sidecar `toolCallId` unchanged. Put one `cancelPendingTools()` in the turn's `finally` so rejection, provider failure, interrupt, and exit cannot leave `running` entries.

  Replace `logServerSearch` with `renderServerTools`. Scan provider blocks in order, create one handle for each `server_tool_use`, and keep a FIFO list of unmatched `{ providerId, handle }` records. A `web_search_tool_result` takes the earliest unmatched record with the same non-empty ID, otherwise the earliest unmatched record, then settles only that handle. Duplicate or empty IDs therefore remain correlation hints rather than visual identity. Log the unchanged sidecar start/end events and keep the returned server tool-name list used by traces. Cancel any unmatched server handle at the end of the block scan.

- [ ] **Step 5: Remove the legacy semantic headings and generic append caller**

  Migrate every `surface.append(...)` call to `appendPlain`, `appendAssistant`, `appendThinking`, or `appendError`, then delete `AgentTui.append` and `transcriptSection`. Keep session replay's `resumed N messages` as plain text; do not replay live layout.

- [ ] **Step 6: Run harness and typecheck**

  Run: `npm run test:agent-core && npm run typecheck`

  Expected: PASS; `rg -n "surface\?\.append\(|logServerSearch|let transcriptSection" agent-core` returns no match, and `nonTtyTranscriptSection` remains only in the explicit non-TTY fallback.

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
- Test: `scripts/terminal-clipboard-test.mjs`

**Interfaces:**
- Produces:
  ```ts
  export function terminalTheme(theme: ThemeId, engine?: "pi" | "core"): import("@xterm/xterm").ITheme;
  PtyView.setEngine(engine: "pi" | "core" | undefined): void;
  ```
- Consumes: semantic ANSI indices 16 pending, 17 success, and 18 error.

- [ ] **Step 1: Add failing palette isolation tests**

  In the harness, assert all four core themes contain exactly three semantic `extendedAnsi` entries with contrast ratios of at least 4.5:1 against each theme's default foreground, while Pi/shell themes have no override. Capture semantic tool frames and assert `48;5;16`, `48;5;17`, and `48;5;18`, full-width row backgrounds, a reset at both row boundaries, plus textual `running`, `done`, `failed`, and `cancelled` labels. In `terminal-clipboard-test.mjs`, inspect `pane.view.getTerminal().options.theme.extendedAnsi`: restored Pi and shell panes have none, a core pane gets exactly three after its instance summary arrives, and changing the app theme retains the core-only override.

- [ ] **Step 2: Run harness and typecheck**

  Run: `npm run test:agent-core && npm run typecheck`

  Expected: FAIL because the current palette is not engine-scoped and `setEngine` is absent.

- [ ] **Step 3: Implement one theme factory and engine update**

  Type the existing standard palette objects as `ITheme` and keep them canonical. `terminalTheme` returns the standard object for non-core engines and a shallow copy with a fresh three-element `extendedAnsi` array for core. Store the current theme ID and engine in `PtyView`; call the factory from constructor, `setTheme`, and idempotent `setEngine`. In `onInstances`, call `pane.view.setEngine(summary.engine)` before tab repaint; assigning `term.options.theme` must recolor buffered cells if engine identity arrives after initial PTY data.

- [ ] **Step 4: Run tests and build**

  Run: `npm run test:agent-core && npm run typecheck && npm run build && npm run test:e2e -- terminal-clipboard --skip-build`

  Expected: PASS.

- [ ] **Step 5: Commit palette scoping**

  ```bash
  git add src/terminal-themes.ts src/pty-view.ts src/main.ts scripts/agent-core-harness-test.mjs scripts/terminal-clipboard-test.mjs
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
- Main owns one private `commitPreferencePatch(patch: Partial<AppPreferences>, activateShortcuts: boolean): Promise<AppPreferences>` queue. Renderer IPC always passes a runtime-filtered `UserPreferencePatch`; main-only project persistence passes `{ openProjects: string[] }` to the same queue.
- The existing `settings:shortcuts` path remains only the transient enable/disable signal for shortcut capture while Settings is open. It does not write preferences or define a second commit path.
- Removes the old `updatePreferences(preferences, activateShortcuts)` signature from all internal callers.

- [ ] **Step 1: Add failing preference normalization and race checks**

  In `scripts/settings-test.mjs`, assert renderer patches cannot set `openProjects`. Fire disjoint theme, editor-font, minimap, keyboard-shortcut, and project-opening updates without awaiting between them; await all results and assert the final state contains every field. This keeps Task 5 independent of `showThinking`, which Task 6 adds. To force a save rejection, remove the isolated test user's `preferences.json`, create a directory at that exact path, invoke a word-wrap patch, and assert rejection. Remove the directory, send the next patch, and assert it commits. Assert the failed preview rolls back and the failed state never reaches renderer preferences, native theme, menus, or shortcut bindings. Close the app immediately after a project-list change and relaunch to assert the final queued project patch was not lost during shutdown.

- [ ] **Step 2: Run focused settings E2E**

  Run: `npm run test:e2e -- settings --skip-build`

  Expected: FAIL because the bridge still sends complete snapshots and main assigns before saving.

- [ ] **Step 3: Implement canonical patch filtering**

  Add `normalizeUserPreferencePatch` beside full preference normalization. Whitelist each user-owned key, normalize values through the same canonical full-preference rules, and omit `openProjects`; do not add a second default-fill or validation path. In the renderer, compare the submitted Settings form with the last committed preferences and send only changed fields.

- [ ] **Step 4: Implement one non-poisoning main commit queue**

  Add `private preferenceCommits: Promise<void> = Promise.resolve()`. `commitPreferencePatch` creates `operation = this.preferenceCommits.then(async () => { ... })`, and the queued closure—not the IPC handler—merges its patch into the then-current committed `this.preferences`, fully normalizes the candidate, and awaits `preferencesStore.save(candidate)`. Only after that save succeeds may it assign `this.preferences` and apply changed native-theme, shortcut, menu, renderer, or live-terminal effects. Set the chain to `operation.then(() => undefined, () => undefined)` before returning `operation`, so one rejection cannot poison later commits. Make `persistOpenProjects(): Promise<void>` enqueue the current project list through this same function; report fire-and-forget failures, and during disposal `await persistOpenProjects()`, then await `preferenceCommits`, then call `preferencesStore.flush()`.

- [ ] **Step 5: Migrate preload and renderer callers**

  Change the IPC payload and bridge signature atomically. Keep one renderer `committedPreferences` snapshot and a monotonically increasing request generation. Settings may apply a reversible visual preview, but on success it must reconcile from the normalized returned state, and on rejection it must restore the latest committed state only if no newer generation has already applied. Never derive a later patch from preview-only state. Keep `settings:shortcuts` solely for modal shortcut capture. The thinking command added in Task 6 must wait for success before changing renderer state.

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
- Modify: `electron/worldlines.ts`
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
  export function thinkingStartupArgs(showThinking: boolean): string[];
  ```
- Adds `showThinking(): boolean` to the dependencies supplied to `WorldlineManager`; its canonical sandbox command builder inserts `thinkingStartupArgs(showThinking())` into the inner agent-core command.
- Adds `showThinking: boolean` default `true` and command ID `toggle-thinking`.

- [ ] **Step 1: Add failing TUI visibility and CSI tests**

  Append thinking between two assistant entries. Hide and show it; assert content is retained, tail-follow remains pinned, and a scrolled view anchors to the nearest non-thinking entry. Feed complete and every split position of show/hide CSI; assert the draft is unchanged. Feed unknown (`ESC[?25h`), malformed (`ESC[?9001;h`), incomplete, and over-32-byte private CSI followed by ordinary text; assert the full private sequence is discarded, later text remains, the draft receives no digits or final byte, and visibility does not toggle.

- [ ] **Step 2: Add failing preference/menu/shortcut tests**

  In the harness, assert default `showThinking === true`, command count increments by one, registry label is `Toggle Thinking`, default shortcut is `CmdOrCtrl+Shift+H`, and `thinkingStartupArgs` returns `[]` or exactly `[HIDE_THINKING_ARG]`. In `scripts/settings-test.mjs`, assert the context menu is dynamic only on a core pane; a shortcut-initiated toggle persists, reaches a live regular core terminal, and starts a new regular core terminal hidden; toggling with no terminal still persists; and a rejected save leaves renderer state, context label, and live TUI unchanged. Verify the native Terminal menu checkbox manually in Task 7 because Chromium DevTools cannot inspect Electron's native menu.

- [ ] **Step 3: Run harness and settings suite**

  Run: `npm run test:agent-core && npm run test:e2e -- settings --skip-build`

  Expected: FAIL on missing preference, command, menu, CSI, and startup flag.

- [ ] **Step 4: Implement TUI visibility and private CSI**

  Initialize `thinkingVisible` from the constructor option. Extend the existing input state machine after `ESC [` to accept one leading `?` only as the first private-parameter byte, buffer at most 32 bytes through the CSI final byte (`0x40`-`0x7e`), and recognize only exact `?9001h` and `?9001l` before prompt editing. Discard every other complete, malformed, or overlong private CSI as one sequence; do not reprocess its digits or final byte as prompt input. Preserve all existing non-private cursor/editing CSI behavior and chunk-split state. Rebuild visible-row indexes and preserve the entry-based scroll anchor on transitions; if the anchor is a hidden thinking entry, select the nearest visible entry, and if no visible transcript entry exists, clamp to the empty transcript origin. Hidden entries remain in transcript bounds and cache accounting.

- [ ] **Step 5: Implement command, menu, and live update**

  Add one canonical renderer command handler that sends `{ patch: { showThinking: !committedPreferences.showThinking }, activateShortcuts: false }`, awaits success, and only then applies the normalized returned state; on rejection, keep the prior state and show the existing error toast. Add a fixed checked `Show Thinking` Terminal menu item that forwards `toggle-thinking`. Electron toggles checkbox items before their click callback, so synchronously reset `item.checked` to the committed `this.preferences.showThinking` before forwarding; rebuild the menu only after a successful commit. Reuse `src/components/context-menu.ts` for the terminal container's existing Copy/Paste actions and add one core-only item whose label is dynamically `Show Thinking` or `Hide Thinking`; Pi and shell panes get no thinking item, and dispose removes the listener. Both menu surfaces invoke the same renderer command. After a successful main commit, write the fixed CSI to each still-live core PTY only when the committed value changed. A missing terminal is not an error and does not prevent persistence.

- [ ] **Step 6: Implement initial core state without environment leakage**

  Add pure tests for `parseHideThinking(argv)` and `thinkingStartupArgs(showThinking)`. Pass `thinkingVisible: !parseHideThinking(process.argv)` into `AgentTui`. In every regular, restored, dispatch, and promoted core launch assembled by main, append `thinkingStartupArgs(this.preferences.showThinking)` to the direct agent-core argv. For sandboxed worldlines, pass `showThinking: () => this.preferences.showThinking` in `WorldlineManager` dependencies and, in `electron/worldlines.ts`, shell-quote each returned startup arg with the existing command quoting helper and insert it into the inner agent-core argv before wrapping that command in `zsh -c`; appending it to the outer `opts.launch.args` does not reach agent-core. Import the shared constants/helper rather than duplicating literals, and do not add an environment variable. Add a deterministic command-builder assertion that the hidden sandbox command contains one shell-quoted hide arg and the shown command contains none.

- [ ] **Step 7: Run harness, settings, typecheck, and build**

  Run: `npm run test:agent-core && npm run typecheck && npm run build && npm run test:e2e -- settings --skip-build`

  Expected: PASS.

- [ ] **Step 8: Commit thinking controls**

  ```bash
  git add shared/types.ts shared/preferences.ts shared/commands.ts shared/terminal-control.ts electron/main.ts electron/worldlines.ts src/main.ts agent-core/main.ts agent-core/tui.ts scripts/agent-core-harness-test.mjs scripts/settings-test.mjs
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
  rg -n "logServerSearch|let transcriptSection|surface\?\.append\(|private plain =|updatePreferences\(preferences|TERMINA_.*THINK" agent-core electron src shared
  rg -n --glob '!terminal-control.ts' '"--hide-thinking"|\\?9001[hl]' agent-core electron src shared
  ```

  Expected: both commands return no match. No flat transcript, server-tool compatibility renderer, old full-snapshot preference call, duplicated control literal, or thinking environment variable remains.

- [ ] **Step 3: Run the complete automated suite**

  Run: `npm run test`

  Expected: PASS.

- [ ] **Step 4: Run focused Electron suites**

  Run: `npm run test:e2e -- settings terminal-clipboard`

  Expected: PASS from a fresh build.

- [ ] **Step 5: Inspect all four themes manually**

  In dark, light, high-contrast, and Atom core terminals, inspect assistant emphasis/code, thinking italic/dim text, running/done/failed/cancelled tools, hidden-thinking restoration, narrow resize, CJK/emoji wrapping, and Pi/shell palette isolation. Use the native Terminal checkbox to hide/show thinking, confirm its check follows only a committed toggle, and relaunch once while hidden to verify startup state. Record any contrast, row-leak, checkbox, or startup-state failure before proceeding.

- [ ] **Step 6: Verify scope and commit documentation**

  Run: `git diff --check && git status --short && git diff --stat`.

  Then:

  ```bash
  git add docs/AGENT-CORE.md
  git commit -m "docs: describe semantic agent transcript"
  ```
