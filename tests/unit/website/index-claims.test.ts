/**
 * Marketing claims on website/index.html (issue #388).
 *
 * Packaged Linux cannot deliver macOS-only worldline / sandbox-exec / APFS
 * mechanisms. Stale snapshot ratios stay dated as historical. Install
 * commands themselves stay on the #130 contract (install-commands.test.ts).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel: string): string => readFileSync(join(repoRoot, rel), "utf8");

function tickerHtml(html: string): string {
  const start = html.indexOf('id="ticker-track"');
  expect(start).toBeGreaterThanOrEqual(0);
  return html.slice(start, html.indexOf("</div>", start));
}

function installSection(html: string): string {
  const start = html.indexOf('id="install"');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = html.indexOf("<!-- ============ FINAL CTA", start);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

describe("website index claims (#388)", () => {
  it("does not promise a worldline from every download path", () => {
    const install = installSection(read("website/index.html"));
    expect(install).not.toMatch(/first worldline/i);
    expect(install).toMatch(/first session/i);
    expect(install).toMatch(/Git repo/i);
    expect(install).toMatch(/macOS sandbox helpers/i);
    expect(install).toMatch(/not on the Linux AppImage/i);
  });

  it("qualifies macOS-only ticker mechanisms and drops the stale 7× ticker", () => {
    const ticker = tickerHtml(read("website/index.html"));
    expect(ticker).toContain("sandbox-exec isolation (macOS)");
    expect(ticker).toContain("APFS copy-on-write forks (macOS)");
    expect(ticker).not.toMatch(/7\s*× faster snapshots/i);
  });

  it("dates published snapshot ratios as historical, not current claims", () => {
    const html = read("website/index.html");
    const speed = html.slice(html.indexOf('id="speed"'), html.indexOf('id="install"'));
    expect(speed).toMatch(/historical samples/i);
    expect(speed).toContain("re-measurement pending");
    expect(speed).toMatch(/not a current performance claim/i);
    expect(speed).toContain("7×");
  });

  it("drops the retired PI TUI comment and the vendor-pinned mockup model", () => {
    const html = read("website/index.html");
    const script = read("website/app.js");
    expect(html).not.toContain("<!-- PI TUI -->");
    expect(html).toContain("<!-- AGENT TUI -->");
    expect(html).not.toMatch(/gemini-2\.5-pro/);
    expect(script).not.toMatch(/gemini-2\.5-pro/);
    expect(html).toContain("your model");
    expect(script).toContain("your model");
  });

  it("keeps TERMINA_* installer escapes off the site", () => {
    for (const page of ["website/index.html", "website/guide.html", "website/app.js"]) {
      const text = read(page);
      expect(text, page).not.toMatch(/TERMINA_EVENTS_DIR|TERMINA_CORE_BIN|TERMINA_SKIP_CORE_BUILD/);
    }
  });
});
