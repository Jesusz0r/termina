/**
 * Sidecar protocol: JSONL events the engine writes and the app tails.
 *
 * Two writers emit this protocol: agent-core primary and candidate hosts. This
 * module is the only parser and the only tailer of sidecar JSONL.
 */

// Split into ./sidecar/ modules (issue #38). This entry re-exports the public surface.
export { MAX_SIDECAR_BYTES } from "./sidecar/events.js";
export type { AgentStartEvent, SidecarEvent } from "./sidecar/events.js";
export { SidecarEventQueue } from "./sidecar/queue.js";
export type { SidecarEventDelivery } from "./sidecar/queue.js";
export { parseSidecarRecord, sidecarEventFromRecord } from "./sidecar/parse.js";
export { SidecarTailer } from "./sidecar/tailer.js";
