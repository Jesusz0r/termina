/**
 * Website install-command contract (issue #130).
 *
 * The site must never advertise a piped installer: scripts/install.sh
 * deliberately refuses piped execution and requires an on-disk checkout
 * plus Node/pnpm/cargo. Every visible and copyable install command is
 * validated against that installer contract.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel: string): string => readFileSync(join(repoRoot, rel), "utf8");

function unescapeHtml(text: string): string {
  return text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

describe("website install commands (#130)", () => {
  it("advertises no piped or remote-fetched installer", () => {
    for (const page of ["website/index.html", "website/guide.html"]) {
      const html = read(page);
      expect(html, `${page} must not pipe into a shell`).not.toMatch(/\|\s*sh\b/);
      expect(html, `${page} must not curl the installer`).not.toMatch(/curl[^<]*install\.sh/);
      expect(html, `${page} must not fetch install.sh remotely`).not.toMatch(/raw\.githubusercontent[^<]*install\.sh/);
    }
  });

  it("keeps every copyable command checkout-based", () => {
    const html = read("website/index.html");
    const commands = [...html.matchAll(/data-cmd="([^"]+)"/g)].map((m) => m[1]);
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command, `copy command must not pipe into a shell: ${command}`).not.toMatch(/\|\s*sh\b/);
      if (command.includes("install.sh")) {
        expect(command).toContain("sh scripts/install.sh");
        // The checkout must precede the installer invocation.
        expect(command.indexOf("cd termina")).toBeGreaterThanOrEqual(0);
        expect(command.indexOf("cd termina")).toBeLessThan(command.indexOf("scripts/install.sh"));
      }
    }
  });

  it("shows the same command it copies", () => {
    const html = read("website/index.html");
    const blocks = [...html.matchAll(/<div class="cmd">\s*<code>([\s\S]*?)<\/code>\s*<button[^>]*data-cmd="([^"]+)"[^>]*>/g)];
    expect(blocks.length).toBeGreaterThan(0);
    for (const [, visible, copied] of blocks) {
      expect(unescapeHtml(visible).trim()).toBe(copied);
    }
  });

  it("states the real source-install prerequisites", () => {
    const html = read("website/index.html");
    const sourcePane = html.slice(html.indexOf('data-pane="source"'));
    expect(sourcePane).toMatch(/Node[^<]*22\.19/);
    expect(sourcePane).toMatch(/pnpm/);
    expect(sourcePane).toMatch(/cargo/);
  });

  it("keeps install tabs and panes paired", () => {
    const html = read("website/index.html");
    const tabs = [...html.matchAll(/data-tab="([^"]+)"/g)].map((m) => m[1]);
    const panes = [...html.matchAll(/data-pane="([^"]+)"/g)].map((m) => m[1]);
    expect(tabs.length).toBeGreaterThan(0);
    expect(new Set(tabs)).toEqual(new Set(panes));
  });

  it("still matches the installer trust boundary it was validated against", () => {
    const installer = read("scripts/install.sh");
    expect(installer).toContain("must run as scripts/install.sh from a checked-out");
    expect(installer).toContain("must run from a checked-out Termina repository");
    expect(installer).toMatch(/node >= 22\.19 is required/);
    expect(installer).toContain("pnpm is required");
    expect(installer).toContain("Rust and cargo are required");
  });
});
