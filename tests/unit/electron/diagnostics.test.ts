import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Source-level probes for background diagnostics: after an owner's run
 * settles, a cached TypeScript check refreshes silently into turn context.
 * The Electron suite covers visible flows; this probe covers the detection,
 * caching, and bounding wiring without a display server. Diagnostics logic
 * lives in electron/diagnostics.ts; main only triggers it.
 */
describe("Diagnostics Invariants", () => {
  it("detects, caches, bounds, and channels background typechecks", async () => {
    const main = readFileSync(new URL("../../../electron/main.ts", import.meta.url), "utf8");
    const diagnostics = readFileSync(new URL("../../../electron/diagnostics.ts", import.meta.url), "utf8");
    const host = readFileSync(new URL("../../../agent-core/host.ts", import.meta.url), "utf8");
    const checks: string[] = [];
    function check(name: string, value: unknown) {
      assert.equal(Boolean(value), true, name);
      checks.push(name);
    }

    // Project-local compiler only; other stacks stay manual.
    check("detection requires tsconfig and the project tsc",
      diagnostics.includes("await stat(join(root, \"tsconfig.json\"));")
      && diagnostics.includes("join(root, \"node_modules\", \".bin\", \"tsc\")"));
    // Owner settle triggers; primary workspaces only.
    check("owner settle triggers diagnostics",
      main.includes("void this.diagnostics.run(inst);")
      && diagnostics.includes("if (!ws || !ws.primary || this.host.isDisposed()) return;"));
    // Generation-cached with a start-generation watermark and a per-workspace
    // rate limit: unchanged trees skip, mid-run edits are never marked clean.
    check("generation cache skips unchanged trees",
      diagnostics.includes("if (last && last.generation >= startGeneration) return;")
      && diagnostics.includes("if (pass) {")
      && diagnostics.includes("this.lastDiagnostics.set(ws.id, { generation: startGeneration, atMs: current?.atMs ?? Date.now() });"));
    check("one run per minute per workspace",
      diagnostics.includes("MIN_DIAGNOSTICS_INTERVAL_MS")
      && diagnostics.includes("if (last && Date.now() - last.atMs < MIN_DIAGNOSTICS_INTERVAL_MS) return;"));
    // One flight per workspace; bounded time, output, context, and map size.
    check("one flight with bounded time and output",
      diagnostics.includes("if (this.diagnosticsRuns.has(ws.id)) return;")
      && diagnostics.includes("DIAGNOSTICS_TIMEOUT_MS")
      && diagnostics.includes("MAX_DIAGNOSTICS_OUTPUT"));
    check("context file and map stay bounded",
      diagnostics.includes("components: [`diagnostics-${inst.id}.md`],")
      && diagnostics.includes("MAX_DIAGNOSTICS_WORKSPACES"));
    // Lowest priority in the shared bounded channel.
    check("host reads diagnostics last",
      host.includes('const CONTEXT_FILES = ["verify", "edits", "mailbox", "project", "diagnostics"] as const;'));
    assert.ok(checks.length >= 6);
  });
});
