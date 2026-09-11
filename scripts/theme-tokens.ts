/**
 * Emit the styles.css theme tokens as a TS module (option (a) from #28).
 *
 * styles.css stays the one place a theme value is written; the terminal and
 * Monaco palettes import the generated values instead of repeating the hex.
 * Only plain 6-digit hex custom properties are tokens — color-mix badges,
 * font stacks and sizes stay stylesheet-only.
 *
 * Regenerated on every build (scripts/build.ts); tests/unit/scripts/
 * theme-tokens.test.ts fails when the checked-in file goes stale.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CSS_PATH = join(ROOT, "src", "styles.css");
const OUT_PATH = join(ROOT, "src", "theme-tokens.gen.ts");

const BLOCK_START = /^(?::root|html\[data-theme="([^"]+)"\])\s*\{$/;
const VAR_LINE = /^--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;.*$/;

function camelCase(name: string): string {
  return name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

/** Theme id -> token name -> hex, with :root cascaded into each theme. */
export function parseThemeTokens(css: string): Map<string, Map<string, string>> {
  const blocks = new Map<string, Map<string, string>>();
  let current: Map<string, string> | null = null;
  for (const rawLine of css.split("\n")) {
    const line = rawLine.trim();
    const start = BLOCK_START.exec(line);
    if (start) {
      // :root carries the dark palette; the capture is undefined there.
      const id = start[1] ?? "dark";
      current = new Map<string, string>();
      blocks.set(id, current);
      continue;
    }
    if (line === "}") {
      current = null;
      continue;
    }
    if (!current) continue;
    const variable = VAR_LINE.exec(line);
    if (variable?.[1] && variable[2]) current.set(variable[1], variable[2]);
  }
  const root = blocks.get("dark");
  if (!root) throw new Error("theme tokens: no :root block found");
  const names = [...root.keys()];
  // Every theme resolves the full :root set (CSS cascade); a var defined in
  // an override block but missing from :root cannot resolve for the others.
  for (const [id, vars] of blocks) {
    for (const name of vars.keys()) {
      if (!root.has(name)) throw new Error(`theme tokens: --${name} in ${id} has no :root default`);
    }
  }
  const resolved = new Map<string, Map<string, string>>();
  for (const [id, vars] of blocks) {
    const full = new Map<string, string>();
    for (const name of names) full.set(name, vars.get(name) ?? root.get(name)!);
    resolved.set(id, full);
  }
  return resolved;
}

export function emitThemeTokens(resolved: Map<string, Map<string, string>>): string {
  const ids = ["dark", "light", "high-contrast", "atom"];
  for (const id of ids) {
    if (!resolved.has(id)) throw new Error(`theme tokens: missing theme block for ${id}`);
  }
  const names = [...resolved.get("dark")!.keys()];
  const fields = names.map((name) => `  ${camelCase(name)}: string;`).join("\n");
  const themes = ids
    .map((id) => {
      const entries = names.map((name) => `    ${camelCase(name)}: "${resolved.get(id)!.get(name)}",`).join("\n");
      return `  "${id}": {\n${entries}\n  },`;
    })
    .join("\n");
  return `// GENERATED from src/styles.css by scripts/theme-tokens.ts — do not edit.
import type { ThemeId } from "../shared/types";

export interface ThemeTokens {
${fields}
}

export const THEME_TOKENS: Record<ThemeId, ThemeTokens> = {
${themes}
};
`;
}

export function generateThemeTokens(): string {
  const resolved = parseThemeTokens(readFileSync(CSS_PATH, "utf8"));
  const output = emitThemeTokens(resolved);
  writeFileSync(OUT_PATH, output);
  return OUT_PATH;
}

const invoked = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (invoked) {
  generateThemeTokens();
  console.log(`theme tokens: wrote ${OUT_PATH}`);
}
