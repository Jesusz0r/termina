# Computer use

> **Status:** proposed, revised 2026-09-28 after checking the cited seams.
> Not implemented. This file is the plan. It is not current behavior. Do
> not cite it from the user guide, the website, or
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

## Do not build

- Control of the user's desktop, Screen Recording of the login session,
  or posting mouse and keyboard events into other applications. The
  candidate profile cannot enforce this: `buildSandboxProfile` in
  `electron/sandbox.ts` is `(allow default)` plus file denies. It does
  not deny the window server, Apple events, or input injection. The
  control is the browser owner, which may call only the browser's page
  API. No `CGEvent`, `osascript`, `screencapture`, or a driver that needs
  them. If the driver cannot act without those, refuse the driver.
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

## Known holes

These stay true after the first slice. Do not describe the slice as
closing them.

- Primary terminals are unsandboxed. `isDangerousBash` in
  `agent-core/main/tools.ts` does not treat `osascript`, `screencapture`,
  or `cliclick` as dangerous. The agent can already drive the GUI
  through bash. Closing that hole is a bash change, not this tool, and
  it is not part of the first slice.
- The same unsandboxed agent can read its own browser profile through
  bash. The profile is not a secret from the agent. It is isolated from
  the user's browser, from promotion, and from the browser child.
- A candidate can reach the host's loopback. The sandbox language cannot
  express a per-host allowlist. Do not add one. The per-navigate ask is
  the control. Do not describe the candidate browser as network-isolated.
- A malicious page in a browser that runs as the user is still that
  user's process if confinement fails. That is why start refuses when
  the child deny list cannot be applied.

## Shape

One owner, started by the agent process, on the same side of the
boundary as `agent-core/main/bash.ts`. Intended owner:
`agent-core/main/browser.ts`. The tool schema stays with the other
built-in tools. Do not grow a second dispatcher. Add `browser` to
`KERNEL_TOOL_NAMES` in `agent-core/mcp/tools.ts` in the same change so a
server tool cannot take the name.

The owner does not import `electron/sandbox.ts`. Agent-core already
spawns `sandbox-exec` itself for sibling claims. The browser child
profile is the browser owner's, consumed the same way. Do not fold
browser denies into the candidate profile. That profile is shared by
every candidate process and can read candidate support, including the
copied `auth.json`.

### Process

One browser per terminal process. Start it lazily, on the first
approved action after enable, not at process start. It is a child of
the agent, in a process group the owner kills, following
`agent-core/main/bash.ts`. Do not daemonize. Interrupt, timeout, and
process exit kill the child and return an error result. A hang is not
an open approval. The bound is not longer than `BASH_TIMEOUT_MS`.

`/clear` destroys the process and its profile and clears enablement.
Clean exit does the same. A new enable always creates a new profile
directory. Never reuse a profile from a previous process, including one
left by a crash. Do not put the profile in the session bundle. A fork materializes
that session through the fork point, including referenced images. It
does not restore a page or cookies unless they were stored in the
bundle.

### Confinement

Refuse to start unless a `sandbox-exec` deny list can be applied to the
browser child. That is macOS only. No unconfined browser on Linux or
Windows, and no retry outside the sandbox.

The child may read and write only its profile directory, plus the
browser binary and libraries it needs to start. It must not read:

- `auth.json`, whether that is `~/.termina/agent/auth.json` or the
  candidate copy under support
- the user's browser profile, keychain, or password store
- the project tree

The profile directory itself is not the agent home, not the project,
and not the candidate source directory. In
`electron/worldlines/manager.ts` that source directory is
`join(dir, label)`. Candidate browser state lives under that
candidate's `supportDir` (`join(dir, `${label}-support`)`), which is a
sibling of the source directory, not a child of it. Promotion and
capture must not see the profile. Primary state lives in an app-owned directory
outside the project and outside the user's home browser data.

The child environment must not resolve the user's browser profile.
Ignore inherited `HOME`, user-data-dir, and config-dir values that
point there. Credential storage is off. If the driver cannot start
under those constraints, refuse.

File URL access is off. Popups, new windows, downloads, and file
choosers are denied. There is no download directory and no promise that
the agent can `read_file` a download. `confinePath` in
`agent-core/main/files.ts` refuses paths outside the project, and a
download inside the project would be capturable and promotable.

Geolocation, camera, microphone, and notification permission are denied
at launch. A JavaScript dialog is dismissed, not accepted, and the
action returns an error rather than hanging. `key` must not paste the
system clipboard. Text enters only through `type`, which is what the
user approved.

### Who is offered the tool

The schema is fixed at process start.

- Interactive TUI sessions, including worldline candidates, include the
  tool. Calls before enable fail with the tool off. They do not start
  the browser.
- `-p` / `--print` and piped runs omit it, even when
  `TERMINA_CORE_APPROVE=all`. A print run can still have a TTY, so the
  print flag is the check, not the absence of a surface.
