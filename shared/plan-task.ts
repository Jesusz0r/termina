/** An explicit Markdown heading that introduces a Plan Board task list. */
export const PLAN_HEADING_MARKER = String.raw`(?:#{1,6}[ \t]+)?plan[ \t]*:?[ \t]*`;

/** A bullet or numbered task marker. A checkbox is optional. */
export const PLAN_TASK_MARKER = String.raw`(?:[-*+]|\d+[.)])[ \t]+(?:\[([ xX])\][ \t]*)?`;

/** A checkbox task item specifically (e.g. - [ ] task). */
export const CHECKBOX_TASK_MARKER = String.raw`(?:[-*+]|\d+[.)])[ \t]+\[([ xX])\][ \t]*`;

/** An explicit Plan heading followed by task items, or a checkbox task item. */
export const HAS_PLAN_TASK = new RegExp(
  String.raw`^[ \t]*` +
    PLAN_HEADING_MARKER +
    String.raw`\r?\n(?:[ \t]*\r?\n)*[ \t]*` +
    PLAN_TASK_MARKER +
    String.raw`\S` +
    String.raw`|^[ \t]*` +
    CHECKBOX_TASK_MARKER +
    String.raw`\S`,
  "im",
);
