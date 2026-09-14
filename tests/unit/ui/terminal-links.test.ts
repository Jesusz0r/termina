import { describe, it, expect } from "vitest";
import type { ILink, Terminal } from "@xterm/xterm";
import { cellColumnsForLine, createTerminalLinkProvider, parseTerminalFileLinks } from "../../../src/terminal-links.ts";

/** Minimal fake buffer line: cells with chars/width plus the string view. */
function makeFakeLine(
  text: string,
  opts: { wide?: (cp: string) => boolean; combining?: (cp: string) => boolean } = {},
): { length: number; isWrapped: boolean; getCell(x: number): { getChars(): string; getWidth(): number } | undefined; translateToString(trimRight?: boolean): string } {
  const cells: Array<{ chars: string; width: number }> = [];
  for (const cp of text) {
    const last = [...cells].reverse().find((c) => c.width > 0);
    if (opts.combining?.(cp) && last) {
      last.chars += cp;
      continue;
    }
    if (opts.wide?.(cp)) cells.push({ chars: cp, width: 2 }, { chars: "", width: 0 });
    else cells.push({ chars: cp, width: 1 });
  }
  return {
    length: cells.length,
    isWrapped: false,
    getCell: (x: number) => {
      const c = cells[x];
      return c ? { getChars: () => c.chars, getWidth: () => c.width } : undefined;
    },
    translateToString: (trimRight?: boolean) => (trimRight ? text.replace(/\s+$/, "") : text),
  };
}

function provideForLine(line: ReturnType<typeof makeFakeLine>): ILink[] | undefined {
  const term = { buffer: { active: { getLine: (y: number) => (y === 0 ? line : undefined) } }, element: undefined };
  const provider = createTerminalLinkProvider(term as unknown as Terminal, () => {});
  let result: ILink[] | undefined;
  provider.provideLinks(1, (links) => {
    result = links;
  });
  return result;
}

