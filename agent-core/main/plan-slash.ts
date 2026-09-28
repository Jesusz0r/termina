/**
 * `/plan` slash rewrite: the engine submits a planning user message so the
 * model never sees the raw `/plan` token. Not zone-1 identity.
 * A `/plan` turn logs assistant text on the sidecar. Task objects stay in
 * `electron/plan-board.ts`; this module only caps that payload.
 */

import { planHeadingIndex } from "../../shared/plan-task.ts";

const PLAN_BOARD_INSTRUCTION = [
  "Write a Plan Board list. Do not implement.",
  "Use a heading `Plan:` or `## Plan`, then file-scoped task lines (`- [ ] …` with the files each task will touch) so Dispatch can send them to workers.",
  "Optional `@model provider/id` on a task picks that worker's model; omit it to inherit this session's model.",
  "If there is no work to plan, ask what to plan.",
].join(" ");

/**
 * Sidecar `plan` payload cap. A full board is 20 file-scoped tasks; 4000
 * cut a real list in half before the heading's tasks were done.
 */
export const PLAN_SIDECAR_TEXT_CAP = 24_000;

/** Rewrite `/plan` / `/plan <request>` into the user message to submit. */
export function planSlashSubmit(line: string): string | null {
  const match = /^\/plan(?:\s+(.*))?$/.exec(line);
  if (!match) return null;
  const request = (match[1] ?? "").trim();
  if (!request) return PLAN_BOARD_INSTRUCTION;
  return `${PLAN_BOARD_INSTRUCTION}\n\nRequest:\n${request}`;
}

/** Sidecar payload for a `/plan` turn: the assistant reply, capped. Skip empty or unchanged. */
export function planSidecarText(text: string, lastEmitted: string): string | null {
  if (!text.trim()) return null;
  const plan = cappedPlanText(text);
  if (plan === lastEmitted) return null;
  return plan;
}

/** Keep the headed list when a preamble would push it past the cap. */
function cappedPlanText(text: string): string {
  if (text.length <= PLAN_SIDECAR_TEXT_CAP) return text;
  const lines = text.split("\n");
  const heading = planHeadingIndex(lines);
  const focused = heading > 0 ? lines.slice(heading).join("\n") : text;
  return focused.length <= PLAN_SIDECAR_TEXT_CAP ? focused : focused.slice(0, PLAN_SIDECAR_TEXT_CAP);
}
