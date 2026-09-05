# Harness backlog — high-signal, not yet built

> **Status:** active — all listed items are unimplemented unless marked otherwise.
>
> Captured 2026-05-11 from the TUI/harness audit. Add only when measured or when a concrete need appears. Each item is one focused PR.

## 1. Left pane is a stack of 4 panels — vertical crowding

The pty sits above Timeline, Plan, Worldlines, and Modified. On a small laptop the terminal gets squeezed. This is the #1 harness pain.

Lazy fix: tabs (`Activity | Plan | Worldlines`) or a collapsible accordion with persisted height.

Touches: `src/main.ts` layout + `localStorage` + tests. Do as one focused PR.

## 2. No command palette / quick-open

`Cmd+P` for files and `Cmd+K` for actions would cut explorer hunting.

Needs: fuzzy matcher + new IPC `file:search`. Existing `SessionSearch` is for history, not workspace.

## 3. Worldline compare is buried

Candidate cards and `A`/`B` badges are powerful, but discoverability is low.

Needs: a one-line summary in the header when a comparison is active.

Touches: `electron/worldlines.ts` wiring.

## 4. Terminal theme sync on hot reload

`pty-view.ts` already does `setTheme`/`setFontFamily`, but font load races on first paint.

Needs: `document.fonts.ready` debounce (already partially there).
