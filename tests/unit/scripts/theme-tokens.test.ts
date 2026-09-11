import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { emitThemeTokens, parseThemeTokens } from "../../../scripts/theme-tokens.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("theme tokens", () => {
  it("resolves all four themes with the full token set", () => {
    const css = readFileSync(join(ROOT, "src", "styles.css"), "utf8");
    const resolved = parseThemeTokens(css);
    expect([...resolved.keys()].sort()).toEqual(["atom", "dark", "high-contrast", "light"]);
    const names = [...resolved.get("dark")!.keys()];
    expect(names.length).toBeGreaterThan(10);
    for (const vars of resolved.values()) {
      expect([...vars.keys()]).toEqual(names);
    }
  });

  it("cascades :root defaults into themes that do not override them", () => {
    const css = readFileSync(join(ROOT, "src", "styles.css"), "utf8");
    const resolved = parseThemeTokens(css);
    // Neither light nor atom sets --on-accent; both must see the :root value.
    expect(resolved.get("light")!.get("on-accent")).toBe(resolved.get("dark")!.get("on-accent"));
    expect(resolved.get("atom")!.get("on-accent")).toBe(resolved.get("dark")!.get("on-accent"));
  });

  it("rejects a token with no :root default", () => {
    const css = `:root {\n  --bg: #0b0d09;\n}\nhtml[data-theme="light"] {\n  --bg: #f6f8fa;\n  --nope: #ffffff;\n}\n`;
    expect(() => parseThemeTokens(css)).toThrow("no :root default");
  });

  it("keeps the checked-in module fresh", () => {
    const css = readFileSync(join(ROOT, "src", "styles.css"), "utf8");
    const expected = emitThemeTokens(parseThemeTokens(css));
    const actual = readFileSync(join(ROOT, "src", "theme-tokens.gen.ts"), "utf8");
    expect(actual).toBe(expected);
  });
});
