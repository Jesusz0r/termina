import { describe, it, expect } from "vitest";
import { parseTerminalFileLinks } from "../../../src/terminal-links.ts";

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
