/**
 * Support/security-contract documentation check (issue #128).
 *
 * The public guides must describe the implemented sandbox/MCP matrix from
 * the canonical owners (electron/sandbox.ts, agent-core/mcp*), not the
 * retired provider-allowlist story: macOS-only candidates, live
 * candidates keep network, evidence/candidate-Verify fully offline, and
 * HTTP/SSE MCP servers supported. Also validates that maintained guide
 * fragment links resolve.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel: string): string => readFileSync(join(repoRoot, rel), "utf8");

const userGuide = () => read("docs/reference/USER-GUIDE.md");
const webGuide = () => read("website/guide.html");
const worldlines = () => read("docs/reference/WORLDLINES.md");

/** Phrases that promise a per-provider network allowlist for live candidates. */
const ALLOWLIST_PROMISES = [
  "network access denied except the model provider",
  "deny network except the model provider",
  "Deny candidate network except the active model provider",
];

describe("support/security contract docs (#128)", () => {
  it("documents macOS-only candidates and never Linux candidate support", () => {
    for (const [name, text] of [
      ["USER-GUIDE.md", userGuide()],
      ["guide.html", webGuide()],
    ] as const) {
      expect(text, `${name} must not claim Linux supports candidates`).not.toMatch(/Linux x64 do/);
      expect(text, `${name} must state candidates are macOS-only`).toMatch(/macOS only|not supported on other platforms/i);
    }
  });

  it("makes no provider-allowlist promise about current candidate behavior", () => {
    const guides = { "USER-GUIDE.md": userGuide(), "guide.html": webGuide() };
    for (const [name, text] of Object.entries(guides)) {
      for (const phrase of ALLOWLIST_PROMISES) {
        expect(text, `${name} must not promise: ${phrase}`).not.toContain(phrase);
      }
    }
    // The WORLDLINES test plan describes asserted behavior; the retired
    // allowlist bullet must stay gone from it.
    const plan = worldlines().slice(worldlines().indexOf("### `scripts/worldline-isolation-test.mjs`"));
    expect(plan).not.toContain("Deny candidate network except the active model provider");
    // The retired promise must be gone from the whole design doc, including
    // the FAQ and the section 6 candidate policy — not just the test plan.
    expect(worldlines()).not.toContain("except the active model provider");
  });

  it("distinguishes unsandboxed primaries, live candidates, and offline workers", () => {
    for (const [name, text] of [
      ["USER-GUIDE.md", userGuide()],
      ["guide.html", webGuide()],
    ] as const) {
      expect(text, `${name} must call primaries unsandboxed`).toMatch(/[Pp]rimary terminals are unsandboxed/);
      expect(text, `${name} must say live candidates keep network`).toMatch(/[Ll]ive candidates keep\s+network/);
      expect(text, `${name} must say evidence runs fully offline`).toMatch(/fully offline/);
    }
  });

  it("reconciles MCP HTTP/SSE documentation with the MCP owner", () => {
    expect(userGuide()).not.toContain("HTTP and SSE servers are ignored");
    expect(userGuide()).toMatch(/type: "http".*sse/s);
    // Both maintained guides agree remote servers exist.
    expect(read("docs/reference/AGENT-CORE.md")).toMatch(/Streamable HTTP and SSE/);
  });

  it("still matches the canonical sandbox/MCP contract sources", () => {
    const sandbox = read("electron/sandbox.ts");
    expect(sandbox).toContain("process.platform !== \"darwin\"");
    expect(sandbox).toMatch(/per-provider allowlist is not expressible/);
    expect(sandbox).toContain("keep network (the model provider must be reachable)");
    const mcpConfig = read("agent-core/mcp/config.ts");
    expect(mcpConfig).toContain('"http"');
    expect(mcpConfig).toContain('"sse"');
  });

  it("resolves same-file fragment links in the maintained guides", () => {
    // USER-GUIDE.md: [text](#slug) must match a GitHub-slugged heading.
    const md = userGuide();
    const slugs = new Set(
      [...md.matchAll(/^#{1,4}\s+(.+)$/gm)].map((m) =>
        m[1]
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9 _-]/g, "")
          .replace(/\s/g, "-"),
      ),
    );
    for (const href of [...md.matchAll(/\]\((#[^)]+)\)/g)].map((m) => m[1].slice(1))) {
      expect(slugs, `USER-GUIDE.md has no heading for #${href}`).toContain(href);
    }
    // guide.html: href="#id" must match an id="..." in the same file.
    const html = webGuide();
    const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
    for (const frag of [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1])) {
      expect(ids, `guide.html has no id for #${frag}`).toContain(frag);
    }
  });

  it("resolves guide.html cross-links into index.html sections", () => {
    const index = read("website/index.html");
    const ids = new Set([...index.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
    for (const frag of [...webGuide().matchAll(/href="index\.html#([^"]+)"/g)].map((m) => m[1])) {
      expect(ids, `index.html has no id for #${frag}`).toContain(frag);
    }
  });
});
