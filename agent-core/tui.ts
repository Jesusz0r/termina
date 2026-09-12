/**
 * Full-screen TUI for agent-core. The kernel writes transcript text; this
 * module owns layout, input, the slash menu, and the tty restore.
 */

// Split into ./tui/ modules (issue #38). This entry re-exports the public surface.
export { layoutHeights, visibleLines } from "./tui/layout.ts";
export type { ToolTranscriptState, TranscriptHandle, TuiIO, TuiInput } from "./tui/transcript.ts";
export { AgentTui } from "./tui/app.ts";
