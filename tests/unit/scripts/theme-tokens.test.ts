import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { emitThemeTokens, parseThemeTokens } from "../../../scripts/theme-tokens.ts";
import { contrastRatio } from "../../fixtures/contrast.ts";

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
    // Atom sets no --on-accent; it must see the :root value. Light overrides
    // it (refs #221) so its dark-blue accent keeps white text.
    expect(resolved.get("atom")!.get("on-accent")).toBe(resolved.get("dark")!.get("on-accent"));
    expect(resolved.get("light")!.get("on-accent")).toBe("#ffffff");
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

  it.each(["dark", "light", "high-contrast", "atom"])("keeps workspace text readable on normal and hovered surfaces in %s", (id) => {
    const resolved = parseThemeTokens(readFileSync(join(ROOT, "src", "styles.css"), "utf8"));
    const vars = resolved.get(id)!;
    for (const foreground of ["text", "text-dim", "yellow", "accent"]) {
      for (const background of ["bg", "bg-panel", "bg-raised", "bg-hover"]) {
        expect(contrastRatio(vars.get(foreground)!, vars.get(background)!), `${id}: ${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps on-accent text on accent backgrounds at WCAG AA in every theme (refs #221)", () => {
    const css = readFileSync(join(ROOT, "src", "styles.css"), "utf8");
    const resolved = parseThemeTokens(css);
    for (const [id, vars] of resolved) {
      const ratio = contrastRatio(vars.get("on-accent")!, vars.get("accent")!);
      expect(ratio, `${id}: on-accent ${vars.get("on-accent")} on accent ${vars.get("accent")}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
