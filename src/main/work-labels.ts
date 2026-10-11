import type { WorkAttentionReason, WorkSummaryAction } from "../../shared/types";

export const ATTENTION_LABELS: Record<WorkAttentionReason, string> = {
  blocked: "Agent blocked", "verify-failed": "Verify failed", "verify-timeout": "Verify timed out",
  "verify-stale": "Verify is outdated", "verify-cancelled": "Verify was cancelled",
  "task-incomplete": "Task attempt incomplete", "task-failed": "Task attempt failed",
  "task-interrupted": "Task attempt interrupted", "worker-unavailable": "Assigned worker unavailable",
  "pending-review": "Result pending review",
};
export const ACTION_LABELS: Record<WorkSummaryAction["kind"], string> = {
  terminal: "Open terminal", plan: "Open plan", evidence: "Check details",
};
