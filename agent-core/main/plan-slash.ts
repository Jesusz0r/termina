/**
 * `/plan` slash rewrite: the engine submits a planning user message so the
 * model never sees the raw `/plan` token. Not zone-1 identity.
 * A `/plan` turn logs assistant text on the sidecar; `electron/plan-board.ts`
 * is the only plan detector.
 */

const PLAN_BOARD_INSTRUCTION = [
  "Write a Plan Board list. Do not implement.",
  "Use a heading `Plan:` or `## Plan`, then file-scoped task lines (`- [ ] …` with the files each task will touch) so Dispatch can send them to workers.",
  "Optional `@model provider/id` on a task picks that worker's model; omit it to inherit this session's model.",
  "If there is no work to plan, ask what to plan.",
].join(" ");

/** Sidecar `plan` payload cap. Not a plan detector. */
export const PLAN_SIDECAR_TEXT_CAP = 4000;

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
  const plan = text.slice(0, PLAN_SIDECAR_TEXT_CAP);
  if (plan === lastEmitted) return null;
  return plan;
}
