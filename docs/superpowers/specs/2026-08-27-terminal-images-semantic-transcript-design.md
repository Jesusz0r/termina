# Terminal Image Drop and Semantic Transcript Design

Date: 2026-08-27

Audit: 2026-08-27

## Purpose

Termina must support Finder file drops into terminal surfaces and give the in-house `agent-core` TUI the same visual structure users expect from Pi. The change must preserve the terminal as the source of truth, keep privileged file access in the main process, and keep the main process and renderer hot paths responsive.

This design covers three connected behaviors:

1. Drop image files from the desktop into a terminal.
2. Render `agent-core` assistant, thinking, tool, result, and error content as semantic transcript entries.
3. Show provider-supplied thinking by default and let the user hide or show it through one persisted preference.

## Goals

- A Finder drop works on every Termina terminal surface.
- Pi, shell, and programs such as Claude Code receive safely quoted absolute paths through normal PTY input.
- `agent-core` receives dropped images through its existing pending-image mechanism.
- `AgentTui` owns one semantic transcript model and one renderer for that model.
- Assistant content renders a practical Markdown subset.
- Provider-supplied thinking renders separately and can be hidden without deleting it.
- Tool calls use pending, success, and error presentation with bounded output previews.
- All four terminal themes produce readable results.
- Streaming work stays incremental and bounded.

## Non-goals

- Do not add binary transport through a PTY.
- Do not add a second image store or a second pending-image protocol.
- Do not change Pi's own TUI or session format.
- Do not expose encrypted reasoning or invent hidden chain-of-thought.
- Do not persist the live transcript layout. Session JSONL remains the canonical stored conversation.
- Do not reproduce every Pi Markdown or tool renderer in this change.
- Do not add a renderer-side chat surface.

## Current Problems

### Desktop drops

`PtyView` has no `dragover` or `drop` handler. A browser `File` object cannot pass through the PTY, so a desktop image reaches neither the child program nor the existing `agent-core` image attachment path.

Clipboard images already have a canonical implementation. Main reads the clipboard image and calls `appendPendingImage` for a core terminal. Desktop drops must join that implementation instead of creating a new attachment store.

### Flat transcript rendering

`AgentTui.append` strips ANSI codes and appends text to one flat `plain` string. `buildFrame` can therefore distinguish only fixed screen regions such as the status row, footer, and picker. Assistant Markdown appears literally, thinking and assistant output share one style, and tools cannot retain a pending or settled state.

### Thinking presentation

Provider adapters already request and parse visible reasoning summaries and thinking deltas. The missing layer is semantic presentation. Decorative headings added to the flat transcript identify a section but do not preserve its type or render its Markdown.

## Chosen Approach

Replace the flat live transcript with semantic entries owned by `AgentTui`. Keep provider parsing, tool execution, session persistence, and pending-image storage in their current canonical owners.

Two alternatives were rejected:

- Preserving arbitrary ANSI inside the flat transcript would require ANSI-aware wrapping and still would not support hiding thinking or updating tool state cleanly.
- Reusing Pi's interactive components would couple `agent-core` to Pi's message, tool, theme, and render lifecycle. `agent-core` must keep its own TUI responsibility.

## Semantic Transcript

### Entry model

`AgentTui` keeps a bounded ordered collection with these entry kinds:

- `plain`: engine notices, user echoes, and compatibility output that has no richer type.
- `assistant`: streamed assistant text.
- `thinking`: provider-supplied visible thinking or reasoning summaries.
- `tool`: one tool call, its display detail, execution state, and bounded result preview.
- `error`: provider, engine, or tool errors that are not part of a tool entry.

The model is private to `AgentTui`. It is not a new shared application state or IPC contract.

### Public operations

`AgentTui` exposes semantic operations instead of asking callers to construct ANSI strings:

- Append plain text.
- Append an assistant chunk.
- Append a thinking chunk.
- Start a tool with its name and display detail, and return an opaque local entry handle.
- Finish a tool through that handle with success, error, or cancelled state and optional output.
- Append an error.
- Set whether thinking is visible.

Exact method names are an implementation detail. The interface must express these responsibilities without a generic style parameter.

