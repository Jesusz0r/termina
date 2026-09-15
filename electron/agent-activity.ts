/**
 * Semantic agent activity: idle / working / blocked from the sidecar tail.
 *
 * One owner. Main folds live signals into AgentActivityInput and calls
 * activityFor(); the renderer only displays the view. Never infer from PTY
 * output bytes. Producer `blocked` events are out of scope.
 */
import { STALL_FAILURE_TURNS } from "../agent-core/stall.ts";
import type { AgentActivityReason, AgentActivityState, AgentActivityView } from "../shared/types.ts";

/** Consecutive same-target `tool_end.isError` before `blocked: tool-error-loop`. */
export const TOOL_ERROR_LOOP_STREAK = STALL_FAILURE_TURNS;

type ActivityBoundary = "none" | "agent_start" | "agent_settled";

export type ActivitySignal =
  | { t: "preflight_request"; seq: number; at: number }
  | { t: "preflight_cancel"; seq: number; at: number }
  | { t: "preflight_timeout"; seq: number; at: number }
  | { t: "prompt"; seq: number; at: number }
  | { t: "agent_start"; seq: number; at: number }
  | { t: "agent_settled"; seq: number; at: number; error: string | null }
  | { t: "tool"; seq: number; at: number; target: string }
  | { t: "tool_end"; seq: number; at: number; target: string; isError: boolean }
  | { t: "sidecar_hold"; seq: number; at: number; held: boolean }
  | { t: "pty_exit"; seq: number; at: number };

export interface AgentActivityInput {
  lastBoundary: ActivityBoundary;
  lastBoundarySeq: number;
  lastBoundaryAt: number;
  lastSettledError: string | null;
  openToolIds: string[];
  errorStreak: number;
  errorStreakTarget: string | null;
  promptInFlight: boolean;
  preflightInFlight: boolean;
  preflightTimedOut: boolean;
  sidecarHeld: boolean;
  ptyExitedMidRun: boolean;
  lastSeq: number;
  lastAt: number;
}

interface AgentActivity {
  state: AgentActivityState;
  reason: AgentActivityReason | null;
  sinceSeq: number;
  updatedAt: number;
}

export function emptyActivityInput(): AgentActivityInput {
  return {
    lastBoundary: "none",
    lastBoundarySeq: 0,
    lastBoundaryAt: 0,
    lastSettledError: null,
    openToolIds: [],
    errorStreak: 0,
    errorStreakTarget: null,
    promptInFlight: false,
    preflightInFlight: false,
    preflightTimedOut: false,
    sidecarHeld: false,
    ptyExitedMidRun: false,
    lastSeq: 0,
    lastAt: 0,
  };
}

export function activityView(activity: AgentActivity): AgentActivityView {
  return { state: activity.state, reason: activity.reason };
}

export function activityKey(view: AgentActivityView): string {
  return `${view.state}:${view.reason ?? ""}`;
}

/** True when settle-time stall-tracker stop is on `agent_settled.error`. */
function isStalledSettleError(error: string | null | undefined): boolean {
  return typeof error === "string" && /\bstalled\b/i.test(error);
}

/** Stable tool identity for open-set and error-streak keys. Empty means ignore. */
export function activityToolTarget(toolCallId?: string | null, path?: string | null): string {
  const id = (toolCallId ?? "").trim();
  if (id) return id;
  return (path ?? "").trim();
}

function countableToolTarget(target: string): boolean {
  return target.length > 0 && target !== "_";
}

function resetRun(
  next: AgentActivityInput,
  boundary: ActivityBoundary,
  settledError: string | null,
): void {
  next.lastBoundary = boundary;
  next.lastBoundarySeq = next.lastSeq;
  next.lastBoundaryAt = next.lastAt;
  next.lastSettledError = settledError;
  next.openToolIds = [];
  next.errorStreak = 0;
  next.errorStreakTarget = null;
  next.promptInFlight = false;
  next.preflightInFlight = false;
  next.preflightTimedOut = false;
  next.ptyExitedMidRun = false;
}

export function applyActivityEvent(input: AgentActivityInput, event: ActivitySignal): AgentActivityInput {
  const next: AgentActivityInput = {
    ...input,
    openToolIds: [...input.openToolIds],
    lastSeq: event.seq,
    lastAt: event.at,
  };
  switch (event.t) {
    case "preflight_request":
      next.preflightInFlight = true;
      next.preflightTimedOut = false;
      break;
    case "preflight_cancel":
      next.preflightInFlight = false;
      next.preflightTimedOut = false;
      break;
    case "preflight_timeout":
      if (next.preflightInFlight) next.preflightTimedOut = true;
      next.preflightInFlight = false;
      break;
    case "prompt":
      next.promptInFlight = true;
      break;
    case "agent_start":
      resetRun(next, "agent_start", null);
      break;
    case "agent_settled":
      resetRun(next, "agent_settled", event.error);
      break;
    case "tool":
      if (countableToolTarget(event.target) && !next.openToolIds.includes(event.target)) {
        next.openToolIds.push(event.target);
      }
      break;
    case "tool_end": {
      if (countableToolTarget(event.target)) {
        next.openToolIds = next.openToolIds.filter((id) => id !== event.target);
        if (event.isError) {
          if (next.errorStreakTarget === event.target) next.errorStreak += 1;
          else {
            next.errorStreakTarget = event.target;
            next.errorStreak = 1;
          }
        } else {
          next.errorStreak = 0;
          next.errorStreakTarget = null;
        }
      }
      break;
    }
    case "sidecar_hold":
      next.sidecarHeld = event.held;
      break;
    case "pty_exit":
      if (next.lastBoundary === "agent_start" || next.preflightInFlight || next.preflightTimedOut) {
        next.ptyExitedMidRun = true;
      }
      next.preflightInFlight = false;
      next.promptInFlight = false;
      next.openToolIds = [];
      break;
  }
  return next;
}

export function activityFor(input: AgentActivityInput): AgentActivity {
  const since = (seq: number, at: number): Pick<AgentActivity, "sinceSeq" | "updatedAt"> => ({
    sinceSeq: seq,
    updatedAt: at,
  });
  if (input.sidecarHeld) {
    return { state: "blocked", reason: "sidecar-paused", ...since(input.lastSeq, input.lastAt) };
  }
  if (input.ptyExitedMidRun) {
    return { state: "blocked", reason: "exited-mid-run", ...since(input.lastSeq, input.lastAt) };
  }
  if (input.preflightTimedOut) {
    return { state: "blocked", reason: "lease-wait", ...since(input.lastSeq, input.lastAt) };
  }
  if (input.lastBoundary === "agent_settled" && isStalledSettleError(input.lastSettledError)) {
    return { state: "blocked", reason: "stalled", ...since(input.lastBoundarySeq, input.lastBoundaryAt) };
  }
  if (
    input.lastBoundary === "agent_start"
    && input.errorStreak >= TOOL_ERROR_LOOP_STREAK
    && input.errorStreakTarget
  ) {
    return { state: "blocked", reason: "tool-error-loop", ...since(input.lastSeq, input.lastAt) };
  }
  if (
    input.lastBoundary === "agent_start"
    || input.openToolIds.length > 0
    || input.promptInFlight
    || input.preflightInFlight
  ) {
    return { state: "working", reason: null, ...since(input.lastSeq || input.lastBoundarySeq, input.lastAt || input.lastBoundaryAt) };
  }
  return { state: "idle", reason: null, ...since(input.lastBoundarySeq, input.lastBoundaryAt) };
}
