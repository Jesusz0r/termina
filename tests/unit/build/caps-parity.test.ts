import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { cacheRequestDiagnostics } from "../../../agent-core/cache.ts";

/**
 * Cross-module budget parity (#12). The main and renderer processes bundle
 * separately, so each owns its timeline cap literal (electron/main.ts and
 * src/timeline.ts) with parity pinned here. Inside the renderer the cap has
 * one shared owner: src/timeline.ts. Consumers (src/main.ts, its split
 * modules) import it instead of defining their own. The marker bound is
 * behavioral: agent-core/cache is side-effect free.
 */
const read = (path: string) => readFile(path, "utf8");

function constValues(source: string, name: string): string[] {
  const matches = source.matchAll(new RegExp(`(?:const|let) ${name}\\s*=\\s*([^;\\n]+)`, "g"));
  return [...matches].map((match) => match[1]!.trim());
}

describe("Cross-module budget parity", () => {
  it("keeps MAX_TIMELINE_EVENTS identical in main and renderer", async () => {
    const electron = constValues(await read("electron/main.ts"), "MAX_TIMELINE_EVENTS");
    const rendererOwner = constValues(await read("src/timeline.ts"), "MAX_TIMELINE_EVENTS");
    expect(electron, "electron/main.ts must define MAX_TIMELINE_EVENTS exactly once").toHaveLength(1);
    expect(rendererOwner, "src/timeline.ts must define MAX_TIMELINE_EVENTS exactly once").toHaveLength(1);
    expect(new Set([electron[0], rendererOwner[0]])).toEqual(new Set(["400"]));
    // Renderer consumers import the shared owner instead of defining their own.
    const mainSource = await read("src/main.ts");
    expect(constValues(mainSource, "MAX_TIMELINE_EVENTS"), "src/main.ts must not define its own timeline cap").toEqual([]);
    expect(mainSource, "src/main.ts must import MAX_TIMELINE_EVENTS from ./timeline").toMatch(
      /import\s*\{[^}]*MAX_TIMELINE_EVENTS[^}]*\}\s*from\s*["']\.\/timeline["']/,
    );
  });

  it("keeps the timeline content budget owned by main", async () => {
    const main = await read("electron/main.ts");
    expect(constValues(main, "MAX_TIMELINE_CONTENT_BYTES")).toEqual(["4 * 1024 * 1024"]);
    // The renderer intentionally holds no content budget: main strips content
    // before send (trimTimelineContent) and evicts by seq (timeline:evict).
    for (const file of ["src/main.ts", "src/timeline.ts"]) {
      expect(constValues(await read(file), "MAX_TIMELINE_CONTENT_BYTES"), `${file} must not define its own content budget`).toEqual([]);
    }
  });

  it("bounds marker positions to 64 entries", async () => {
    const policy = {
      provider: "openrouter",
      protocol: "openai-responses",
      model: "openai/gpt-5.6",
      requestedMode: "explicit",
      effectiveMode: "explicit",
      requestedTtlMs: null,
      effectiveTtlMs: null,
      retentionKnown: null,
      fallbackReason: null,
    };
    const diagnostics = cacheRequestDiagnostics({
      identity: null,
      policy,
      markerPositions: Array.from({ length: 100 }, (_, index) => index),
    });
    expect(diagnostics.markerPositions).toHaveLength(64);
    expect(diagnostics.markerPositions?.[63]).toBe(63);
  });
});