### Streaming and transitions

- Consecutive chunks of the same active assistant or thinking entry merge in place.
- A section change closes the active streamed entry.
- A tool start creates one pending tool entry and returns an opaque handle. Provider tool-call identifiers remain sidecar/session concerns and are not transcript identity.
- A tool finish updates that same entry. It does not append a parallel result representation.
- Concurrent tools can finish out of order because callers retain their local handles. Missing or duplicate provider identifiers cannot merge two visual entries.
- An interrupt or turn failure settles every still-pending entry from that turn as cancelled.
- Server tools use the same tool-entry path.
- Non-TTY output retains readable plain headings and text. Semantic frame rendering applies only when `AgentTui` is active.

### Bounds and performance

- Keep the existing `MAX_TRANSCRIPT = 400_000` character budget as the primary memory bound and add `MAX_TRANSCRIPT_ENTRIES = 2_000` so many tiny notices cannot grow metadata without limit.
- Tool output is capped before it enters the transcript model.
- Evict the oldest settled entries when either bound is exceeded. Never evict pending tools.
- If one active streamed entry exceeds the character budget, retain a Unicode-safe tail at a line boundary and prepend one truncation marker. This is the only case where an active entry is shortened.
- Cache rendered lines per entry and terminal width. Invalidate only a changed entry or width-dependent caches after resize. Delete tool-handle and cache entries when their transcript entry is evicted.
- Parse streaming Markdown incrementally. Keep completed blocks cached and reparse only the current unfinished paragraph, list item, quote, or fenced block instead of reparsing the full assistant response every 16 ms.
- Use one linear-time parser with explicit delimiter and nesting limits. Do not use nested backtracking expressions whose cost can grow superlinearly on adversarial streamed text.
- Build only enough wrapped lines to fill the visible transcript plus scroll offset.
- Preserve the current changed-row comparison so the PTY receives only rows whose rendered content changed.
- Never create one entry or one render pass per token.
- Use one local cell-width primitive for wrapping, clipping, padding, scrolling, boxes, and cursor placement. It segments graphemes, treats combining marks as zero additional cells, treats wide CJK/emoji graphemes as two cells, and expands tabs from the current column. Truncation and cursor-safe clipping must never split a grapheme or ANSI sequence. Do not create separate width rules for Markdown and input.

## Transcript Presentation

### Theme roles

The TUI emits standard ANSI foreground roles and three extended palette backgrounds:

- Extended index 16: tool pending background.
- Extended index 17: tool success background.
- Extended index 18: tool error background.

`src/terminal-themes.ts` defines those indices for dark, light, high-contrast, and Atom themes through xterm's `extendedAnsi` palette. The renderer applies these overrides only to `agent-core` xterm instances; Pi and shell palettes keep the standard 256-color table. `AgentTui` uses the indices, not hard-coded RGB values, so changing the xterm theme updates transcript rendering without restarting the child process.

Foreground roles use the existing terminal palette:

- Default foreground for assistant text.
- Bright black plus italic for thinking.
- Blue/accent plus bold for section and tool titles.
- Red for errors.
- Dim foreground for metadata and truncated-output notices.

High-contrast colors must retain clear text/background contrast. Background presentation must fall back to borders and labels when color is unavailable.

Every painted transcript row starts from a reset style and ends with a reset. Tool status is also written as text (`running`, `done`, `failed`, or `cancelled`), so color is never the only status signal. Tool backgrounds extend across the tool box width without leaking into adjacent transcript rows.

### Markdown subset

Assistant and thinking entries support the Markdown constructs visible in normal agent output:

- Paragraphs and line breaks.
- Emphasis and strong emphasis.
- Inline code.
- Fenced code blocks.
- Headings.
- Ordered and unordered lists.
- Block quotes.

The renderer never trusts embedded terminal styling. One bounded incremental sanitizer carries escape state across streamed chunks, removes complete CSI, OSC, DCS, and single-character escape sequences, then removes remaining C0/C1 controls except newline and tab. A malformed or overlong escape is discarded without swallowing later ordinary text. Markdown parsing is local to `AgentTui`; callers provide content, not pre-rendered formatting.