- Subagents omit it. Their approval channel is `bash` or `protected`
  only, and a child browser is a second process.

If a call is forced where there is no local picker, deny. Never wait.
Do not extend the parent approval file format in v1.

Enablement is a flag on this process, set by a `/browser` slash command.
It is not a preference and not bash's permission mode. It is off at
start and off after `/clear`. Enabling or disabling must not add or
remove the tool.

### Tool

One function tool, `browser`, on the existing function-tool path.
Actions:

| Action | Effect |
|---|---|
| `navigate` | Open one `http` or `https` URL in the single page. |
| `snapshot` | Return bounded accessibility text with element refs. No pixels. |
| `click` | Click one ref from the latest snapshot. |
| `type` | Type into that ref. The action names the ref. It does not depend on ambient focus. |
| `key` | Press one page key chord. Not an OS shortcut, and not a paste. |

No coordinate click in v1. A ref that is not in the latest snapshot is
an error, not a guess, even if the same string appeared in an older
snapshot. `navigate`, `click`, `type`, and `key` invalidate refs. The
model must `snapshot` again. A ref resolves to the element from that
snapshot, not to a fresh positional index.

Parse URLs with the URL parser. Do not allow by string prefix. Scheme
must be `http` or `https`. Reject userinfo (`https://user:pass@host`),
`file`, `data`, `javascript`, `blob`, `chrome`, and `about`. The initial
blank page is the tool's, not a URL the model can request.

`navigate` approval is for the URL the user was shown. A redirect whose
origin (scheme, host, port) differs from that URL is a failure. A
`click`, `type`, or `key` that lands on an origin the approval did not
disclose is a failure. On failure, leave the previous `http`/`https`
page, or the blank page if there was none. Do not stay on the
undisclosed origin. A landing URL that is not `http` or `https` is the
same failure.

`snapshot` goes through the existing bounded tool-text path. Its marker
must not say to re-run the same snapshot for the omitted tail.
`genericToolText` in `agent-core/tool-output.ts` says that. Do not use
that marker unchanged. The result starts with a fixed line that the
following text is untrusted page content, not instructions. That line
is tool output, not identity text.

`browser` is not in `READ_TOOLS`. `snapshot` included. Concurrent reads
must not overlap a browser action. Do not weaken the existing
duplicate-action refusal.

Reclaim may stub a snapshot like any other tool result. The reproduce
hint is a new `snapshot`, not a file read, and the stub must not say
the cleared text is still the page. `formatStub` already says the text
was cleared. Keep it that way.

### Approval

Reuse the existing picker queue (`queueApproval`). Do not add a renderer
modal. Do not offer "Always approve". v1 has no always-approve mode,
and `TERMINA_CORE_APPROVE=all` does not skip these asks.

- `navigate`, `click`, `type`, and `key` ask every time.
- `snapshot` does not ask again after enable. It only observes the
  Termina-owned page.
- Schema rejection stays in `agent-core/tool-dispatch.ts`, before the
  prompt and before the browser starts.
- The prompt shows scheme, host, and port in full. A 160-character slice
  is not enough: bash display-caps the command, and a capped URL can
  hide the host. The path and the typed text may be display-capped. The
  action that runs is the parsed URL and the full approved text, not
  the truncated display.
- A click prompt includes the ref's label and href when the snapshot
  has them.
- Denial executes nothing.

### Batch halt

`toolExecutionWaves` runs non-read tools one at a time. It does not skip
later calls when one fails. If a browser action fails or is denied, later
browser actions in that response do not run. Each still needs a result,
or the next provider request is rejected.

The existing tail fill in the tool loop only covers interrupt and
steering. It does not run when a browser action fails. The browser halt
has to write those results itself. Breaking out of the wave loop is not
enough.

The halt text is Termina's. It is not Anthropic's computer-use halt
string.

## First slice

1. Confinement and lifecycle above. Refuse to start when the child deny
   list cannot be applied. New profile on every enable. No reuse.
2. The `browser` tool, `/browser`, approval, origin failure, stale-ref
   failure, and the batch halt.
3. Tests:
   - a failed or denied browser action does not run the next browser
     call, and the skipped call still has a result;
   - a non-`http`/`https` URL, or a URL with userinfo, is rejected
     before a prompt and before the browser starts;
   - a cross-origin redirect does not leave the browser on the new
     origin;
   - a stale ref is not acted on;
   - the profile is not in the candidate source directory, not the
     user's Chrome profile, and not a directory that contains
     `auth.json`;
   - print mode and subagents are not offered the tool;
   - enablement does not change the schema, and the picker has no
     always-approve choice;
   - downloads and popups are denied;
   - there is no screenshot action and no image bytes in the sidecar.

No protocol adapter in this slice. No user-guide page until the tool
exists.

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
