/** An explicit Markdown heading that introduces a Plan Board task list. */
export const PLAN_HEADING_MARKER = String.raw`(?:#{1,6}[ \t]+)?plan(?:[ \t]*:[ \t]*.*)?`;

/** A bullet or numbered task marker. A checkbox is optional. */
export const PLAN_TASK_MARKER = String.raw`(?:[-*+]|\d+[.)])[ \t]+(?:\[([ xX])\][ \t]*)?`;
