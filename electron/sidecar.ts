/**
 * Sidecar protocol: JSONL events the engine writes and the app tails.
 *
 * Two writers emit this protocol: agent-core primary and candidate hosts. This
 * module is the only parser and the only tailer of sidecar JSONL.
 */

// Split into ./sidecar/ modules (issue #38). This entry re-exports the public surface.
export { MAX_SIDECAR_BYTES, SIDECAR_SEALED_PROOF_SUFFIX } from "./sidecar/events.js";
export type { AgentStartEvent, SidecarEvent, ToolEdits } from "./sidecar/events.js";
export { SidecarEventQueue } from "./sidecar/queue.js";
export type { SidecarEventClass, SidecarEventDelivery, SidecarEventQueueOptions, SidecarEventQueueStats } from "./sidecar/queue.js";
export { parseSidecarRecord, sidecarEventFromRecord } from "./sidecar/parse.js";
export { SidecarTailer } from "./sidecar/tailer.js";
export type { SidecarTailerOptions } from "./sidecar/tailer.js";
