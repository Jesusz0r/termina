# Computer use

> **Status:** in progress, revised 2026-10-31. The macOS desktop slice is
> PR #483; the browser slice is PR #482, stacked on it. Not shipped. Do not cite it from the user guide, the website, or
> `docs/reference/AGENT-CORE.md` until a slice has shipped. When a slice
> ships, change this status in the same change.

## Decision

Add a Termina-owned browser the agent can operate. Do not let that tool
drive the Mac desktop, and do not let it click Termina's own window.

A coding agent needs to open the app it just built, read a page, and fill
a form. It does not need the login session. Anthropic splits the same
way: browser use for pages, computer use only when the task needs a whole
desktop. OpenAI's current recommendation for GPT-6 Astra is a persistent
browser the application runs, not a tool that posts events into the
user's session.

This plan does not make that decision true for every path the agent
already has. See [Known holes](#known-holes).

A virtual machine is a different product. Do not ship one in this plan.

The product also approved a separate **macOS desktop slice** on 2026-10-31:
`agent-core/main/desktop.ts` over the native `agent-desktop` CLI. It is
opt-in, macOS-primary-only, per-app and per-action approved, and is not part
of the browser owner. The browser must remain headless and must not drive
the desktop.

## Do not build

- Control of the user's desktop **from the browser tool**, Screen Recording
  of the login session, or posting mouse and keyboard events into other
  applications from the browser. The separate macOS desktop slice below is
  the only approved desktop owner.
- The browser candidate profile cannot enforce desktop isolation:
  `buildSandboxProfile` in `electron/sandbox.ts` is `(allow default)` plus
  file denies. It does not deny the window server, Apple events, or input
  injection. The browser owner may call only the browser's page API. No
  `CGEvent`, `osascript`, `screencapture`, or a driver that needs them. If
  the driver cannot act without those, refuse the driver.
- A visible browser window. v1 is headless. A visible window is a second
  control surface and can be mistaken for the user's browser. The user
  sees the approval text, not a live page.
- Control of Termina's Electron window, Monaco, or the file explorer.
  The terminal stays the source of truth. The renderer never talks to
  the agent.
- Attaching to a running browser, or launching with the user's Chrome
  profile, keychain, or password store. A spawn that attaches to an
  existing process is a failed start, not a fallback.
- Anthropic's `bash_20250124` or text-editor tools.
- An `exec_js` or `exec_py` computer-use tool. Page text is untrusted,
  and Termina already has bash.
- An MCP server as the browser transport. MCP results are bounded text.
  Do not extend MCP into an image protocol for this feature.
- A skill or prompt that tells the model to drive the GUI through bash.
- `@playwright/test` as the product browser. It stays a test dependency.
- A computer-use panel, or any UI that exposes sidecars, leases, or the
  core protocol.
- A password, purchase, or cookie classifier.
- A saved preference, a `TERMINA_CORE_APPROVE` alias, or a `/permissions`
  mode for this tool. `/permissions` owns bash policy only.
- A change to `FROZEN_IDENTITY`, `agent-core/stall.ts`, or settle in
  `agent-core/main.ts` in the same PR as the tool. Snapshot loops will
  look like progress to the current stall tracker. That is a follow-up.
- Hot-swapping the tool into a process that already built its schema.
  Do not add a second stored tool schema to hide the tool from resumed
  or forked sessions. A new process builds tools from the current
  binary. That is the existing rule.
- A screenshot action in the first slice. The current result path cannot
  deliver one. See [Screenshots](#screenshots).

## Desktop slice (macOS)

Approved 2026-10-31 as a separate owner, not as part of the browser.

- Owner: `agent-core/main/desktop.ts` over `agent-desktop` v1.0.2; add
  `desktop` to `KERNEL_TOOL_NAMES` so an MCP server cannot take the name.
- Packaging: `scripts/prepare-native-tools.ts` stages the macOS release
  archive (binary plus helper) and its Apache-2.0 license into
  `resources/bin`, checksum-pinned like ripgrep. No npm dependency, no
  install script. Development uses a trusted `PATH` install.
- Process: `agent-core/main/native-cli.ts` is the only spawner for the
  native agent CLIs (allowlisted env, bounded output, interrupt, tree kill
  via `agent-core/main/bash.ts`).
- macOS primary sessions only. Absent from print runs, subagents, worldline
  candidates, and read-only sessions.
- No slash command or enable flag: the model decides when a task needs a
  native app and calls the tool. The approvals below are the control.
  `/clear` clears approved apps and refs.
- Per-app observation approval, plus a separate approval for
  `click`, `type`, `set_value`, `press`, and `scroll`.
- No screenshots, clipboard, notifications, app/window lifecycle, pointer
  input, or headed mode. Termina's own window is blocked by the requested
  name and by the app `agent-desktop` resolved (`Electron` in development).
- Accessibility permission is required. A `PERM_DENIED` result names the
  System Settings pane and does not pretend the action completed.
- Snapshot refs belong to one snapshot and one app; stale or unknown refs fail
  closed. The tool is not in `READ_TOOLS`, so it is a mutation barrier.
- The browser slice remains headless and never drives the desktop.

Desktop first-slice tests cover request parsing, exact argv, snapshot/ref
ownership, reset, permission errors, the resolved-app Termina block,
interrupt, release staging, and the tool schema.

## Known holes

These stay true after the first slice. Do not describe the slice as
closing them.

- The macOS desktop tool is unsandboxed and operates under the user's
  Accessibility permission. Per-app and per-action approval is the control;
  it is not a sandbox.
- macOS grants Accessibility to the responsible app, Termina. The grant
  likely also reaches the agent's `bash` and the terminal shells
  (`osascript`, System Events), which have no per-app approval. Confirm
  in the manual smoke test.
- `desktop` can observe and operate a browser app, including the user's
  signed-in Chrome, behind the same per-app approval. The tool
  description steers web pages to the browser tool; it is not a block.
- Primary terminals are unsandboxed. `isDangerousBash` in
  `agent-core/main/tools.ts` does not treat `osascript`, `screencapture`,
  or `cliclick` as dangerous. The agent can already drive the GUI
  through bash. Closing that hole is a bash change, not this tool, and
  it is not part of the first slice.
- The same unsandboxed agent can read its own browser profile through
  bash. The profile is not a secret from the agent. It is isolated from
  the user's browser, from promotion, and from the browser child.
- The browser reaches the host's loopback and private network, unlike
  `fetch`. The per-action ask with the full origin is the control. Do not
  describe the browser as network-isolated.
- A SIGKILLed agent leaves its browser state directory (cookies,
  downloads) and `/tmp/tb-*` behind until the OS temp reaper runs; the
  daemon stops itself after 5 idle minutes.
- The browser has no `sandbox-exec` deny list. Chrome's own sandbox is the
  confinement for page content; a renderer escape is the user's process.
  Chrome cannot start its sandbox inside `sandbox-exec` (checked
  2026-10-31 with agent-browser 0.41.0), and `--no-sandbox` would trade
  Chrome's renderer sandbox for a weaker file deny list.

## Shape (browser)

Decided 2026-10-31, after the first-slice spike showed the original
confinement rule cannot hold for a Chrome driver.

- Owner: `agent-core/main/browser.ts` over `agent-browser` v0.41.0,
  staged checksum-pinned into `resources/bin` with its Apache-2.0 and
  axe-core licenses by `scripts/prepare-native-tools.ts`. Spawned only
  through `agent-core/main/native-cli.ts`. `browser` is in
  `KERNEL_TOOL_NAMES`. The MCP surface (29 tools, about 82 KB of schema)
  is not used.
- Offered on macOS and Linux to interactive primary sessions. Absent from
  print runs, subagents, read-only sessions, and worldline candidates
  (they auto-approve, and Chrome cannot start inside the candidate
  sandbox). No slash command, enable flag, or preference: the model
  chooses the tool.
- Confinement: Chrome's own sandbox. agent-browser adds `--no-sandbox`
  for root and containers, so the tool refuses to start there
  (`chromeSandboxUnavailable`). Each process gets a fresh private
  state directory (0700) with its own `HOME`, profile, downloads, and an
  empty `--config`, so `~/.agent-browser` and a project
  `agent-browser.json` are never read. The child env is allowlisted, cwd
  is the state directory, and sockets live in a private `/tmp/tb-*`.
  The user's Chrome profile, keychain, and running browsers are never
  attached. Because `HOME` is private, Chrome is found only system-wide
  (for example `/Applications/Google Chrome.app`); a Chrome for Testing
  install under the user's `~/.agent-browser` is not used.
- Lifecycle: agent-browser always runs a daemon. It is per process (its
  own socket directory), closed on `/clear`, on a model `close`, and on
  process exit (synchronously, including SIGTERM/SIGHUP), and it stops
  after 5 idle minutes if the agent dies. If `close` fails, the daemon's
  process group is killed from its pid file. Close deletes the state
  directory. A new start always
  gets a new profile.
- Actions: `open`, `snapshot`, `get` (text, html, value, title, url),
  `wait`, `click`, `fill`, `type`, `press`, `close`. No eval, screenshot,
  file URL, upload, download path, tab, or raw flag. `press` refuses
  paste chords (`Meta+v`, `Control+v`, `Shift+Insert`); text enters only
  through `fill`/`type`, which the user approved.
- Approval: `open`, `click`, `fill`, `type`, and `press` ask every time
  through `queueApproval`, with Deny and Approve once only. The prompt
  shows scheme, host, and port in full; path and typed text are
  display-capped. A click on a ref names its role and label. `snapshot`,
  `get`, and `wait` do not ask, and refuse until an approved `open` has
  loaded a page. Denial executes nothing. Without a local picker the call
  is denied, never left waiting. `TERMINA_CORE_APPROVE=all` does not skip
  these asks; it only sets bash's permission mode.
- Page guard: the page stays on the origin of the last approved `open`.
  A redirect to another origin fails and leaves a blank page. Before
  every read and after every action, extra tabs (popups) are closed and
  reported as denied, and a page on another origin is sent back to the
  last approved URL with an error.
- Refs: `@eN` refs are accepted only from the latest snapshot; any
  action invalidates them. CSS selectors are always allowed.
- Dialogs are dismissed, never accepted, and the action returns an error
  (agent-browser dismisses `alert`; the page guard dismisses a blocking
  `confirm`/`prompt`). Geolocation and notification requests are denied
  and camera access is never granted in headless Chrome (checked live).
  Downloads land in the private
  downloads directory, are deleted on close, and are outside the
  project, so the agent cannot read them.
- Output: bounded to 32 KB, wrapped in content boundaries, and labeled as
  untrusted page data. The truncation marker says to narrow the snapshot,
  not to re-run it; the repro hint for a stubbed result is a new
  `browser snapshot`.
- `browser` is not in `READ_TOOLS`, so it is a mutation barrier, and the
  duplicate-action refusal in one batch is unchanged.
- Batch halt: in the tool loop, a failed or denied `browser` or `desktop`
  call skips later `browser`/`desktop` calls in the same response, and
  each skipped call still gets an error result.

Tests cover the parser, approval text, private state and cleanup, the
redirect failure, stale refs, the origin guard, popups, release staging,
and the batch halt. A live run against Chrome checked dialogs, popups,
cross-origin links, downloads, and cleanup.

## Screenshots

Not in the first slice. A screenshot the model never sees is worse than
no screenshot action.

`providerBlock` in `agent-core/request-projection.ts` expands a
top-level image block. It does not walk images nested in
`tool_result.content`. `blockText` keeps only text from a tool result,
and the OpenAI Responses, Completions, and Google mappers send that text.
A file ref or an image block inside a tool result does not reach those
models. Inline base64 is also the wrong store: `MAX_SESSION_RECORD_BYTES`
is 1 MiB, and a page PNG can exceed it.

A later screenshot action requires, in the same change:

- a file ref in the session record, not inline bytes, under an image
  root the session already uses
- expansion of images nested in tool results, not a second expander
- a mapper path for each protocol that can actually attach an image to
  a tool result
- a reclaim stub that removes the image source, rather than
  JSON-stringifying it or claiming the file is still the page
- transcript and sidecar text that never contains image bytes
  (`toolTranscriptOutput` will otherwise display result content)

Until that exists, do not add the action.

## Later, only if the first slice is not good enough

Native provider toolsets are adapters onto the same executor. They
replace the `browser` function tool for that model. They do not sit
beside it. An adapter that still leaves `browser` in the schema is a
second browser.

Do not add an adapter until the screenshot path above exists. Anthropic's
browser toolset and OpenAI's `computer` tool both expect an image back.
Re-read the provider docs in the turn that edits the protocol. Do not
implement from the notes below if the docs have moved.

Checked 2026-09-28:

- [Anthropic computer use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool).
  Claude 5.5 and later, on the Claude API and Google Cloud, take
  `computer_toolset_20260801` and reject `computer_20251124`. Member
  calls carry `toolset_name: "computer"`, run in order, and a failure
  halts the rest of the batch. Screenshot and zoom results are image
  blocks. Older models that still want `computer_20251124` need a beta
  header. Do not support both versions in the first adapter.
- [Anthropic browser use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool).
  Closer to this plan than computer use. One
  `browser_toolset_20260801` entry. Member calls carry
  `toolset_name: "browser"`. The halt text is the browser-use text, not
  the computer-use text. Anthropic's injection classifiers run for
  their toolset. A Termina function tool does not get them.
- [OpenAI computer use](https://developers.openai.com/api/docs/guides/tools-computer-use).
  For GPT-6 Astra, OpenAI recommends code execution against a persistent
  browser. The `{ type: "computer" }` tool is the alternative: a
  Responses `computer_call` with an ordered `actions` array, answered by
  `computer_call_output`. That is a change in
  `agent-core/openai-compat/responses.ts`, not a function tool.

If an Anthropic adapter is added, append the toolset from `requestTools`
in `agent-core/main.ts`, next to `web_search`, and only for a model
`agent-core/models/` says supports it. Dispatch on `toolset_name`.
Member names such as `type` must not be looked up as Termina tools. Do
not register Anthropic bash or text-editor tools beside it.

A VM, or control of Termina's window, stays out of this plan.
