# Terminal Image Drop and Semantic Transcript Design

Date: 2026-08-27

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
- Start a tool with its call identifier, name, and display detail.
- Finish a tool with success or error state and optional output.
- Append an error.
- Set whether thinking is visible.

Exact method names are an implementation detail. The interface must express these responsibilities without a generic style parameter.

### Streaming and transitions

- Consecutive chunks of the same active assistant or thinking entry merge in place.
- A section change closes the active streamed entry.
- A tool start creates one pending tool entry keyed by tool call identifier.
- A tool finish updates that same entry. It does not append a parallel result representation.
- Concurrent tools can finish out of order because lookup uses the tool call identifier.
- Server tools use the same tool-entry path.
- Non-TTY output retains readable plain headings and text. Semantic frame rendering applies only when `AgentTui` is active.

### Bounds and performance

- Keep the existing total transcript character budget as the primary memory bound.
- Tool output is capped before it enters the transcript model.
- Evict the oldest complete entries when the budget is exceeded. Do not split the active streaming entry unless it alone exceeds the budget.
- Cache rendered lines per entry and terminal width. Invalidate only a changed entry or a width-dependent cache after resize.
- Build only enough wrapped lines to fill the visible transcript plus scroll offset.
- Preserve the current changed-row comparison so the PTY receives only rows whose rendered content changed.
- Never create one entry or one render pass per token.

## Transcript Presentation

### Theme roles

The TUI emits standard ANSI foreground roles and three extended palette backgrounds:

- Extended index 16: tool pending background.
- Extended index 17: tool success background.
- Extended index 18: tool error background.

`src/terminal-themes.ts` defines those indices for dark, light, high-contrast, and Atom themes through xterm's `extendedAnsi` palette. `AgentTui` uses the indices, not hard-coded RGB values, so changing the xterm theme updates transcript rendering without restarting the child process.

Foreground roles use the existing terminal palette:

- Default foreground for assistant text.
- Bright black plus italic for thinking.
- Blue/accent plus bold for section and tool titles.
- Red for errors.
- Dim foreground for metadata and truncated-output notices.

High-contrast colors must retain clear text/background contrast. Background presentation must fall back to borders and labels when color is unavailable.

### Markdown subset

Assistant and thinking entries support the Markdown constructs visible in normal agent output:

- Paragraphs and line breaks.
- Emphasis and strong emphasis.
- Inline code.
- Fenced code blocks.
- Headings.
- Ordered and unordered lists.
- Block quotes.

The renderer must escape or treat embedded ANSI and control sequences as text. Markdown parsing is local to `AgentTui`; callers provide content, not pre-rendered formatting.

The implementation should use a small direct parser suitable for terminal display. It must not add a dependency or duplicate a separate renderer elsewhere in the application.

### Thinking

- Thinking is visible by default.
- Thinking content is limited to provider-supplied visible summaries or thinking blocks.
- Hiding thinking removes its rendered rows but keeps its semantic entries.
- Showing thinking restores the same entries and scroll behavior.
- Encrypted reasoning with no visible summary produces no transcript entry.

### Tools

- Pending, successful, and failed tools use their semantic background role.
- The title contains the tool name and a compact display detail such as a path, command, pattern, or URL.
- Results show a bounded preview appropriate to the existing tool formatting rules.
- Truncated output includes a dim count or truncation notice.
- Tool errors use the error background and retain their bounded error text.

## Thinking Preference and Controls

Add `showThinking: boolean` to `AppPreferences`, defaulting to `true`. `shared/preferences.ts` remains the only validator and default-fill path. Existing preference files without the field receive the current default through normal validation.

Add one canonical renderer command, `toggle-thinking`, to the command registry:

- Label: `Show Thinking` or `Hide Thinking`, based on current state.
- Category: Terminal.
- Default shortcut: `CmdOrCtrl+Shift+H`.
- The Settings shortcut editor can rebind or clear it through the existing command registry.

The command is available through:

- The application Terminal menu.
- The terminal context menu.
- The configurable keyboard shortcut.

The command updates preferences through the existing preferences bridge and applies the new state to every live core terminal. Pi and shell terminals ignore the rendering control.

The host sends one reserved control sequence to a core terminal when the preference changes. `AgentTui` consumes it as a display command and does not insert it into prompt input. New core terminals receive the current value in their launch environment so their first frame is correct. This keeps the renderer from owning or repainting agent content.

## Desktop File Drop

### Renderer and preload

`PtyView` owns terminal-surface drag behavior:

- Prevent browser navigation for a supported file drag over the terminal.
- Show a local drop-target state.
- On drop, collect the browser `File` objects and ask preload to resolve each host path with Electron's `webUtils.getPathForFile`.
- Send only the terminal identifier and resolved path list to main. Do not send image bytes over renderer IPC.

Preload exposes one narrow dropped-file path operation. It does not expose general filesystem access.

### Main-process validation

Main remains the privileged owner of file reads. One `terminals:drop-files` handler:

1. Validates the terminal identifier and a small maximum file count.
2. Rejects empty paths, directories, missing files, symbolic links, unsupported extensions, unsupported media signatures, and files over the existing image byte limit.
3. Resolves every path before changing terminal state.
4. Applies the drop atomically: one invalid item rejects the entire drop.

For a core terminal:

- Accept PNG, JPEG, WebP, and GIF images supported by the existing host model.
- Read the validated files in main.
- Call the existing `appendPendingImage` owner for each image.
- Return the resulting attachment count.
- Notify the TUI with the existing paste-end control input so its status refreshes.

For Pi, shell, and programs such as Claude Code:

- Do not read file contents.
- Return safely quoted absolute paths.
- `PtyView` inserts those paths through its existing terminal input callback.
- Separate multiple paths with one space.
- Quote for the terminal platform so spaces and shell metacharacters remain literal. Quoting does not execute the path.

### Feedback

- Invalid drops show one renderer toast with a concise reason.
- Successful core drops update the existing image count in the TUI.
- Successful path drops insert text and focus the terminal.
- Drag cancellation changes no state.

## Error Handling and Security

- Keep dropped-file reads out of the renderer.
- Cap the file count, per-file bytes, and total bytes before reading.
- Validate file signatures in addition to extensions for direct attachments.
- Reject symbolic links for direct attachments so validation and read address the same file.
- Use explicit resolved paths. Do not expand globs or environment variables.
- Never run a dropped path as a command.
- Do not partially attach a multi-file core drop.
- Treat malformed semantic updates as plain error output, not a renderer crash.
- Strip input control sequences before Markdown interpretation.

## Files and Canonical Ownership

Expected implementation areas:

- `src/pty-view.ts`: terminal drag/drop interaction and path insertion.
- `electron/preload.ts`: narrow `webUtils.getPathForFile` bridge.
- `shared/types.ts`: typed drop operation and preference field.
- `shared/commands.ts`: one `toggle-thinking` command.
- `shared/preferences.ts`: canonical preference validation.
- `electron/main.ts`: drop validation, core attachment, launch preference, and Terminal menu item.
- `src/main.ts`: command routing, terminal context menu, preference update, and toast feedback.
- `src/terminal-themes.ts`: semantic extended ANSI backgrounds.
- `agent-core/main.ts`: semantic transcript calls and readable non-TTY fallback.
- `agent-core/tui.ts`: semantic transcript, Markdown rendering, thinking visibility, wrapping, and painting.
- Existing harness and e2e scripts: regression coverage.

No new service, store, sidecar schema, IPC naming style, or dependency is required.

## Testing

### Unit and harness tests

- Dropped-path quoting for spaces, quotes, metacharacters, and multiple files.
- Drop rejection for empty, missing, directory, symbolic-link, unsupported, oversized, and over-count inputs.
- Core drops call the existing pending-image path and remain atomic.
- Semantic streaming coalesces assistant and thinking chunks.
- Section changes preserve ordering.
- Concurrent tool results settle the matching tool entries.
- Memory eviction drops oldest complete entries and keeps the active entry valid.
- Markdown renders emphasis, strong text, inline code, fences, headings, lists, and quotes.
- Embedded ANSI/control input cannot inject terminal commands.
- Hidden thinking disappears and reappears without content loss.
- Tool pending/success/error frames use extended indices 16/17/18.
- Non-TTY output remains readable.
- Existing session storage and provider block tests remain unchanged.

Every production behavior begins with a failing test. Assertions that require ANSI stripping will be replaced because flat stripping is the behavior this design removes.

### Integration and visual checks

- Preload resolves browser `File` objects without exposing filesystem APIs.
- Pi/shell/Claude Code path drops insert quoted paths.
- Core image drops update the pending count and reach the next model request.
- Application menu, terminal context menu, and shortcut share one command.
- The thinking preference persists across restart and applies to new and live core terminals.
- Typecheck passes.
- The complete `agent-core` harness passes.
- Production build passes.
- Relevant terminal e2e tests pass.
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
- Session files, sidecar protocol, and the existing pending-image store remain canonical and unchanged.
