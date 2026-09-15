import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { text } from "../../../agent-core/trace/normalize.ts";
import { paintRow } from "../../../agent-core/tui/layout.ts";
import { parseMarkdown, type TranscriptEntry } from "../../../agent-core/tui/transcript.ts";

function read(rel: string): string {
  return readFileSync(new URL(`../../../${rel}`, import.meta.url), "utf8");
}

function plainEntry(): TranscriptEntry {
  return { kind: "plain" } as TranscriptEntry;
}

describe("TUI/trace P3 nits (#354)", () => {
  it("F9: StyleId and paintRow stop at markdown styles 0–6", () => {
    const sample = [
      "plain",
      "*italic*",
      "**bold**",
      "`code`",
      "# Heading",
      "> quote",
      "```ts",
      "const x = 1",
      "```",
    ].join("\n");
    const styles = new Set(parseMarkdown(sample, { n: 0 }).map((span) => span.style));
    expect([...styles].every((style) => style >= 0 && style <= 6)).toBe(true);
    expect(styles.has(0)).toBe(true);
    expect(styles.has(6)).toBe(true);

    const transcript = read("agent-core/tui/transcript.ts");
    expect(transcript).toContain("export type StyleId = 0 | 1 | 2 | 3 | 4 | 5 | 6;");
    expect(transcript).not.toContain("| 7");

    const layout = read("agent-core/tui/layout.ts");
    expect(layout).toContain("frag.style === 6");
    expect(layout).not.toContain("frag.style === 7");

    const painted = paintRow([{ text: "ts", style: 6 }], 4, plainEntry(), 2);
    expect(painted).toContain("\x1b[2;90m");
    expect(paintRow([{ text: "ok", style: 0 }], 4, plainEntry(), 2)).not.toContain("\x1b[2;90m");
  });

  it("F10: text() collapses empty optional strings with || null", () => {
    expect(text("", "name")).toBeNull();
    expect(text("ok", "name")).toBe("ok");
    expect(text("  ", "name")).toBe("  ");

    const src = read("agent-core/trace/normalize.ts");
    expect(src).toContain("return normalized || null;");
    expect(src).not.toContain("required ? null : null");
  });

  it("F11: records header does not claim atomic-write helpers", () => {
    const records = read("agent-core/trace/records.ts");
    expect(records.slice(0, records.indexOf("*/"))).not.toMatch(/atomic-write/);
    expect(read("agent-core/trace/runtime.ts")).toMatch(/async function atomicWrite\(/);
  });
});
