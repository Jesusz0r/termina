# AGENTS.md — pi-editor

This file defines the rules for agents that work in this repository.

## Project

pi-editor is a hybrid coding tool. The left side runs the real pi interactive
TUI in a pty. The right side is a Monaco IDE with a file explorer. The two
sides stay synchronized. The project is a desktop app built with Electron,
Vite, TypeScript, and node-pty.

## Hard rules

### No backwards compatibility

- Do not keep old behavior for compatibility.
- Do not write migration layers.
- Do not maintain deprecated paths.
- A full greenfield replacement is always acceptable.
- Remove dead code immediately. Do not leave it behind.
- When a feature changes, update every place that depends on it.
- The current behavior is the only behavior that matters.

### Comments in Simplified Technical English

Write every comment in Simplified Technical English (STE, ASD-STE100).

STE rules for comments:

- Use short sentences. Write one idea per sentence.
- Use the active voice. Do not use the passive voice.
- Use the imperative form for instructions.
- Use approved technical words. Do not invent synonyms.
- Use the same word for the same thing in every comment.
- Do not use abbreviations. Write "does not", not "doesn't".
- Do not use slang, idioms, or figurative language.
- Put the main idea at the start of the sentence.
- Do not describe the code. State what the code does and why.
- Do not write obvious comments. Write the reason, not the action.

Examples:

- Correct: "Send the result to the renderer only when the run is active."
- Correct: "Use the canonical path as the cache key. This makes every lookup hit."
- Wrong: "So this basically sends stuff over to the renderer when things are running."
- Wrong: "pretty fast path for the common case lol"

### Performance over everything

- Performance is the first priority. It comes before convenience.
- Keep the main process responsive. Never block it with slow work.
- Keep IPC messages small. Do not send file content when metadata is enough.
- Fetch heavy data on demand. Do not push it before the user needs it.
- Cap unbounded state. Use budgets for caches, timelines, and buffers.
- Avoid O(n^2) work in hot paths. Use maps and indexes.
- Use incremental DOM updates. Do not re-render whole lists per event.
- Measure before you optimize. Do not guess.
- A new feature must not regress the hot paths.
- When in doubt, make the fast path the only path.

## Architecture notes

- `electron/main.ts` owns the terminals, the watcher, and all state.
- The renderer never owns source-of-truth state. It renders what main pushes.
- The bridge extension lives in the project `.pi/extensions` folder.
- Sidecar files are the event channel between the agent and the app.
- The terminal stays the source of truth. The app never replaces the TUI.

## Verification

- Run `npm run dev` to start the app in development mode.
- Typecheck with `npx tsc --noEmit`.
- Build with `node scripts/build.mjs`.
- Run the e2e suites in `scripts/` against an Electron instance on port 9222.
- A change must keep the existing test suites green.
