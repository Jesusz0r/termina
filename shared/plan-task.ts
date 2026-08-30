/**
 * A bullet or numbered list marker that means "this assistant text is a plan".
 * A checkbox is optional. electron/plan-board.ts remains the only parser of
 * task lines.
 */
export const PLAN_TASK_MARKER = String.raw`(?:[-*+]|\d+[.)])\s+(?:\[([ xX])\]\s*)?`;

/** At least one bullet, numbered, or checkbox list item. */
export const HAS_PLAN_TASK = new RegExp(String.raw`^\s*` + PLAN_TASK_MARKER + String.raw`\S`, "m");