describe("Terminal file link detection", () => {
  it("detects relative paths with line and column numbers", () => {
    const text = "Check out src/main.ts:42:10 for the fix.";
    const links = parseTerminalFileLinks(text);
    expect(links).toHaveLength(1);
    expect(links[0].text).toBe("src/main.ts:42:10");
    expect(links[0].path).toBe("src/main.ts");
    expect(links[0].line).toBe(42);
    expect(links[0].column).toBe(10);
    expect(links[0].startIndex).toBe(10);
    expect(links[0].endIndex).toBe(27);
  });

  it("detects relative paths with line numbers only", () => {
    const text = "In electron/main.ts:7480: we updated start().";
    const links = parseTerminalFileLinks(text);
    expect(links).toHaveLength(1);
    expect(links[0].text).toBe("electron/main.ts:7480");
    expect(links[0].path).toBe("electron/main.ts");
    expect(links[0].line).toBe(7480);
    expect(links[0].column).toBeUndefined();
  });

  it("detects file:// URIs with #L hash fragments", () => {
    const text = "See file:///Users/user/project/shared/types.ts#L123-L145.";
    const links = parseTerminalFileLinks(text);
    expect(links).toHaveLength(1);
    expect(links[0].text).toBe("file:///Users/user/project/shared/types.ts#L123-L145");
    expect(links[0].path).toBe("/Users/user/project/shared/types.ts");
    expect(links[0].line).toBe(123);
  });

  it("detects compiler/test error paren line/column format", () => {
    const text = "Error at src/components/editor.tsx(15,8): type mismatch";
    const links = parseTerminalFileLinks(text);
    expect(links).toHaveLength(1);
    expect(links[0].text).toBe("src/components/editor.tsx(15,8)");
    expect(links[0].path).toBe("src/components/editor.tsx");
    expect(links[0].line).toBe(15);
    expect(links[0].column).toBe(8);
  });

  it("handles paths inside double quotes, single quotes, and backticks", () => {
    const text = 'Look at "src/editor.ts", \'src/pty-view.ts\', and `src/main.ts`.';
    const links = parseTerminalFileLinks(text);
    expect(links).toHaveLength(3);
    expect(links[0].path).toBe("src/editor.ts");
    expect(links[1].path).toBe("src/pty-view.ts");
    expect(links[2].path).toBe("src/main.ts");
  });

  it("strips git diff prefixes a/ and b/", () => {
    const text = "--- a/scripts/dev.ts\n+++ b/scripts/dev.ts";
    const links = parseTerminalFileLinks(text);
    expect(links).toHaveLength(2);
    expect(links[0].path).toBe("scripts/dev.ts");
    expect(links[1].path).toBe("scripts/dev.ts");
  });

  it("strips both sides of a diff --git header", () => {
    const links = parseTerminalFileLinks("diff --git a/src/main.ts b/src/main.ts");
    expect(links.map((l) => l.path)).toEqual(["src/main.ts", "src/main.ts"]);
  });

  it("preserves literal a/ and b/ directories in ordinary references (refs #143)", () => {
    const a = parseTerminalFileLinks("Open a/module.ts:10");
    expect(a).toHaveLength(1);
    expect(a[0].path).toBe("a/module.ts");
    expect(a[0].line).toBe(10);
    const b = parseTerminalFileLinks("Open b/module.ts:20");
    expect(b).toHaveLength(1);
    expect(b[0].path).toBe("b/module.ts");
    expect(b[0].line).toBe(20);
  });

  it("preserves literal a/ prefixes in quoted and Markdown file targets", () => {
    const quoted = parseTerminalFileLinks('See "a/module.ts:7" for details.');
    expect(quoted).toHaveLength(1);
    expect(quoted[0].path).toBe("a/module.ts");
    const md = parseTerminalFileLinks("See [impl](a/module.ts:3) for details.");
    expect(md).toHaveLength(1);
    expect(md[0].path).toBe("a/module.ts");
    expect(md[0].line).toBe(3);
  });

  it("never treats Markdown or quoted web URLs as local files (refs #143)", () => {
    expect(parseTerminalFileLinks("[docs](https://example.com/readme.md)")).toHaveLength(0);
    expect(parseTerminalFileLinks('"https://example.com/code.ts"')).toHaveLength(0);
    expect(parseTerminalFileLinks("'http://localhost:5173/test.js'")).toHaveLength(0);
    expect(parseTerminalFileLinks("[docs](ftp://example.com/readme.md)")).toHaveLength(0);
  });

  it("still links a file next to a web URL on the same line", () => {
    const links = parseTerminalFileLinks("See https://example.com/readme.md and src/main.ts:42.");
    expect(links).toHaveLength(1);
    expect(links[0].path).toBe("src/main.ts");
  });

  it("detects known files without extensions or dotfiles", () => {
    const text = "Files: Dockerfile, Makefile, .gitignore, and package.json.";
    const links = parseTerminalFileLinks(text);
    expect(links.map((l) => l.path)).toEqual([
      "Dockerfile",
      "Makefile",
      ".gitignore",
      "package.json",
    ]);
  });

  it("ignores web URLs (http/https)", () => {
    const text = "Visit https://example.com/foo.ts or http://localhost:5173/test.js for info.";
    const links = parseTerminalFileLinks(text);
    expect(links).toHaveLength(0);
  });

  it("ignores plain words and numbers that are not files", () => {
    const text = "This is version 1.2.3 running in 5.4 seconds.";
    const links = parseTerminalFileLinks(text);
    expect(links).toHaveLength(0);
  });

  it("strips trailing punctuation like commas, periods, and colons", () => {
    const text = "Modified src/editor.ts, electron/main.ts; and tests/unit/foo.test.ts!";
    const links = parseTerminalFileLinks(text);
    expect(links.map((l) => l.path)).toEqual([
      "src/editor.ts",
      "electron/main.ts",
      "tests/unit/foo.test.ts",
    ]);
  });

  it("detects markdown links with descriptive text pointing to files", () => {
    const text = "See [Editor Implementation](src/editor.ts:42:10) for details.";
    const links = parseTerminalFileLinks(text);
    expect(links).toHaveLength(1);
    expect(links[0].text).toBe("[Editor Implementation](src/editor.ts:42:10)");
    expect(links[0].path).toBe("src/editor.ts");
    expect(links[0].line).toBe(42);
    expect(links[0].column).toBe(10);
  });

  it("decodes URL-encoded characters in file:// URIs", () => {
    const text = "File is file:///Users/user/My%20Project/src/main.ts#L25.";
    const links = parseTerminalFileLinks(text);
    expect(links).toHaveLength(1);
    expect(links[0].path).toBe("/Users/user/My Project/src/main.ts");
    expect(links[0].line).toBe(25);
  });

  it("supports paths with spaces when enclosed in quotes", () => {
    const text = 'Opening "src/my components/Custom Button.tsx:50"...';
    const links = parseTerminalFileLinks(text);
    expect(links).toHaveLength(1);
    expect(links[0].path).toBe("src/my components/Custom Button.tsx");
    expect(links[0].line).toBe(50);
  });

  it("handles lines containing emojis and Nerd Font symbols", () => {
    const text = "⚡ [success] 🚀 src/main.ts:42 compiled";
    const links = parseTerminalFileLinks(text);
    expect(links).toHaveLength(1);
    expect(links[0].path).toBe("src/main.ts");
    expect(links[0].line).toBe(42);
  });
});