The implementation should use a small direct parser suitable for terminal display. It must not add a dependency or duplicate a separate renderer elsewhere in the application. The parser performs one bounded linear scan per invalidated block and caps nested list, quote, and emphasis state at a small fixed depth; syntax beyond that depth remains literal text.

Raw HTML, tables, images, and executable terminal escapes are not interpreted. Unclosed emphasis, inline-code, or fence markers remain literal until enough streamed text arrives to close them. Tool output follows the same sanitization rule.

### Thinking

- Thinking is visible by default.
- Thinking content is limited to provider-supplied visible summaries or thinking blocks.
- Hiding thinking removes its rendered rows but keeps its semantic entries.
- Showing thinking restores the same entries. A view following the tail stays at the tail; a scrolled view preserves the nearest visible non-thinking entry as its anchor and clamps only if that entry was evicted.
- Hidden thinking still counts against transcript memory bounds and is evicted by the same oldest-entry policy.
- Encrypted reasoning with no visible summary produces no transcript entry.

### Tools

- Pending, successful, and failed tools use their semantic background role.
- The title contains the tool name and a compact display detail such as a path, command, pattern, or URL.
- Results show a bounded preview appropriate to the existing tool formatting rules.
- Truncated output includes a dim count or truncation notice.
- Tool errors use the error background and retain their bounded error text. Cancelled tools use the neutral pending background with an explicit `cancelled` label; cancellation is not reported as a tool failure.

## Thinking Preference and Controls

Add `showThinking: boolean` to `AppPreferences`, defaulting to `true`. `shared/preferences.ts` remains the only validator and default-fill path. Existing preference files without the field receive the current default through normal validation.

Add one canonical renderer command, `toggle-thinking`, to the command registry:

- Registry label: `Toggle Thinking`.
- Category: Terminal.
- Default shortcut: `CmdOrCtrl+Shift+H`.
- The Settings shortcut editor can rebind or clear it through the existing command registry.

The command is available through:

- The application Terminal menu.
- The terminal context menu.
- The configurable keyboard shortcut.

The command updates preferences through the existing preferences bridge and applies the normalized value returned by main only after the save succeeds. It must not optimistically mutate renderer state. The application menu forwards to this same command path. Pi and shell terminals ignore the rendering control. The main-process application menu uses one fixed `Show Thinking` checkbox item and refreshes it after every successful preference update, even when shortcut bindings did not change. The terminal context menu reuses the existing context-menu component, labels its item `Show Thinking` or `Hide Thinking` from current state, and shows it only for a core terminal; it retains normal Copy and Paste actions.

Replace the internal full-snapshot preference update with one typed patch contract; all internal callers migrate and the old signature is removed. Renderer patches cannot contain main-owned `openProjects`. Settings sends only fields that changed, the thinking command sends only `showThinking`, shortcut activation carries its existing explicit activation intent, and project-list persistence originates only in main.

Main routes every preference patch, including main-owned `openProjects` changes, through one serialized commit path. At execution time that path merges the patch into the latest committed state, normalizes the complete candidate, saves without assigning to `this.preferences`, and only then commits in-memory preferences, native theme, shortcut map, menu state, renderer state, and live TUI state. Renderer updates, Settings changes, shortcut activation, and project-list persistence cannot overtake or overwrite one another. A failed operation rejects its caller but does not poison the queue. Main compares the previous and normalized `showThinking` values and broadcasts only a real transition after a successful commit.

The fixed app-private CSI input sequences are `CSI ? 9001 h` to show thinking and `CSI ? 9001 l` to hide it. These sequences are not assigned to a keyboard action and contain no user-controlled data. `AgentTui` consumes them as display commands before normal prompt editing and does not insert them into prompt input. Its streaming input parser must handle a sequence split across PTY chunks and discard malformed private control input without changing the prompt draft. A failed save leaves the previous main and renderer preferences, native theme, checkbox, shortcut behavior, and live TUI state in place and shows an error toast. A toggle with no live core terminal still persists normally. New core terminals receive `--hide-thinking` when the stored preference is false; the default needs no flag. This avoids leaking an internal setting through the environment inherited by tool subprocesses and keeps the renderer from owning or repainting agent content.

