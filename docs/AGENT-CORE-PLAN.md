# agent-core harness upgrades

Take the only Meta-Harness lessons that belong in the kernel: freeze and cache the prefix, retrieve instead of stuffing, keep traces recoverable. Do not build an outer-loop harness searcher.

Learn Harness Engineering ([walkinglabs/learn-harness-engineering](https://github.com/walkinglabs/learn-harness-engineering)) is a third layer. It does not replace this plan. It confirms the kernel moves and names artifacts that must **not** land in `agent-core`.

Termina lets the user pick a terminal engine. Those engines are independent:

1. **Pi** — existing TUI. Unchanged.
2. **agent-core** — this kernel. This change set.
3. **Shell** (bash and the other detected shells) — unchanged.

This work builds **agent-core only**. It does not change Pi, does not share Pi's home directory or skill paths, and does not defer kernel behavior to Pi.

The kernel owns its instruction files, skill scan, tools, cache, stubs, and traces. `agent-core` stays one process, one file (`agent-core/main.ts`). Termina's pty, sidecar, timeline, and modified list stay the host contract so an Agent (core) tab still shows up in the app. `termina-core` stays the snapshot/Git owner. `docs/AUTH-PLAN.md` stays a separate track.

## Three layers (do not mix)

| Layer | Job | This change |
|---|---|---|
| **Kernel** (`agent-core`) | Frozen prefix, cache, retrieval tools, recoverable stubs, traces | Implement |
| **Repo harness** (course) | Project `AGENTS.md`, tests, progress, init, handoff | Out of scope. The opened project owns those files |
| **Meta-Harness searcher** | Rewrite harness source via outer-loop search | Out of scope |

Keep the core small. Load skill bodies on demand so the prompt cache stays hot. Put verification commands in the project's `AGENTS.md`, not in the kernel.

Codex context ops, mapped onto what already exists. Do not add a second subsystem for any of them:

| Op | Owner |
|---|---|
| **SELECT** | Skill index + `grep` / `glob` + `read_file` |
| **WRITE** | Session JSONL, recognized sidecar events, trace files, inventories on handoff |
| **COMPRESS** | Reclaim first, summarize second (P2). This change unifies stub text and makes revision replay exact |
| **ISOLATE** | Dispatch workers + worldlines. Not a kernel `spawn_agent` |

## Which `AGENTS.md`

Two files, both frozen at process start. Project last, so it can refine the user file:

1. **User-global:** `~/.agents/AGENTS.md` if it exists. Personal prefs across projects. Same tree as user skills.
2. **Project:** `resolve(process.cwd(), "AGENTS.md")`. The pty cwd is the workspace root (opened folder, or a worldline candidate sandbox).

Do **not** read:

- Termina's own repo `AGENTS.md` unless that repo is the opened folder
- A per-terminal instruction file (there is none)
- Parent-directory `AGENTS.md` above cwd. That is the trust leak (a folder under `/tmp` inheriting `~/AGENTS.md`)
- `SYSTEM.md`, `APPEND_SYSTEM.md`, `CLAUDE.md`. One instruction name per scope: `AGENTS.md`. Missing means no file at that scope

Cap each file separately (global 8,192 chars, project 24,576). Same overflow note as audit fix 9.

`read_file` is jailed to cwd, with one exception: the frozen allow set from startup (user-global `AGENTS.md` and every scanned `SKILL.md`). A truncated **project** `AGENTS.md` is recoverable by cwd `read_file`. A truncated **user-global** file is recoverable by `read_file` of that absolute path (allow set). Do not open any other home-directory path.

Shrinking Termina's 878-line `AGENTS.md` into a directory page is optional hygiene for sessions whose cwd is this repo. It is **not** this change set.

## Out of scope

- Meta-Harness proposer / Pareto search over harness source
- Draft-verify classification, BM25 math retrieval, contrastive label prompts
- Verification checklists or completion state machines
- Calling `worldline-git` / the snapshot store from the kernel
- Renderer, preferences, IPC, or a second skill format
- Importing another agent engine's package into `agent-core`
- Walking ancestor `.agents/skills` (widens trust past the opened folder)
- Adding `usage` to `SIDECAR_KINDS` (evidence does not read it yet)
- `feature_list.json`, `progress.md`, `init.sh`, `session-handoff.md` (duplicates Plan Board, sidecar, Verify, session JSONL)
- Auto-run `init.sh` at kernel start
- Maker-checker / planner-generator-evaluator roles (P6: routing changes cost, never behavior)
- Graph engine, `spawn_agent`, LangGraph (Dispatch + worldlines already isolate)
- Extension / hook / plugin **surface** (loader, event bus, user TypeScript). That is a platform. This kernel is one file. Kernel-owned policy is not a plugin
- Walking ancestor `AGENTS.md`, or loading `SYSTEM.md` / `CLAUDE.md`
- Pluggable compaction strategies (reclaim-then-summarize is the one strategy; no second implementation, so no strategy interface)
- Letting the agent rewrite the harness as a kernel feature (Meta-Harness outer loop). Editing `agent-core/main.ts` when cwd is Termina is ordinary coding, not a searcher
- OpenTelemetry / Jaeger (trace JSON files are enough)
- Sprint contracts, scoring rubrics, or context-budget tables in the prompt
- Mid-session environment deltas in zone 1 (branch / dirty / cwd would invalidate the prefix)
- Lowering the 24,576-char project `AGENTS.md` cap in this change set (measure cache-read tokens first)

**Why those paper/course items stay out (not sequencing):**

- **Outer-loop proposer that rewrites `agent-core/main.ts`.** That is a second product: a searcher over harness source. This kernel is the coding engine the user selected. Traces in this change set are the diagnostic filesystem that search would need; they do not run the search. A loop that mutates the engine while the user is coding is not an inner-harness upgrade.
- **Pareto search, BM25 math routes, ACE/MCE memory banks, draft-verify classifiers.** Those are the paper's *discovered policies for classification and olympiad math*, not coding-agent mechanics. Copying them would stuff the wrong procedure into zone 1. Skills + `grep` are the coding form of retrieve-don't-stuff.
- **TerminalBench completion checklist as a kernel state machine.** KIRA's checklist is prompt text plus a "don't stop" rubric for that benchmark. A kernel state machine of done-criteria is a second verifier. Done-criteria belong in the opened project's `AGENTS.md` (runnable tests). The loop already stops when the model emits no tool calls.
- **Plugin / hook / MCP surface.** Each is a platform: MCP is another process and protocol; hooks are user scripts on the tool lifecycle; plugins are a loader. This kernel is one file. Kernel-owned policy later (permissions) is not a plugin API. Skills cover "how to do X" without a second runtime.

**Follow-up, not this change set:**

- Kernel-owned bash permissions / approval. A deny-list is bypassable (`python -c`, `bash -c`). A real gate needs UI and IPC. This change set documents that `bash` is a shell. Do not add theater.

## Current gaps

| Claimed | Actual |
|---|---|
| Frozen prefix for provider caches (P1) | `system` and `tools` sent as plain JSON, no `cache_control` |
| Skills at defined points (P1) | System prompt is identity + `AGENTS.md` + cwd only |
| Retrieval as policy | Only `read_file` / `write_file` / `bash` |
| Recoverable stubs (P4) | Repro command exists; stub text is duplicated in `reclaim()` and `resumeSession()`; no `tool_end` |
| Inspectable traces | Session JSONL + sidecar; `usage` lines occupy seq then the parser drops them |
| Project instructions are SELECT-able | `md.slice(0, 24_576)` silent-cuts the opened project's `AGENTS.md`. Overflow is unreadable |
| Long tasks can finish | `MAX_TURNS = 15`. The loop then logs `agent_settled` with no note. Context reclaim is the real budget; 15 model calls is not |

`read_file` / `write_file` resolve absolute paths with no cwd jail (`resolve(cwd, "/etc/passwd")` leaves the project). Fix that in the same change that adds more file tools.

## Validation questions answered against the code

| Question | Answer in the current code / first draft | Required correction |
|---|---|---|
| Does the jail contain a write when the final file is missing below an in-project symlink to an outside directory? | No. Prefix-checking the unresolved final path passes, then `mkdirSync` / `writeFileSync` follows the parent symlink. | Canonicalize the nearest existing ancestor before accepting a missing path. Test an outside symlink parent. |
| Does `/resume` rebuild the same message order after summarization? | No. `summarize()` stores the handoff after the surviving tail, while the live view unshifts it before that tail. Replay currently drops the evicted prefix but leaves the handoff at the end. | Replay `summarySseq` by removing that message from storage order and unshifting it after the evicted span is removed. |
| Can a reused `term-1` append a second `storageSeq: 1` stream to an old session file? | Yes. Terminal ids restart, but a normal first prompt does not resume or clear the old session file. | Keep the old file available for `/resume`; if the first action is a new prompt, truncate it before the first `store()`. |
| Is recursive discovery byte-stable and cycle-safe? | Not yet. `readdir` order is unspecified, and an in-root symlink loop can revisit one directory until a cap fires. | Sort every directory bytewise by UTF-8 and keep a real-directory visited set. Apply the same rule to grep, glob, and skill discovery. |
| Does checking `Date.now()` after a regex make a pathological match interruptible? | No. One synchronous catastrophic `RegExp.test()` can block before the deadline check. | Accept only the conservative regex subset defined below and yield between files. The timeout remains a second bound, not the primary ReDoS defense. |
| Will `read_file` stay bounded on a multi-gigabyte file? | Not if it uses `readFileSync` before slicing. | Open the file, inspect and read only the required bounded byte ranges, then close it in `finally`. |
| Is the bash output cap actually measured in bytes and recoverable? | No. `capTail()` compares bytes, then slices UTF-16 code units and emits no reproduction command. | Slice the UTF-8 buffer tail and put the safely quoted repro in the truncation marker. |
| Can environment probes execute a project-controlled binary? | Yes, if a relative or cwd-local `PATH` entry wins resolution. | Use `process.version` for Node. Resolve other probes only from absolute `PATH` entries outside cwd, with one total probe deadline. |
| Can trace cleanup delete a path selected through a hostile terminal id? | The first draft did not validate the env value before recursive removal. | Validate the terminal id before deriving sidecar, session, or trace paths. Invalid ids disable all three. |
| Are the cache markers covered by a regression test? | No. The first draft only tested history serialization. | Build the cached request prefix through one pure helper and test marker placement, immutability, and repeatability. |
| Do tool/system breakpoints cache the growing transcript? | No. An explicit breakpoint only writes at that point; messages after the system block remain uncached. | Also enable top-level automatic caching on main-loop requests so the breakpoint advances with append-only history. Keep explicit tool/system breakpoints as stable fallbacks. |
| Will the new harness tests run in the normal project gate? | No. A standalone script that is not in `npm test` is easy to miss. | Add `test:agent-core`, include it in `npm test`, and document the focused command. |
| Do the agent-core tool names and paths match the host's file-tool contract? | No. A `read_file` event with `path` is treated as a modification, while `write_file` is not one of the host's canonical `write` / `create_file` names. | Emit reads and searches without `path`; map only the sidecar start for `write_file` to canonical tool name `write`. Keep the provider tool name unchanged. |
| Will usage still consume sidecar sequence numbers that the parser drops? | Yes, unless the existing `logEvent({ t: "usage" })` calls are removed. | Return usage/waste data to the trace writer. The sidecar stays on its existing recognized contract. |

## Audit fixes (do not implement the original plan as written)

The first draft had holes that would ship as bugs:

1. **Resume would show a different stub than live reclaim.** `resumeSession()` inlines its own stub string. One `formatStub(...)` helper must serve both, or `/resume` loses `storageSeq` and the repro line.
2. **Trace dirs would mix launches.** Terminal ids restart at `term-1` and `TERMINA_EVENTS_DIR` persists. On engine start, delete then recreate `<terminalId>.traces/` for this id.
3. **`systemPrompt()` is process-global.** Tests cannot point it at a fixture. Export pure helpers that take `cwd` / skill dirs; do not call `systemPrompt()` from tests.
4. **Unbounded grep.** A JS `RegExp` plus a full-tree walk is ReDoS and event-loop stall in this process. Cap pattern length, reject empty pattern, skip binary, cap files visited, do not follow symlinks out of cwd.
5. **Do not mutate `TOOLS`.** Attach `cache_control` on a request copy of the last tool. Mutating the const leaks into tests and any later schema dump.
6. **Mid-XML byte cap would break the skill list.** Cap by whole skill entries, then one overflow note.
7. **macOS `/tmp` vs `/private/tmp`.** Canonicalize `cwd` once. Compare jailed paths against that canonical root.
8. **Tests cannot import the bundle today.** `main()` runs on import. Guard with a canonical direct-run check; `TERMINA_CORE_TEST=1` is an additional import-only signal, not permission to suppress a real direct entry. The test script imports `agent-core/main.ts` via Node strip-types, not `dist-electron/agent-core.mjs` (that build also compiles Rust).
9. **Silent `AGENTS.md` slice is data loss.** Same rule as the skill-index cap. If the opened project's file exceeds 24,576 characters, do not mid-file cut with no pointer. Use the last blank-line boundary at or below the cap; use a hard character cut only when no boundary exists. Compute `N` from the actual included prefix, not from the nominal cap. Always append `<!-- AGENTS.md truncated; N chars remain; read AGENTS.md with read_file -->`. Under the cap, no note. Apply the same prefix rule to the 8,192-character user-global file, whose note names its absolute path. The model then SELECTS the rest through `read_file`.
10. **User-global skill bodies sit outside cwd.** The index advertises `~/.agents/skills/.../SKILL.md`, but `read_file` is jailed to the project. `confinePath` takes a frozen allow set of canonical realpaths: the user-global `AGENTS.md` and every accepted scanned `SKILL.md`. The advertised path may retain its stable absolute spelling; confinement realpaths it before the allow-set lookup. Writes, grep, and glob never use that set.
11. **`MAX_TURNS` is per user prompt, not per process.** `runPrompt()` starts a new loop each time the user submits. History in the process continues; the sidecar logs a new `agent_start` / `agent_settled` pair. Default 80, `TERMINA_CORE_MAX_TURNS` (integer ≥ 1; anything else → 80). Print `(turn cap N reached this prompt)` only when the Nth response still requests tools and the loop would otherwise continue. Do not print it when that response completes normally or the user interrupts. Do not suggest `/resume` (`/resume` only works on a fresh engine with empty history). Still log `agent_settled` so the host closes the run.
12. **Do not put a search root on grep/glob sidecar `tool` events.** Host `case "tool"` treats `path` as a file: `recordModified`, timeline snapshot, baselines. `withinProject` rejects the project root (`relative` is `""`) so bash (no path) is dropped today. A grep `path` of `src` would mark the directory modified. Emit grep/glob like bash: `toolName` + `toolCallId`, **no path**. `tool_end` still fires; host ignores ends with no matching file-tool start.
13. **`capHead` is not bytes.** Today: `Buffer.byteLength` then `text.slice(0, maxBytes)` (JS UTF-16 units). `offset` must be bytes: read the bounded byte range `[offset, offset + READ_CAP_BYTES)` directly from the file as required by audit fix 31. Split UTF-8 sequences decode with replacement. Negative, NaN, infinite, or larger-than-`Number.MAX_SAFE_INTEGER` offsets return an error string, not a throw. A finite non-integer is floored. String `"4096"` from the model is accepted through `Number` then `Math.floor`.
14. **Freeze one canonical cwd at start.** `realpath(process.cwd())` when it exists, else `resolve(process.cwd())`. Jail, `AGENTS.md`, project skills, env listing, and nested-pointer walks all use that root. Mixing `process.cwd()` (`/tmp/...`) with `realpath` (`/private/tmp/...`) makes the jail miss.
15. **Env listing must be sorted.** `readdir` order is not stable. Sort bytewise by UTF-8, skip `.` / `..` and ignored segment names, take 20. Toolchain probes follow the trust and total-deadline rule in audit fix 33, fail silent, and never throw into `systemPrompt()`. Tests call `formatEnvironment(cwd, { probes: false })` so CI does not depend on `rustc`.
16. **User-global overflow is recoverable.** The allow set exists so `read_file` of the frozen absolute `~/.agents/AGENTS.md` path works. The overflow note names that absolute path. Do not tell the model to `read_file AGENTS.md` (that is the project file).
17. **Nested pointer does not fire on the nested file itself.** If the read path's basename is `AGENTS.md`, skip. If the path is not under the canonical cwd (allow-set skill file), skip. Directory read (`EISDIR`) is an error, no pointer. One nearest pointer only.
18. **Binary `read_file`.** If the first 4 KB contains a NUL, return `error: binary file`, not a UTF-8 garbage body.
19. **Grep ReDoS.** Pattern length 1–256 is not enough (`(a+)+` on a long line). Compile once and test `line.slice(0, 8192)` (the slice is a JS string cap, not bytes), but do not claim a post-match deadline can preempt backtracking. Audit fix 30 defines the conservative accepted subset, the event-loop yield, and the 2-second secondary bound. Do not add a worker.
20. **`reproFor` must cover grep/glob.** Otherwise stubs for those tools have no reproduce line. `grep '<pattern>'` / `glob '<pattern>'`, pattern sliced to 80 chars. Server `web_search` is not stubbed as a client `tool_result`.
21. **Writes jail before mkdir.** `confinePath` the final file path with `allow` ignored; only then `mkdirSync(dirname(abs), { recursive: true })`.
22. **Skill-root symlink escape.** Directory walk for skills: do not follow a directory or file symlink whose realpath is outside that scan root (`~/.agents/skills` or `<cwd>/.agents/skills`). Audit fix 29 adds cycle detection and deterministic order.
23. **Trace names sort numerically.** Delete oldest by the integer in `turn-<n>.json`, not lexicographic (`turn-10` before `turn-2` as strings).
24. **`main()` always runs today** (`main();` at the bottom). Tests import the source. Guard on the canonical direct-run comparison from audit fix 40. `TERMINA_CORE_TEST=1` confirms the import path in tests but never disables a real direct source or Electron-bundled entry.
25. **Missing final paths can escape through a parent symlink.** `resolve(root, "link/new.txt")` still starts with `root` when `link` points outside and `new.txt` does not exist. For a missing candidate, walk to the nearest existing ancestor, `realpath` that ancestor, reject a dangling link or an ancestor outside root, then append the still-missing suffix. This check happens before `mkdirSync`. Add the symlink-parent write test. A concurrent symlink swap remains outside this file-tool convenience jail; `bash` is explicitly unrestricted and the later approval track owns a process-grade boundary.
26. **Summarize replay order is wrong today.** Live `summarize()` puts the stored handoff before the surviving tail. Storage order puts the handoff after that tail. On a `summarize` revision, replay must find `summarySseq`, remove that message from its storage-order position, remove the `evicted` prefix, then unshift the handoff. Export one pure replay helper and prove that live and replayed message order match across prune, summarize, and truncate revisions.
27. **A fresh prompt must not append to an old terminal-id session stream.** Do not delete the session file at process start because `/resume` needs it. Before the first normal prompt in an empty process, truncate the old `<terminalId>.session.jsonl`, reset `storageSeq`, and then store the prompt. `/resume` instead replays it and advances `storageSeq` past its maximum. Test both branches and duplicate sequence prevention.
28. **Validate terminal ids before destructive trace reset.** Accept the host format only (`^[A-Za-z0-9_-]{1,128}$`). If it is invalid, disable sidecar, session, and trace paths. Create trace directories with mode `0700`; files stay `0600`. Never call recursive removal on a path derived from an unvalidated id.
29. **Every walk needs deterministic order, cycle detection, and its own cap.** Sort names bytewise by UTF-8 before visiting them. Track visited directory realpaths so in-root symlink cycles and aliases do not repeat work. Reject file symlinks whose target leaves the applicable root, not only directory symlinks. Skill discovery gets a per-root 2,000-entry visit cap and a distinct `skill scan capped` note because the exact number beyond that point is unknowable.
30. **The grep deadline must be enforceable.** A deadline checked after `RegExp.test()` cannot stop catastrophic backtracking. Compile once, but first reject backreferences, lookarounds, groups, and patterns with more than one quantifier token outside escapes and character classes. This intentionally conservative subset keeps matching bounded; the model can issue multiple simpler greps. Keep the 8,192-character line slice, 2-second wall budget, and 2,000-file cap. Make `grepFiles` async and yield with `setImmediate` at least every 25 files so Ctrl+C can run. Apply a periodic yield to glob traversal too.
31. **Bound `read_file` IO, not only its returned string.** Use `openSync` / `readSync` / `fstatSync` / `closeSync` (close in `finally`). Inspect at most the first 4 KB for NUL and read at most `READ_CAP_BYTES` from the requested byte offset. Do not allocate the whole file. Use file size to decide whether to append the next-offset marker.
32. **Freeze before the first prompt, not lazily on the first provider call.** `main()` canonicalizes cwd, resolves the global instruction path, scans skills, builds the allow set, and constructs the frozen system string before it prints the input prompt. Tests call the pure builders directly and do not initialize process state.
33. **Toolchain probes must not trust the opened project.** Use `process.version` for Node. For `python3`, `rustc`, and `go`, search only absolute `PATH` directories whose canonical paths are outside cwd; call the resolved absolute executable with `execFileSync`, no shell. Share one 500 ms total deadline across all external probes, cap each first output line, and fail silent.
34. **Cache construction needs one testable owner.** Add a pure `buildCachedPrefix(system, tools)` used by `callModel()`. It returns top-level `cache_control: { type: "ephemeral" }`, the cached system text block, and a tools array whose last entry is a shallow copy with `cache_control`; it never mutates `TOOLS`. Repeated calls with the same inputs are deep-equal. The explicit last-tool breakpoint preserves the reusable tools prefix across projects, the explicit system breakpoint preserves tools plus this process's frozen system, and top-level automatic caching advances a third breakpoint through append-only messages. This placement matches Anthropic's documented `tools → system → messages` hierarchy and stays below the four-breakpoint limit.
35. **The harness test belongs in the normal gate.** Add `test:agent-core` to `package.json`, run it from `npm test` after typecheck and before the existing build/spikes, and list the focused command in `README.md`. The focused script still imports TypeScript source and never builds Rust or Electron.
36. **Reproduction strings must survive quotes and control characters.** One helper shell-quotes the 80-character bash / grep / glob argument after replacing control characters with spaces. A command containing `'` must still produce an executable repro. `read_file` repro uses a JSON-quoted path. Test quote and newline cases.
37. **Agent-core tool names are not the sidecar file-tool vocabulary.** Keep provider tools named `read_file` and `write_file`. Build sidecar starts through one helper: `write_file` emits `{ t: "tool", toolName: "write", path, toolCallId }`; `read_file`, `bash`, `grep`, `glob`, and `web_search` emit their provider tool name and id with no `path`. This reuses the host's canonical write classification and prevents reads from entering the Modified list. Every provider tool still emits `tool_end` with the original call id.
38. **Glob matching also needs a bounded algorithm.** Cap glob patterns at 1–256 characters. Implement `matchGlob` without a backtracking regular expression (an iterative dynamic-programming matcher is sufficient and bounded by pattern × path length). Reject the unsupported bracket / brace forms before matching. Test repeated `**` / `*` patterns and root-level matching.
39. **Project instruction and skill roots must not escape through their own symlink.** The project `AGENTS.md`, nested `AGENTS.md` pointers, and `<cwd>/.agents/skills` root are project-scoped resources. Canonicalize them and omit them if their realpath leaves canonical cwd. The user-global file and root are separately trusted user scope and use their canonical allow-set entries.
40. **The test guard must not disable a real direct launch.** Compute the direct-run decision by comparing canonical `fileURLToPath(import.meta.url)` with canonical `process.argv[1]`. `TERMINA_CORE_TEST=1` suppresses initialization only on import. A directly executed source or bundled `agent-core.mjs` still starts, even if that variable leaked from a parent shell.
41. **Malformed session addresses must fail closed.** Replay accepts only positive integer `storageSeq` values and rejects duplicates instead of silently replacing the `bySeq` entry. Ignore a truncated final JSONL line, but surface structural conflicts as `(resume failed: ...)`, leave history empty, and allow the next normal prompt to reset the stream.
42. **Usage has one owner after traces land.** Remove both main and summary `logEvent({ t: "usage" })` calls. `reportUsage` returns the usage, cost, and waste fields to the trace writer. Trace every attempted provider call with `role: "main" | "summary"`; hash the exact system string used by that call. This eliminates dropped sidecar kinds and keeps the sidecar parser unchanged.
43. **Frozen-only breakpoints do not cache conversation history.** Main-loop calls also set top-level automatic `cache_control: { type: "ephemeral" }`. Anthropic then moves the breakpoint to the last cacheable message block and looks back to the prior turn's write. Do not put explicit markers into stored transcript blocks. Do not enable automatic caching on summary calls: each summary request is a separately rebuilt prompt, not an append-only conversation, so a moving tail there would pay writes without useful reuse.
44. **`capTail` repeats the byte-cap bug and drops the escape hatch.** Convert combined bash output to a UTF-8 `Buffer` and take only its final `BASH_CAP_BYTES`; decoding a split sequence may use replacement. When truncated, prepend `[early output truncated to N bytes — reproduce: <safe repro>]`. Keep `execFile`'s `maxBuffer` bounded. Test multi-byte output and a quoted command; the returned bytes plus marker may exceed the payload cap only by the bounded marker length.

## Design choices

**Zone 1 order, built once per process:**

1. Identity
2. Environment, frozen at start, no later deltas: canonical `cwd`, `platform`, a directory listing sorted bytewise by UTF-8 (≤20 names, ignored segments skipped), and a small toolchain snapshot (best-effort `node` / `python3` / `rustc` / `go` versions under audit fix 33). Encode the cwd and names as JSON strings so control characters in filesystem names cannot create prompt fields. This is the TerminalBench inner-harness finding: skip the 2–4 exploratory turns. Do not run `init.sh`. Do not send branch/dirty updates mid-session. `systemPrompt()` stays synchronous and must not throw.
3. User-global instructions from `~/.agents/AGENTS.md` (8,192-char cap + overflow note when needed)
4. Skill index (capped XML + overflow note)
5. `<project-instructions>` from cwd `AGENTS.md` (24,576-char cap + overflow note when needed)

Same inputs must produce byte-identical frozen zones. Missing files at a scope are omitted, not errors.

**Skills are an index, not stuffed bodies.** Scan at process start. Freeze name + description + absolute path. The model loads `SKILL.md` with `read_file` (cwd jail, or the frozen allow set). Bodies therefore sit in the transcript tail, not zone 1. That is progressive disclosure, not a violation of P1: zone 1 stays the index.

Scan order, later name wins:

1. `~/.agents/skills`
2. `<cwd>/.agents/skills` only — not parents

Discovery: any `SKILL.md` under those trees. Skip `disable-model-invocation: true`. Skip unreadable dirs, binary frontmatter, and `node_modules`. No YAML library: read only a bounded frontmatter prefix and parse `name` / `description` from the first `---` block (single-line values). Missing `name` → parent directory name. Escape XML special characters and remove XML-invalid controls from name, description, and advertised path. Apply audit fix 29 to directory and file symlinks. Within each root, sorted path order determines duplicate precedence; the project root is still processed last. Sort the final overridden entries by name then path before formatting. Cap 32 skills or 8 KiB (measured with `Buffer.byteLength`) of finished whole-entry XML, whichever first; if output truncates, append `<!-- N skills omitted -->`. If traversal itself hits its cap, append the separate unknown-count scan-cap note.

**Cache breakpoints cover the frozen zones and the append-only tail.** At main-loop request build time through `buildCachedPrefix`:

- top-level automatic caching: `cache_control: { type: "ephemeral" }`
- `system: [{ type: "text", text: systemPrompt(), cache_control: { type: "ephemeral" } }]`
- last tool on a shallow copy: `{ ...TOOLS[n], cache_control: { type: "ephemeral" } }`

Do not mark stored transcript blocks. Automatic caching moves the request breakpoint without mutating history. Do not add an extra beta header unless the API 400s without it. The current Messages API documents top-level automatic caching, including its moving multi-turn breakpoint, plus `cache_control` on tool definitions and system blocks ([tool caching](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching), [prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)). The summary call uses no cache marker; its rebuilt prompt is separate from the main loop.

**`grep` and `glob` join `TOOLS` in the same change as cache.** Tool schemas are zone 2. They are the SELECT path the overflow notes tell the model to use.

**Stubs stay in-kernel.** `formatStub({ chars, tool, sseq, repro })` → `[cleared: N chars of <tool> — storageSeq S — reproduce: <repro>]`. Session JSONL keeps originals. No timeline seq. No snapshot store.

**Traces are files, not IPC.** Lecture 11 runtime observability only: what the kernel did, not why a change should be accepted. After terminal-id validation, use `join(eventsDir, terminalId + ".traces")`. On direct engine start: remove that exact directory, then recreate it with mode `0700`. One monotonically numbered `turn-<n>.json` per attempted provider call (file mode `0600`), written after that call's tool outcomes settle or from its error path: `role` (`main` or `summary`), model, status, storageSeq range, tool names, input/cache/output usage when present, time to first token, total call time, revision count, waste cause, and the first 16 hex characters (8 bytes) of SHA-256 over the exact system UTF-8 bytes for that call. No file paths, tool arguments, file bodies, credentials, commands, or grep hits. Cap 64 recognized `turn-<integer>.json` files; ignore unrelated entries and delete the lowest numeric turns. Trace failure never crashes the loop. Missing `TERMINA_EVENTS_DIR` or an invalid terminal id means no traces (same as sidecar/session). Remove the old unrecognized `usage` sidecar writes; do not add `usage` to `SIDECAR_KINDS`. Do not add sprint contracts, rubrics, or OpenTelemetry.

**Verification stays in the project's `AGENTS.md`.** The kernel does not gate on tests. Termina already owns Verify & Iterate and evidence on candidates.

## Path confinement

Export `confinePath(cwd, input, opts?: { mustExist?: boolean; allow?: ReadonlySet<string> })`.

- Canonical root = the process-frozen cwd (audit 14), not a fresh `process.cwd()` per call
- Candidate = `resolve(root, input ?? ".")`. Absolute `input` on POSIX replaces the root (`resolve("/proj", "/etc/passwd")` is `/etc/passwd`) — jail must still reject it
- If the candidate exists: `realpath` it; reject on failure (dangling symlink, ELOOP)
- If not (writes): walk upward to the nearest existing ancestor, `realpath` it, reject on failure or escape, then append the missing suffix. Do not accept the unresolved string by prefix alone
- Allow when `abs === root || abs.startsWith(root + sep)`, **or** (reads only) `allow` contains `abs`
- `write_file` ignores `allow`. Writes stay inside cwd. Jail **before** `mkdirSync`
- `grep` / `glob` directory walks: skip ignored names (copy the watcher's `IGNORED_SEGMENTS` locally, including `.pi` as noise; do not import `electron/watcher.ts`); apply the sorted, visited-realpath, symlink, and visit-cap rules in audit fix 29; skip files with a NUL in the first 4 KB. Do not parse `.gitignore` in this change set
- Ignore list applies to **walks only**, not to `read_file` of an explicit path under cwd (`.agents` is an ignored walk name)

`write_file` jails the final file path, then `mkdirSync(dirname(abs), { recursive: true })`.

## Tools

`read_file`: `{ path, offset? }`

- `offset` is a **byte** offset (audit 13). Default 0
- Truncation marker names the next byte offset: `[truncated at B bytes — read_file offset N]`; emit it only when the file has more bytes
- Binary NUL in the first 4 KB → error string
- After a successful read of a **file under cwd** (not the nested `AGENTS.md` itself, not an allow-set path outside cwd): walk from that file's directory up to cwd, not above. If an `AGENTS.md` exists strictly below cwd, prepend `[package instructions: <rel>/AGENTS.md — read_file that path]`. Do not inline the body. One nearest pointer.

`grep`: `{ pattern, path?, glob? }`

- `pattern` length 1–256; validate the conservative subset from audit fix 30, then compile once as `RegExp`; invalid or unsafe → error string, not throw
- Default path = canonical cwd; `path` is jailed; a file path greps that file only
- Optional `glob` filters relative paths with `matchGlob`
- Line-by-line on `line.slice(0, 8192)`; format each hit as `<relative-path>:<1-based-line>:<text>`; sort traversal bytewise; cap at 50 whole hits and 20 KiB without cutting a hit; cap 2,000 files visited; enforce the 2 s wall budget and periodic event-loop yield from audit fix 30
- No matches is success with empty/`(no matches)` content, not `isError`

`glob`: `{ pattern }`

- Pattern length 1–256. Support `*` / `**` / `?` only. Reject `[`, `]`, `{`, `}` and use the bounded non-backtracking matcher from audit fix 38
- Relative paths, cap 200, same visit cap, ignore set, and no out-of-root dir symlinks
- Return regular files only in bytewise-sorted relative-path order. `*` never crosses `/`; `**` can cross it and `**/*.ts` also matches a root-level `.ts` file

`bash` stays unjailed beyond `cwd` on `execFile` (it is a shell). Do not pretend otherwise.

`web_search`: provider-executed. Anthropic runs `{ type: "web_search_20250305", name: "web_search", max_uses: 5 }` with the same `ANTHROPIC_API_KEY` as the model. No Brave key, no HTML scrape, no second search vendor.

- The kernel does not fetch search results. It advertises the server tool, streams `server_tool_use` / `web_search_tool_result`, and sends those blocks back unchanged on the next request (including `encrypted_content` and text `citations`)
- Stream slots use the provider `index`. A skipped or unknown block must not shift later deltas. Compact holes only after the stream ends
- Client tools keep the tools cache breakpoint. Do not put `cache_control` on the server tool
- Mixed with client tools: execute only `tool_use` blocks; leave an unfinished `server_tool_use` for the next provider call
- `pause_turn`: store the assistant message and call again with no user `tool_result`. Skip reclaim/summarize/truncate on that next call so the paused message stays byte-identical
- Sidecar start has **no path**, same as grep. `tool_end` fires when a `web_search_tool_result` arrives

**Sidecar:** after each tool, `logEvent({ t: "tool_end", toolCallId, isError })`. Main matches by `toolCallId`. Only `write_file` emits a file-tool start, mapped to `{ toolName: "write", path }`. `read_file` / `bash` / `grep` / `glob` / `web_search` emit starts **without** `path` and therefore do not enter the host's Modified list or file timeline. All six emit `tool_end` (`web_search` when the provider result block arrives). Usage goes to traces only (audit 42).

## Tests

`scripts/agent-core-harness-test.mjs` sets `TERMINA_CORE_TEST=1` and imports `../agent-core/main.ts` (Node 22 strip-types). No Electron, no API key, no `scripts/build.mjs`.

Export the canonical helpers that the fixture script exercises. Filesystem helpers take explicit roots and never read the process-frozen globals:

- `confinePath`
- bounded `readFileResult`
- `matchGlob`
- `validateGrepPattern`
- `grepFiles` / `globFiles` / `WEB_SEARCH_TOOL` / `requestTools`
- `scanSkills` / `formatSkillIndex`
- `formatProjectInstructions` (project cap + overflow note)
- `formatUserInstructions` (global cap + overflow note)
- `formatEnvironment` (`probes` option)
- `formatStub`
- `parseMaxTurns`
- `reproFor`
- `buildCachedPrefix`
- `replaySessionRecords`
- `prepareSessionStream`
- `sidecarStartFor`
- `isDirectRun`
- trace path / record / retention helpers used by production logging
- existing `toRequest`, `planPruneStubs`

Cases:

- jail: `/etc/passwd`, `../` outside cwd, `foo/../../etc/passwd` fail; a relative in-cwd file succeeds; absolute `/etc/passwd` fails
- jail allow set: a frozen skill path outside cwd is readable; a sibling file next to it is not; `write_file` to the allow path fails
- `read_file` offset: second call with offset returns the next **byte** slice; offset past EOF is empty success; `offset: "nope"`, infinity, and an unsafe integer error
- `read_file` of a file with a NUL in the first 4 KB errors
- environment snapshot with `probes: false`: listing sorted, capped at 20, ignored names absent, control characters JSON-encoded; two calls equal. A project-local fake toolchain binary is never executed; a missing trusted probe omits that line
- grep: matches, skips `node_modules`, caps hits, empty pattern errors, invalid or unsafe regex errors; its sidecar start has no `path`
- glob: `**/*.ts` matches nested and root files, ignores `node_modules`, repeated wildcards terminate, overlong and `{a,b}` patterns error; its sidecar start has no `path`
- web_search: request tools include Anthropic `web_search_20250305` after the cached client tools and without `cache_control`; `toRequest` keeps `server_tool_use`, `web_search_tool_result` (including encrypted content), and text citations; stream compact skips holes; sidecar start has no `path`
- skills: fixture `SKILL.md` under `.agents/skills` with frontmatter formats; missing dirs silent; XML-special name escaped; a later project skill overrides a user-global skill with the same name
- project `AGENTS.md` under cap: full text, no overflow note
- project `AGENTS.md` over cap: overflow note with remaining char count; does not claim the omitted tail is present; note tells the model to `read_file` `AGENTS.md`
- missing project `AGENTS.md`: no project block, no throw
- user-global under cap: included before the skill index
- user-global over cap: overflow note names the **absolute** path; `read_file` of that path succeeds only via the allow set
- missing user-global: omitted, no throw
- ancestor `../AGENTS.md` is not loaded
- a project or nested `AGENTS.md` symlink outside cwd is not loaded or advertised; a project skill-root symlink outside cwd is not scanned
- nested pointer: `read_file` of `pkg/src/a.ts` with `pkg/AGENTS.md` prepends the pointer; `read_file` of `pkg/AGENTS.md` does not; root `AGENTS.md` does not; a file at cwd gets none
- `parseMaxTurns`: missing → 80; `"2"` → 2; `"0"` / `"-1"` / `"2.5"` / `"nope"` → 80
- `formatStub` includes storageSeq and repro; `toRequest` still strips `stubbed` / `repro` / `chars`; `reproFor` on grep includes the pattern
- `planPruneStubs` no-ops under the high-water mark
- missing-path jail: a symlinked parent that points outside cwd rejects `link/new.txt`; a symlinked parent that stays inside cwd succeeds; a dangling parent symlink rejects
- walks: bytewise UTF-8 order is stable for Unicode names; an in-root directory symlink cycle terminates without duplicates; a skill file symlink outside its scan root is omitted
- grep safety: `(a+)+`, `(a|aa)+`, backreferences, lookarounds, and a second quantifier token reject before matching; traversal yields and the deadline returns a timeout note
- request prefix: automatic caching is top-level, explicit markers land on the system block and copied last tool, `TOOLS` stays unchanged, no transcript block gains metadata, and two builds are deep-equal
- session replay: summarize restores `handoff + surviving tail`; prune stubs use the shared text; truncate preserves the same boundary; a new prompt resets an old stream while `/resume` preserves it and advances `storageSeq`
- sidecar mapping: `write_file` emits canonical `toolName: "write"` with its path; `read_file` emits no path; no `usage` sidecar event is produced
- terminal id / traces: an invalid id creates or removes nothing; trace retention sorts `turn-2` before `turn-10` numerically; main and summary traces contain no tool arguments or paths
- repro quoting: bash / grep / glob inputs containing a quote or newline remain one safe, bounded reproduction argument
- bash cap: multi-byte output keeps only the configured UTF-8 tail and its marker carries the same safe repro string
- direct-run guard: an import does not start `main()`; a direct source entry and the bundled entry do, including when `TERMINA_CORE_TEST=1` is present
- malformed session: duplicate or non-positive `storageSeq` fails resume without a partial history; a truncated final line is ignored

Focused gate: `npm run test:agent-core`. Typecheck: `npm run typecheck`. Normal gate: `npm test` includes both before the existing build and spikes. Manual (not a gate): Agent (core) second turn shows cache-read tokens when a key is present.

## Files

| File | Change |
|---|---|
| `agent-core/main.ts` | jail, grep/glob, skill index, user-global + project AGENTS.md overflow notes, nested pointer, env snapshot, request-time cache_control, canonical sidecar tool mapping + tool_end, shared formatStub, exact session replay, usage traces reset-on-start, main() guard, per-prompt turn cap, exports. Rewrite the file header: this is Termina's agent-core engine, not a stand-in for another terminal. |
| `docs/AGENT-CORE.md` | status; skill index is zone 1; bodies load via `read_file`; user-global `~/.agents/AGENTS.md` then cwd `AGENTS.md`; skills from `~/.agents/skills` then `<cwd>/.agents/skills`; no ancestor walk; no snapshot-store claim |
| `scripts/agent-core-harness-test.mjs` | new |
| `package.json` | add `test:agent-core`; include it in `npm test` |
| `README.md` | list the focused agent-core harness gate and update the `npm test` description |

## Order of work

One change set, this order inside the file so the frozen request shape exists before cache markers:

1. Canonical cwd + validated terminal id; `confinePath` (including missing-path ancestor canonicalization) + canonical allow set + apply to read/write; bounded `read_file` `offset`
1b. Frozen environment snapshot (listing + toolchain probes) into `systemPrompt()`
2. `grep` / `glob` + deterministic cycle-safe walks + bounded matchers + ignore set + visit caps + canonical sidecar tool starts / `tool_end`
3. `scanSkills` / `formatSkillIndex` + `formatUserInstructions` + `formatProjectInstructions` into `systemPrompt()` (identity, env, user-global, skill index, capped project AGENTS.md)
4. Eagerly freeze the prompt and canonical read allow set at direct engine start
5. `buildCachedPrefix`: top-level automatic `cache_control` + explicit system / last-tool copies
6. `formatStub` in `reclaim` and replay; correct summarize replay order; prepare either resume or a fresh session stream before the first prompt
7. remove usage sidecar writes; validated main/summary traces dir reset-on-start + import-safe direct-run guard + `MAX_TURNS` default 80 / env override / cap message
8. test script + package gate + docs

Stop. No outer search loop, no second snapshot client, no extra roles, no course template files, no rewrite of Termina's `AGENTS.md`.