describe("Terminal link provider ranges (refs #144)", () => {
  it("maps string offsets to cells after a wide CJK character", () => {
    // "界" occupies cells 0-1, the space is cell 2, so `s` sits at cell 3 (x=4).
    const line = makeFakeLine("界 src/main.ts", { wide: (cp) => cp === "界" });
    const links = provideForLine(line);
    expect(links).toHaveLength(1);
    expect(links![0].range.start).toEqual({ x: 4, y: 1 });
    expect(links![0].range.end).toEqual({ x: 4 + "src/main.ts".length - 1, y: 1 });
  });

  it("maps string offsets to cells after a wide emoji", () => {
    const line = makeFakeLine("⚡ src/main.ts:42", { wide: (cp) => cp === "⚡" });
    const links = provideForLine(line);
    expect(links).toHaveLength(1);
    expect(links![0].range.start).toEqual({ x: 4, y: 1 });
  });

  it("maps string offsets to cells after a combining character", () => {
    // "é" is two UTF-16 units (e + U+0301) in one cell: `s` is string offset 3 but cell 2.
    const line = makeFakeLine("e\u0301 src/main.ts", { combining: (cp) => cp === "\u0301" });
    const links = provideForLine(line);
    expect(links).toHaveLength(1);
    expect(links![0].range.start).toEqual({ x: 3, y: 1 });
  });

  it("keeps ASCII ranges at offset + 1", () => {
    const line = makeFakeLine("See src/main.ts:42.");
    const links = provideForLine(line);
    expect(links).toHaveLength(1);
    expect(links![0].range.start).toEqual({ x: 5, y: 1 });
    expect(links![0].range.end).toEqual({ x: 5 + "src/main.ts:42".length - 1, y: 1 });
  });

  it("yields no links for blank lines or lines without references", () => {
    expect(provideForLine(makeFakeLine("   "))).toBeUndefined();
    expect(provideForLine(makeFakeLine("just words here"))).toBeUndefined();
  });

  it("maps every string unit of wide, combining, and plain cells", () => {
    const line = makeFakeLine("界e\u0301x", { wide: (cp) => cp === "界", combining: (cp) => cp === "\u0301" });
    // Cells: [界:0][placeholder:1][é:2][x:3]; string units: 界, e, ́, x.
    expect(cellColumnsForLine(line as never, 4)).toEqual([0, 2, 2, 3]);
  });
});