## Desktop File Drop

### Renderer and preload

`PtyView` owns terminal-surface drag behavior:

- Prevent browser navigation only for a drag whose `DataTransfer` contains files and whose drop target is the terminal pane. Text and URL drags keep their existing behavior.
- Show a local drop-target state using existing CSS theme tokens. Use a drag-enter depth counter so transitions across xterm child elements do not flicker or clear the state early. Clear it on drop, final drag-leave, cancellation, pane disposal, and window blur.
- On drop, pass the terminal identifier and browser `File` objects to one narrow preload function.
- Keep one drop request in flight per `PtyView`. A second drop on that view reports `drop already in progress`; it cannot overtake the first. A response checks that the view is still live before pasting text or showing success.
- Preload resolves each host path with Electron's `webUtils.getPathForFile` and immediately invokes `terminals:drop-files`. It exposes no path-resolver result to renderer code and sends no image bytes over IPC. For a path-only terminal, main returns one already quoted paste string; the renderer sees only that user-requested insertion text so `PtyView` can pass it through xterm's bracketed-paste behavior. For a core terminal, main returns only attachment status and count.

Electron explicitly supports passing a Web `File` to a context-isolated preload function for [`webUtils.getPathForFile`](https://www.electronjs.org/docs/latest/api/web-utils). A JavaScript-created file that has no disk backing resolves to an empty string and is rejected. Preload exposes no general filesystem or arbitrary IPC method.

### Main-process validation

Main remains the privileged owner of file reads. One `terminals:drop-files` handler:

1. Verifies that the IPC sender is the current Termina window's main frame. Subframes and stale `webContents` are rejected.
2. Validates the terminal identifier, at most 16 dropped paths, at most 4,096 UTF-8 bytes per path, at most 64 KiB of path data in total, and the terminal still being live. Preload rejects an over-count list early; main remains authoritative.
3. Rejects empty paths and paths containing NUL, carriage return, or newline. Duplicate normalized absolute path strings collapse while preserving their first order. The path-only branch does not resolve symbolic links merely to deduplicate them; the core attachment branch deduplicates the stable opened file identity.
4. Branches validation by terminal engine before any state change.
5. Captures the terminal object identity before asynchronous work, then requires the same object to remain registered under that identifier before commit or PTY insertion. A closed terminal or a future identifier reuse cannot receive a stale result.

For a core terminal:

- Accept PNG, JPEG, WebP, and GIF images supported by the existing host model.
- Reject directories, symbolic links, unsupported extensions, extension/signature mismatches, zero-byte files, files over `MAX_IMAGE_BYTES`, and a batch that would exceed `MAX_PENDING_IMAGES` after existing pending images are counted.
- Reuse the canonical host limits (`MAX_PENDING_IMAGES = 4`, `MAX_IMAGE_BYTES = 4 MiB`), which bound one complete pending generation to 16 MiB before file and manifest overhead.
- Open candidates first, deduplicate by descriptor device/inode identity, and reject more unique images than the remaining queue capacity before allocating full buffers. The sum of unique descriptor sizes must not exceed `MAX_PENDING_IMAGES * MAX_IMAGE_BYTES`, even when the original drop contains 16 hard-linked or duplicate paths.
- Open every source asynchronously with no-follow semantics, verify size and regular-file type from the open descriptor, read the bounded bytes from that same descriptor, and validate the signature from the bytes that will be staged. Recheck descriptor size after the read and reject a short, long, or concurrently resized file. This closes the validate/read symbolic-link and replacement races and never blocks Electron's main event loop with desktop file I/O.
- Call one canonical asynchronous `appendPendingImages` batch operation in `agent-core/host.ts`. Migrate clipboard paste to the same batch operation and remove the one-at-a-time public append path.
- Clipboard paste preserves its existing text behavior when the clipboard has no image. When an image exists but attachment fails, it reports the attachment error and does not silently paste unrelated clipboard text.
- Serialize clipboard, drop, and prompt consumption with one canonical asynchronous per-terminal queue lock in `agent-core/host.ts`:
  1. The lock is one fixed app-owned regular file acquired through an atomic hard link. A contender first writes and closes a unique owner record containing its process identifier and creation time, then hard-links that complete record to the fixed lock path. Only one link can succeed, so no observer can see partial owner metadata at the lock path. Acquisition retries asynchronously for at most 250 ms. A lock whose owner is confirmed dead and whose age exceeds 5 seconds is removed before retry; a live owner or an `EPERM` process check is never stolen. A malformed fixed lock fails closed as `image queue is invalid`. Unlinked owner records use strict names and bounded stale cleanup.
  2. A producer validates and stages unique image files outside the lock. Under the short lock it reads the live manifest, checks capacity, renames staged files to final names, and publishes the complete merged manifest by atomic rename. Manifest rename is the commit point. Before commit, failure removes every staged/final file from this batch; after commit, cleanup failure is reported only as maintenance and cannot roll back visible files.
  3. A consumer acquires the same lock. It first adopts the oldest claim owned by the same process or a confirmed-dead process for this terminal, or atomically renames the live manifest to a unique consumer claim when no adoptable claim exists. It releases the lock and reads only its durable claim outside the lock. It never removes the live manifest path, which may already name a newer producer generation.
  4. If the consumer locks first, the producer later sees an empty live generation and publishes only the new images. If the producer locks first, the consumer claims the complete merged generation. No side can observe or publish a partial manifest.
  5. The claim is a receipt, not temporary garbage. `runPrompt` acknowledges each image only after it is persisted into the session location. Acknowledgement updates or removes that claim under the same lock and deletes only the acknowledged source files. If persistence fails, unacknowledged refs remain in the claim for the same process's next prompt. A process crash also leaves the claim durable; a later process adopts it after confirming the recorded owner is dead. This prevents the current consume-before-persist loss window.
  6. A producer timeout returns `image queue busy` without changing the live manifest. A consumer timeout consumes nothing and leaves the generation for the next prompt. Unreferenced staged files are removed by bounded cleanup on the next successful queue operation. Consumer claims are recovered or acknowledged, never age-deleted while they still reference images. Cleanup examines only strict app-owned names inside the canonical events directory, limits work per operation, and never follows symbolic links.
  7. Manifest and claim reads are size-capped and schema-validated while the lock is held. A malformed live manifest or claim is atomically renamed to a unique app-owned quarantine name and the operation reports `image queue is invalid`; it is never silently treated as empty or overwritten. Quarantine cleanup uses the same strict-name, age, and work bounds and removes no referenced image automatically.
- Migrate `consumePendingImages` to the same asynchronous queue API and await it in `runPrompt`. Migrate clipboard paste to async as well. There is no synchronous producer or consumer left beside the canonical lock.
- Replace the unlocked preflight peek with an asynchronous queue query that recognizes both the live manifest and an adoptable claim. Preflight therefore reports images accurately after a prior persistence failure or consumer crash.
- This replaces the current read-then-remove consumer race and prevents a producer from resurrecting already consumed refs or a consumer from deleting a newly published batch. The JSON manifest shape and final image file format do not change.
- Return the resulting attachment count. The count is computed inside the locked commit, not from an earlier peek.
- Notify the TUI with the existing paste-end control input so its status refreshes.
- If the core is already running a prompt, the images remain pending for the next prompt; feedback says `queued for next prompt` rather than implying that the active request changed. At the exact boundary where a prompt starts, the manifest claim winner deterministically decides whether the batch joins that prompt or remains for the following prompt.

For Pi, shell, and programs such as Claude Code:

- Do not read file contents.
- Accept existing files, directories, and symbolic-link paths because this branch inserts text and does not open the target.
- Return POSIX-shell-quoted absolute paths on the currently supported macOS and Linux builds. The canonical quoting function wraps each path in single quotes and represents an embedded single quote with the standard `'\''` sequence. A future unsupported platform fails closed until it has a defined quoting rule.
- `PtyView` inserts those paths through its existing terminal input callback.
- Separate multiple paths with one space.
- Use xterm's paste path so bracketed-paste mode remains correct. Do not append Enter or execute the path.
- Quote empty-looking names, whitespace, single quotes, backslashes, dollar signs, backticks, leading dashes, and other shell metacharacters as literal path text.

### Feedback

- Invalid drops show one renderer toast with a concise reason.
- Successful core drops update the existing image count in the TUI.
- Successful path drops insert text at the child TUI or shell cursor and focus the terminal.
- Drag cancellation changes no state.
- A drop rejected because the terminal closed or the image queue filled reports that exact condition.

## Error Handling and Security

- Keep resolved path arrays and file reads out of the renderer main world. The only path-derived value returned there is the validated, already quoted insertion text for a path-only terminal.
- Treat preload-resolved paths and every IPC argument as untrusted even though the UI originated the request.
- Cap the path count and total path bytes for every drop. For core attachments, cap per-file and total image bytes before allocating full buffers.
- Validate file signatures in addition to extensions for direct attachments.
- Reject symbolic links for direct attachments so validation and read address the same file.
- Permit paths outside the project for this explicit user action. Do not add them to workspace state or grant later access.
- Use explicit resolved paths. Do not expand globs or environment variables.
- Never run a dropped path as a command.
- Do not partially attach a multi-file core drop.
- Treat malformed semantic updates as plain error output, not a renderer crash.
- Strip input control sequences before Markdown interpretation.
- Serialize attachment producers and consumers with the canonical per-terminal queue lock, use consumer claims only after the lock is held, and recheck terminal liveness before producer commit. Cleanup touches only validated app-owned names below the canonical events directory.

## Files and Canonical Ownership

Expected implementation areas:

- `src/pty-view.ts`: terminal drag/drop interaction and path insertion.
- `src/styles.css`: token-based terminal drop-target state.
- `electron/preload.ts`: narrow `webUtils.getPathForFile` plus fixed drop IPC bridge.
- `shared/types.ts`: typed drop operation, preference field, and user-owned preference patch contract.
- `shared/commands.ts`: one `toggle-thinking` command.
- `shared/preferences.ts`: canonical preference validation.
- `electron/main.ts`: drop validation, core attachment, launch preference, and Terminal menu item.
- `agent-core/host.ts`: the canonical atomic pending-image batch operation used by clipboard and drop.
- `src/main.ts`: command routing, terminal context menu, preference update, and toast feedback.
- `src/terminal-themes.ts`: semantic extended ANSI backgrounds.
- `agent-core/main.ts`: semantic transcript calls and readable non-TTY fallback.
- `agent-core/tui.ts`: semantic transcript, Markdown rendering, thinking visibility, wrapping, and painting.
- Existing harness and e2e scripts: regression coverage.

No new service, store, sidecar schema, IPC naming style, or dependency is required.

## Testing

### Unit and harness tests

- Dropped-path quoting for spaces, quotes, metacharacters, and multiple files.
- Path-only drops accept directories and symbolic links without opening them, but reject control characters and unsupported platforms.
- Core drop rejection for empty, missing, directory, symbolic-link, unsupported, signature mismatch, zero-byte, oversized, over-count, and over-total inputs.
- Core drops call the canonical pending-image batch path and remain atomic under a mid-batch write failure, concurrent clipboard/drop requests, a consumer racing the producer, lock timeout, stale-lock recovery, consumer crash, and session-persistence failure.
- Queue tests cover malformed and oversized manifests/claims, atomic lock contention, malformed locks, `EPERM` owner checks, strict cleanup names, and recovery without deleting referenced images.
- A closed terminal cannot receive a late asynchronous drop result.
- An unauthorized IPC sender is rejected.
- Semantic streaming coalesces assistant and thinking chunks.
- Section changes preserve ordering.
- Concurrent and duplicate-ID tool results settle the entries identified by their opaque local handles.
- Interrupts settle pending tools as cancelled.
- Memory eviction drops oldest settled entries, removes their indexes, retains pending tools, caps entry count, and safely truncates an over-limit active entry.
- Markdown renders emphasis, strong text, inline code, fences, headings, lists, and quotes.
- Partial streamed Markdown remains literal until closed and reparses only the unfinished block.
- Long delimiter runs and deeply nested Markdown remain linear and bounded.
- Complete, chunk-split, malformed, and overlong ANSI/control input cannot inject terminal commands or consume later ordinary text.
- Hidden thinking disappears and reappears without content loss.
- Complete and chunk-split `CSI ? 9001 h/l` controls toggle thinking without altering the prompt draft; malformed or overlong private sequences are discarded without changing the draft.
- Thinking toggles preserve tail-follow and a scrolled non-thinking anchor.
- Combining characters, CJK text, and emoji wrap and clip by terminal cell width.
- Tool pending/success/error frames use extended indices 16/17/18.
- Extended semantic palette entries apply only to core xterm instances.
- A core palette is correct whether engine identity arrives before or after the first buffered PTY output.
- Every painted row resets its styles, and status text remains clear with color disabled.
- Non-TTY output remains readable.
- Existing session storage and provider block behavior remains unchanged; tests are updated only where the semantic TUI changes rendered expectations.

Every production behavior begins with a failing test. Assertions that require ANSI stripping will be replaced because flat stripping is the behavior this design removes.

### Integration and visual checks

- Preload resolves a disk-backed browser `File` without returning its path to renderer code; a constructed in-memory `File` fails closed.
- Pi/shell/Claude Code path drops insert quoted paths.
- Core image drops update the pending count and reach the next model request.
- Application menu, terminal context menu, and shortcut share one command.
- The thinking preference persists across restart and applies to new and live core terminals; a failed preference save does not change live state.
- Racing Settings, thinking-toggle, shortcut-activation, and `openProjects` updates commit in request order without losing fields; one rejected save does not block the next update.
- Typecheck passes.
- The complete `agent-core` harness passes.
- Production build passes.
- Relevant terminal e2e tests pass.
- The Electron e2e creates a disk-backed `File` through a temporary file input before dispatching the drop; a JavaScript-created `File` is not a valid substitute because Electron correctly gives it no host path.
- Dark, light, high-contrast, and Atom frames are inspected for assistant, thinking, pending tool, successful tool, failed tool, code block, and hidden-thinking states.

## Acceptance Criteria

- Dropping an image from Finder into a core terminal attaches it without clipboard use.
- Dropping files into Pi, shell, or Claude Code inserts safe absolute paths.
- Browser navigation never occurs from a terminal drop.
- Assistant Markdown no longer displays raw emphasis markers for supported syntax.
- Thinking is visually distinct, visible by default, and reversible through menu, context menu, and shortcut.
- Tool calls have clear pending, success, and error states.
- Theme switching preserves readable semantic colors.
- Transcript memory and render work remain bounded.
- Session files and the sidecar protocol remain unchanged. `agent-core/host.ts` remains the one canonical pending-image owner, and its JSON manifest plus final image-file formats remain unchanged while its internal synchronization is replaced.

## Audit Validation Questions

### Can renderer content request arbitrary file reads?

No. The renderer passes Web `File` objects to one fixed preload function. Preload resolves their paths and sends them directly to the fixed drop IPC handler. Main validates the sender and every path. Core file paths and bytes never return to renderer code. A path-only drop returns only the already quoted text that the user explicitly asked xterm to insert; the bridge exposes no arbitrary resolver or read operation.

### Can one failed image leave half a batch visible?

No. Main validates and reads every bounded source before calling the canonical batch writer. The writer stages files outside the queue lock, checks and commits under the lock, and atomically publishes the next manifest last. Manifest rename is the commit point, so failure cleanup never rolls back a visible committed generation.

### Can prompt consumption race a new attachment batch?

Yes, but it cannot corrupt or lose a live generation. Producer and consumer use the same canonical queue lock. The consumer renames the live manifest to its durable claim only while holding the lock and acknowledges only that claim after session persistence. The producer reads and replaces the live manifest only while holding the lock. Lock order therefore decides whether the complete new batch belongs to that prompt or the next one.

### What happens if a queue owner crashes?

The complete lock record contains owner process and age before its atomic hard-link acquisition. A later operation removes it only when the owner is confirmed dead and the five-second recovery age has passed. Producer temp files and consumer claims use recognizable app-owned names and bounded cleanup. A live or ambiguous lock is never stolen; the operation times out without mutating the live manifest. A dead consumer's durable claim is adopted by the next consumer rather than deleted.

### Can images disappear after they are read but before the session stores them?

No. Reading a claim does not acknowledge it. `runPrompt` reports successfully persisted names back to the queue under the lock. Failed or interrupted persistence leaves the unacknowledged refs in the durable claim, and the next prompt recovers them before it claims a newer live generation.

### What happens if the queue manifest is malformed?

The operation fails closed. While holding the lock it quarantines the malformed app-owned record under a strict name and reports `image queue is invalid`. It does not overwrite the record, infer an empty queue, delete referenced files, or scan outside the canonical events directory.

### Can a desktop image block Electron's main process?

No. Source open, stat, signature read, full read, staging, and manifest writes are asynchronous and bounded. The implementation does not use synchronous filesystem calls on this path.

### What happens when the terminal closes during a drop?

Main checks the terminal before work and again before commit. The operation returns `terminal closed`, attaches nothing, and the renderer clears its drop state.

### What happens when a core terminal already has pending images?

The whole batch is rejected if existing plus new unique images exceed `MAX_PENDING_IMAGES`. The writer never silently truncates the user's selection.

### What happens when a prompt is already running?

The batch attaches to the existing pending list and is consumed by the next prompt. The UI says this explicitly. It never mutates the active provider request.

### Can a symbolic link change between validation and read?

Direct core attachments open with no-follow semantics and validate through the same open descriptor used for reading. Path-only terminals do not open the path, so they may receive a symbolic-link path just as a native terminal would.

### Do semantic ANSI colors alter Pi or shell output?

No. Extended semantic colors are installed only on core xterm instances. Other engines retain the standard terminal palette.

### Can ANSI escapes or partial Markdown corrupt later rows?

No. Semantic ingestion removes control sequences, Markdown produces internal styled spans, and ANSI is emitted only after wrapping. Every row begins and ends in reset state. Incomplete streamed markers remain literal until closed.

### Does streaming repeatedly parse the full response?

No. Completed Markdown blocks and rendered entry widths are cached. Only the unfinished block and changed entry are invalidated, while frame scheduling remains coalesced at the existing 16 ms interval.

### Can pathological Markdown stall rendering?

No. Parsing is a bounded linear scan of only the invalidated block, with fixed delimiter and nesting limits. Text beyond supported limits is rendered literally.

### What if provider tool identifiers are empty or duplicated?

Transcript updates use opaque local handles returned at tool start. Provider identifiers continue to serve their existing session and sidecar contracts without becoming visual identity.

### What if a run stops with pending tools?

The turn finalizer marks its pending transcript tools as cancelled. No stale `running` box survives a settled or interrupted turn.

### Does hiding thinking lose data or move the user unexpectedly?

No. Hidden entries remain bounded transcript data. Tail-follow remains at the tail, and a scrolled view anchors to the nearest visible non-thinking entry. Showing thinking restores the same semantic entries.

### Can a preference write fail after the TUI changes?

No. Main saves the normalized candidate first, then commits its in-memory state, native theme, shortcut map, menu checkbox, renderer state, and live core terminals. The renderer waits for the normalized response instead of applying the toggle optimistically. Failure keeps the complete previous state and reports an error.

### Can a thinking toggle overwrite a simultaneous project-list or Settings change?

No. All preference mutations enter one main-process commit queue and carry only the fields they own or changed. Each operation merges into the latest committed state when it reaches the head, and main-owned `openProjects` never comes from a renderer snapshot. Saves and in-memory commits therefore have one order and preserve unrelated fields.

### Does the initial thinking setting leak into tool subprocesses?

No. Main launches a hidden-thinking core with a CLI flag instead of an environment variable. Runtime changes use one fixed private input sequence consumed by `AgentTui`.

### Can Unicode width break tool boxes or the cursor?

No. Wrapping, clipping, padding, scroll accounting, and cursor placement use terminal cell width and grapheme-safe boundaries rather than ANSI length or JavaScript code-point count.

### Does session resume reconstruct the styled live transcript?

No. Persisted session JSONL remains the conversation source, but live transcript layout is intentionally not persisted or replayed by this change. Semantic styling applies to output produced in the active TUI after launch or resume.
