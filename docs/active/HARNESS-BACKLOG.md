# Harness backlog — high-signal, not yet built

> **Status:** active — all listed items are unimplemented unless marked otherwise.
>
> Captured 2026-05-11 from the TUI/harness audit. Add only when measured or when a concrete need appears. Each item is one focused PR.

## 1. Left pane is a stack of 4 panels — vertical crowding — implemented

The terminal is followed by an activity tab bar (Timeline | Plan |
Worldlines | Modified); one panel shows at a time with count badges.
New plan/worldline/modified content auto-switches on the empty →
non-empty edge (timeline dots never yank); re-renders for terminal or
project switches sync badges without switching. Active tab persists in
`localStorage`. Owner: `src/activity-tabs.ts` (pure reducer + thin DOM
glue).

## 2. No command palette / quick-open — implemented

`Cmd+P` opens Quick Open (fuzzy file search over the active project);
`Cmd+K` opens the Command Palette (all registered commands, `Enter` to
run). New `file:search` IPC backed by `electron/quick-open.ts` (bounded
walk, same ignore rules as the explorer, per-query matching so payloads
stay small). Menu entries under View; shortcuts user-remappable like the
rest.

## 3. Worldline compare is buried

Candidate cards and `A`/`B` badges are powerful, but discoverability is low.

Needs: a one-line summary in the header when a comparison is active.

Touches: `electron/worldlines.ts` wiring.

## 4. Terminal theme sync on hot reload — implemented

`src/pty-view.ts` coalesces fits through `scheduleFit()` (one rAF) and
explicitly `document.fonts.load()`s the active family at the current
size before fitting — constructor, `setFontSize`, and `setFontFamily`.
`document.fonts.ready` stays as a backstop only: it doesn't cover a
family chosen after startup, which was the reload race.
