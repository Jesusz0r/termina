/**
 * The unchecked-checkbox marker that means "this assistant text is a plan".
 * electron/plan-board.ts remains the only parser of task lines.
 */
export const PLAN_TASK_MARKER = String.raw`(?:[-*+]|\d+[.)])\s+\[ \]`;

/** At least one unchecked checkbox list item. */
export const HAS_UNCHECKED_PLAN_TASK = new RegExp(String.raw`^\s*` + PLAN_TASK_MARKER, "m");
