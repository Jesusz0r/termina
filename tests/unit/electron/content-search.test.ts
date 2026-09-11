import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  findRipgrep,
  parseRipgrepJsonLine,
  searchProjectContent,
} from "../../../electron/content-search.ts";

describe("content-search parseRipgrepJsonLine", () => {
  const root = join(tmpdir(), "termina-content-root");

  it("parses a match record into a 1-based hit", () => {
    const hit = parseRipgrepJsonLine(
      JSON.stringify({
        type: "match",
        data: {
          path: { text: "./sub/a.txt" },
          lines: { text: "a needle in hay\n" },
          line_number: 3,
          absolute_offset: 20,
          submatches: [{ match: { text: "needle" }, start: 2, end: 8 }],
        },
      }),
      root,
    );
    expect(hit).toEqual({ relPath: join("sub", "a.txt"), line: 3, column: 3, text: "a needle in hay" });
  });

  it("rejects non-match, malformed, binary, and escaping records", () => {
    const match = (overrides: Record<string, unknown>): string =>
      JSON.stringify({
        type: "match",
        data: {
          path: { text: "./a.txt" },
          lines: { text: "needle\n" },
          line_number: 1,
          absolute_offset: 0,
          submatches: [{ match: { text: "needle" }, start: 0, end: 6 }],
          ...overrides,
        },
      });
    expect(parseRipgrepJsonLine(JSON.stringify({ type: "begin", data: {} }), root)).toBeNull();
    expect(parseRipgrepJsonLine(JSON.stringify({ type: "summary", data: {} }), root)).toBeNull();
    expect(parseRipgrepJsonLine("not json", root)).toBeNull();
    expect(parseRipgrepJsonLine("[]", root)).toBeNull();
    // Binary payloads carry base64 bytes instead of text.
    expect(parseRipgrepJsonLine(match({ lines: { bytes: "bmVlZGxl" } }), root)).toBeNull();
    expect(parseRipgrepJsonLine(match({ path: { text: "../escape.txt" } }), root)).toBeNull();
    expect(parseRipgrepJsonLine(match({ line_number: 0 }), root)).toBeNull();
    expect(parseRipgrepJsonLine(match({ lines: { text: 42 } }), root)).toBeNull();
  });

  it("relativizes absolute paths and truncates long previews", () => {
    const abs = join(root, "deep", "b.txt");
    const hit = parseRipgrepJsonLine(
      JSON.stringify({
        type: "match",
        data: {
          path: { text: abs },
          lines: { text: `needle${"x".repeat(500)}\n` },
          line_number: 1,
          absolute_offset: 0,
          submatches: [],
        },
      }),
      root,
    );
    expect(hit?.relPath).toBe(join("deep", "b.txt"));
    expect(hit?.column).toBe(1);
    expect(hit?.text.length).toBeLessThanOrEqual(241);
    expect(hit?.text.endsWith("…")).toBe(true);
  });
});

describe("content-search findRipgrep", () => {
  let binDir: string;
  let savedPath: string | undefined;
  beforeAll(() => {
    binDir = mkdtempSync(join(tmpdir(), "termina-content-bin-"));
    writeFileSync(join(binDir, "rg"), "#!/bin/sh\nexit 0\n");
  });
  afterAll(() => {
    rmSync(binDir, { recursive: true, force: true });
  });
  beforeEach(() => {
    savedPath = process.env.PATH;
  });
  afterEach(() => {
    process.env.PATH = savedPath;
  });

  it("finds rg on PATH and skips relative entries", () => {
    process.env.PATH = ["relative-dir", "", binDir].join(delimiter);
    expect(findRipgrep(join(tmpdir(), "termina-content-other"))).toBe(join(realpathSync(binDir), "rg"));
  });

  it("never resolves a binary from inside the searched root", () => {
    process.env.PATH = binDir;
    expect(findRipgrep(binDir)).toBeNull();
  });

  it("returns null when rg is absent", () => {
    process.env.PATH = join(tmpdir(), "termina-content-no-bin");
    expect(findRipgrep(join(tmpdir(), "termina-content-other"))).toBeNull();
  });
});

