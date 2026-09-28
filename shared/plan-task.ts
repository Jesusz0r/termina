/** An explicit Markdown heading that introduces a Plan Board task list. */
export const PLAN_HEADING_MARKER = String.raw`(?:#{1,6}[ \t]+)?plan(?:[ \t]*:[ \t]*.*)?`;

/** A bullet or numbered task marker. A checkbox is optional. */
export const PLAN_TASK_MARKER = String.raw`(?:[-*+]|\d+[.)])[ \t]+(?:\[([ xX])\][ \t]*)?`;

const PLAN_HEADING_LINE = new RegExp("^" + PLAN_HEADING_MARKER + "$", "i");
const PLAN_TASK_LINE = new RegExp("^" + PLAN_TASK_MARKER + String.raw`(.+)$`);

export function planHeadingIndex(lines: readonly string[]): number {
  return lines.findIndex((raw) => PLAN_HEADING_LINE.test(raw.trim()));
}

export function parsePlanTaskBody(line: string): { body: string; checked: boolean } | null {
  const match = line.trim().match(PLAN_TASK_LINE);
  const body = match?.[2]?.trim();
  if (!body) return null;
  return { body, checked: match?.[1]?.toLowerCase() === "x" };
}

/**
 * Task lines after a plan heading, using the Plan Board stop rules: skip
 * prose until the first task, then stop at a blank or non-task line.
 * Not path, model, or dispatch parsing — `electron/plan-board.ts` owns that.
 */
export function planListEntries(text: string, max = 20): Array<{ body: string; checked: boolean }> {
  const lines = text.split("\n");
  const heading = planHeadingIndex(lines);
  if (heading < 0) return [];
  const tasks: Array<{ body: string; checked: boolean }> = [];
  let started = false;
  for (const raw of lines.slice(heading + 1)) {
    if (!raw.trim()) {
      if (started) break;
      continue;
    }
    const line = parsePlanTaskBody(raw);
    if (!line) {
      if (started) break;
      continue;
    }
    started = true;
    tasks.push(line);
    if (tasks.length >= max) break;
  }
  return tasks;
}

/** True when the text contains a headed task list the Plan Board would accept. */
export function planListPresent(text: string): boolean {
  return planListEntries(text, 1).length > 0;
}
