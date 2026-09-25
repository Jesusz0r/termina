import { describe, expect, it } from "vitest";
import { paintRow } from "../../../agent-core/tui/layout.ts";
import { parseMarkdown, type TranscriptEntry } from "../../../agent-core/tui/transcript.ts";
import { terminalOscFileTarget, terminalWebUrl } from "../../../shared/terminal-link.ts";

describe("agent markdown links", () => {
  it("paints a web citation as the label plus an OSC 8 hyperlink", () => {
    const spans = parseMarkdown("See [source](https://example.com/docs).", { n: 0 });
    expect(spans.map((span) => span.text).join("")).toBe("See source.");
    const link = spans.find((span) => span.link);
    expect(link?.text).toBe("source");
    expect(link?.link).toBe("https://example.com/docs");
    const painted = paintRow(spans, 40, { kind: "plain" } as TranscriptEntry, 12);
    expect(painted).toContain("\x1b]8;;https://example.com/docs\x07");
    expect(painted).toContain("source");
    expect(painted).not.toContain("[source]");
  });

  it("paints a file citation as a file target the editor can open", () => {
    const spans = parseMarkdown("See [editor](src/editor.ts:42:10).", { n: 0 });
    const link = spans.find((span) => span.link);
    expect(link?.text).toBe("editor");
    expect(terminalOscFileTarget(link?.link ?? "")).toBe("src/editor.ts:42:10");
    expect(terminalWebUrl("javascript:alert(1)")).toBeNull();
    expect(parseMarkdown("Version [v](1.2.3) and [note](foo.bar).", { n: 0 }).some((span) => span.link)).toBe(false);
    const wiki = parseMarkdown("See [wiki](https://en.wikipedia.org/wiki/Foo_(bar)).", { n: 0 }).find((span) => span.link);
    expect(wiki?.text).toBe("wiki");
    expect(wiki?.link).toBe("https://en.wikipedia.org/wiki/Foo_(bar)");
  });
});
