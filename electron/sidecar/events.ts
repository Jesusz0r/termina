/**
 * Sidecar event protocol: bounds, markers, and event shapes.
 *
 * Owns size bounds, marker file tokens, and the SidecarEvent union.
 * Split from electron/sidecar.ts (issue #38).
 */


export const MAX_SIDECAR_BYTES = 8 * 1024 * 1024;

/** A complete JSONL record may span bounded tail reads, but never grows
 *  without a decision. Records above this cap are explicitly skipped. */
export const MAX_SIDECAR_RECORD_BYTES = MAX_SIDECAR_BYTES;

export const SIDECAR_TAIL_READ_BYTES = 1024 * 1024;

/** Producer-side flow-control marker; writers wait while it exists. */
export const SIDECAR_BACKPRESSURE_FILE_PREFIX = ".backpressure-";

/** Terminal-local fail-closed admission marker for unrecoverable source races. */
export const SIDECAR_QUARANTINE_FILE_PREFIX = ".quarantine-";

/** Canonical writer-owned sealed generation suffix. */
export const SIDECAR_SEALED_FILE_SUFFIX = ".sealed";

/** Marker published by a canonical writer after it has closed the old
 * pathname and created the next active inode.  A sealed generation without
 * this marker is unproven and must retain an inode anchor. */
export const SIDECAR_SEALED_PROOF_SUFFIX = ".owner";

/** A retained inode whose producer provenance is unknown. */
export const SIDECAR_RETAINED_FILE_TOKEN = ".retained-";

export const SIDECAR_DRAIN_FILE_TOKEN = ".draining-";

export const SIDECAR_FINAL_GUARD_FILE_TOKEN = ".final-";

export const SIDECAR_CURSOR_VERSION = 1;

/** Owner metadata is protocol-generated and intentionally tiny. */
export const SIDECAR_PROOF_MAX_BYTES = 64 * 1024;

/** Verification never allocates beyond one bounded sidecar generation. */
export const SIDECAR_VERIFY_READ_CHUNK_BYTES = 64 * 1024;

/** A hostile short-read/append loop must not monopolize the async tail. */
export const SIDECAR_VERIFY_MAX_READS = 4096;

/** A missing sequence is never guessed closed. After this bounded
 * retry budget the terminal is quarantined instead of allowing a later
 * source to overtake it forever. */
export const SIDECAR_MAX_SEQUENCE_GAP_POLLS = 80;


export type ToolEdits = Array<{ oldText?: string; newText?: string }>;


export interface SidecarMeta {
  bridgeId: string;
  /** Process owning this terminal; bridge reloads keep the same PID. */
  producerPid?: number;
  seq: number;
  /** Immutable producer generation, present on canonical records. */
  generation?: string;
}


export type SidecarEvent =
  | (SidecarMeta & { t: "preflight_request"; requestId?: string; hasImages?: boolean; deadlineAt?: number })
  | (SidecarMeta & { t: "preflight_cancel"; requestId?: string })
  | (SidecarMeta & { t: "prompt"; file?: string; hasPreflight?: boolean })
  | (SidecarMeta & { t: "steer_input"; behavior?: string })
  | (SidecarMeta & { t: "checkpoint_request"; requestId?: string; kind?: string; entryId?: string | null })
  | (SidecarMeta & { t: "checkpoint_result"; requestId?: string; ok?: boolean; error?: string | null })
  | (SidecarMeta & { t: "session_ready"; opId?: string; ok?: boolean; error?: string | null })
  | (SidecarMeta & {
      t: "agent_start";
      preflightRequestId?: string | null;
      preflightToken?: string | null;
      sessionFile?: string | null;
      sessionId?: string | null;
      entryId?: string | null;
      parentEntryId?: string | null;
      model?: string | null;
      thinkingLevel?: string | null;
    })
  | (SidecarMeta & { t: "agent_settled"; error?: string | null })
  | (SidecarMeta & { t: "agent_settings"; model?: string | null; thinkingLevel?: string | null; usage?: string | null })
  | (SidecarMeta & { t: "plan"; text?: string })
  | (SidecarMeta & {
      t: "tool";
      toolName?: string;
      path?: string;
      edits?: ToolEdits;
      /** Producer retained a bounded preview instead of dropping the tool boundary. */
      editsTruncated?: boolean;
      editsBytes?: number;
      editsCount?: number;
      editsSha256?: string;
      toolCallId?: string;
      entryId?: string | null;
    })
  | (SidecarMeta & { t: "tool_end"; toolCallId?: string; isError?: boolean })
  | (SidecarMeta & { t: "subagent_spawn"; runId?: string; taskFile?: string; userRequested?: boolean });


export type AgentStartEvent = Extract<SidecarEvent, { t: "agent_start" }>;