describe("content-search scan engine", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "termina-content-scan-"));
    writeFileSync(join(root, "a.txt"), "first line\na needle in hay\nlast line\n");
    mkdirSync(join(root, "sub"), { recursive: true });
    writeFileSync(join(root, "sub", "b.txt"), "nothing\nneedle at start\n");
    writeFileSync(join(root, "sub", "debug.log"), "needle in log\n");
    writeFileSync(join(root, "sub", ".gitignore"), "debug.log\n");
    mkdirSync(join(root, "ignored"), { recursive: true });
    writeFileSync(join(root, "ignored", "skip.txt"), "needle in ignored dir\n");
    writeFileSync(join(root, ".gitignore"), "ignored/\n");
    writeFileSync(join(root, "binary.bin"), Buffer.from([0x6e, 0x00, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x0a]));
    writeFileSync(join(root, "big.txt"), `needle\n${"x".repeat(1024 * 1024 + 8)}`);
    writeFileSync(join(root, "many.txt"), `${"needle\n".repeat(60)}`);
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(root, `bulk-${i}.txt`), "needle\n".repeat(50));
    }
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("finds hits with 1-based line/column and previews", async () => {
    const { hits, truncated } = await searchProjectContent(root, "needle", {
      rg: null,
      candidates: { paths: ["a.txt", join("sub", "b.txt")], truncated: false },
    });
    expect(truncated).toBe(false);
    expect(hits).toContainEqual({ relPath: "a.txt", line: 2, column: 3, text: "a needle in hay" });
    expect(hits).toContainEqual({ relPath: join("sub", "b.txt"), line: 2, column: 1, text: "needle at start" });
  });

  it("respects root and nested gitignore files", async () => {
    const { hits } = await searchProjectContent(root, "needle", {
      rg: null,
      candidates: {
        paths: ["a.txt", join("ignored", "skip.txt"), join("sub", "debug.log")],
        truncated: false,
      },
    });
    expect(hits.map((h) => h.relPath)).toEqual(["a.txt"]);
  });

  it("skips binary files and reports truncation for oversized ones", async () => {
    const { hits, truncated } = await searchProjectContent(root, "needle", {
      rg: null,
      candidates: { paths: ["binary.bin", "big.txt"], truncated: false },
    });
    expect(hits).toEqual([]);
    expect(truncated).toBe(true);
  });

  it("caps per-file hits and reports truncation", async () => {
    const { hits, truncated } = await searchProjectContent(root, "needle", {
      rg: null,
      candidates: { paths: ["many.txt"], truncated: false },
    });
    expect(hits).toHaveLength(50);
    expect(truncated).toBe(true);
  });

  it("caps total hits across files", async () => {
    const { hits, truncated } = await searchProjectContent(root, "needle", { rg: null });
    expect(hits).toHaveLength(200);
    expect(truncated).toBe(true);
  });

  it("treats uncompilable patterns as no hits without throwing", async () => {
    const { hits, truncated } = await searchProjectContent(root, "(unclosed", { rg: null });
    expect(hits).toEqual([]);
    expect(truncated).toBe(false);
  });

  it("returns nothing once superseded and propagates inventory truncation", async () => {
    const stopped = await searchProjectContent(root, "needle", {
      rg: null,
      shouldStop: () => true,
      candidates: { paths: ["a.txt"], truncated: false },
    });
    expect(stopped).toEqual({ hits: [], truncated: false });
    const partial = await searchProjectContent(root, "needle", {
      rg: null,
      candidates: { paths: [], truncated: true },
    });
    expect(partial).toEqual({ hits: [], truncated: true });
  });
});

describe("content-search ripgrep engine", () => {
  let root: string;
  let binDir: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "termina-content-rg-"));
    writeFileSync(join(root, "real.txt"), "nothing\nneedle via scan\n");
    binDir = mkdtempSync(join(tmpdir(), "termina-content-rgbin-"));
    const match = JSON.stringify({
      type: "match",
      data: {
        path: { text: "./canned.txt" },
        lines: { text: "needle via ripgrep\n" },
        line_number: 7,
        absolute_offset: 60,
        submatches: [{ match: { text: "needle" }, start: 0, end: 6 }],
      },
    });
    writeFileSync(join(binDir, "rg-ok"), `#!/bin/sh\nprintf '%s\\n' '${match}' '{"type":"summary","data":{}}'\n`);
    writeFileSync(join(binDir, "rg-fail"), "#!/bin/sh\nexit 2\n");
    writeFileSync(join(binDir, "rg-empty"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(binDir, "rg-ok"), 0o755);
    chmodSync(join(binDir, "rg-fail"), 0o755);
    chmodSync(join(binDir, "rg-empty"), 0o755);
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  });

  it("streams structured hits from rg --json", async () => {
    const { hits, truncated } = await searchProjectContent(root, "needle", { rg: join(binDir, "rg-ok") });
    expect(truncated).toBe(false);
    expect(hits).toEqual([{ relPath: "canned.txt", line: 7, column: 1, text: "needle via ripgrep" }]);
  });

  it("treats rg exit 1 as a clean no-match", async () => {
    await expect(searchProjectContent(root, "needle", { rg: join(binDir, "rg-empty") })).resolves.toEqual({
      hits: [],
      truncated: false,
    });
  });

  it("falls back to the scan when rg errors or is missing", async () => {
    for (const rg of [join(binDir, "rg-fail"), join(binDir, "rg-missing")]) {
      const { hits, truncated } = await searchProjectContent(root, "needle", { rg });
      expect(truncated).toBe(false);
      expect(hits).toEqual([{ relPath: "real.txt", line: 2, column: 1, text: "needle via scan" }]);
    }
  });
});
