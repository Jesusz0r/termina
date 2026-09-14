import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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

  it("converts ripgrep byte offsets to editor columns (refs #173)", () => {
    const match = (text: string, start: number): string =>
      JSON.stringify({
        type: "match",
        data: {
          path: { text: "./unicode.txt" },
          lines: { text },
          line_number: 1,
          absolute_offset: 0,
          submatches: [{ match: { text: "needle" }, start, end: start + 6 }],
        },
      });
    // The filed record: é is 2 bytes but 1 UTF-16 unit, so byte 5 is column 4.
    expect(parseRipgrepJsonLine(match("éé needle\n", 5), root)).toEqual({
      relPath: "unicode.txt",
      line: 1,
      column: 4,
      text: "éé needle",
    });
    // ASCII control: bytes and columns agree.
    expect(parseRipgrepJsonLine(match("a needle\n", 2), root)?.column).toBe(3);
    // Emoji are surrogate pairs: 4 bytes, 2 UTF-16 units.
    expect(parseRipgrepJsonLine(match("😀 needle\n", 5), root)?.column).toBe(4);
    // End-of-line offsets land past the last character.
    expect(parseRipgrepJsonLine(match("needle\n", 6), root)?.column).toBe(7);
    // Invalid boundaries are rejected, not mis-navigated.
    expect(parseRipgrepJsonLine(match("éé needle\n", 1), root)).toBeNull();
    expect(parseRipgrepJsonLine(match("éé needle\n", 99), root)).toBeNull();
    expect(parseRipgrepJsonLine(match("éé needle\n", -1), root)).toBeNull();
    expect(parseRipgrepJsonLine(match("éé needle\n", 2.5), root)).toBeNull();
  });

  it("agrees with the fallback scan on multibyte columns (refs #173)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "termina-content-unicode-"));
    try {
      writeFileSync(join(dir, "unicode.txt"), "éé needle\n");
      const scanned = await searchProjectContent(dir, "needle", {
        rg: null,
        candidates: { paths: ["unicode.txt"], truncated: false },
      });
      expect(scanned.hits).toEqual([{ relPath: "unicode.txt", line: 1, column: 4, text: "éé needle" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it("rejects an external rg symlink whose target is inside the project (refs #174)", () => {
    const project = mkdtempSync(join(tmpdir(), "termina-content-proj-"));
    const external = mkdtempSync(join(tmpdir(), "termina-content-ext-"));
    try {
      writeFileSync(join(project, "fixture-rg"), "#!/bin/sh\nexit 0\n");
      symlinkSync(join(project, "fixture-rg"), join(external, "rg"));
      process.env.PATH = external;
      // The selected executable is never run; discovery alone must refuse it.
      expect(findRipgrep(project)).toBeNull();
    } finally {
      rmSync(project, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    }
  });

  it("rejects an aliased PATH directory inside the project (refs #174)", () => {
    const project = mkdtempSync(join(tmpdir(), "termina-content-alias-"));
    const external = mkdtempSync(join(tmpdir(), "termina-content-aliasbin-"));
    try {
      mkdirSync(join(project, "tools"), { recursive: true });
      writeFileSync(join(project, "tools", "rg"), "#!/bin/sh\nexit 0\n");
      symlinkSync(join(project, "tools"), join(external, "linked"));
      process.env.PATH = join(external, "linked");
      expect(findRipgrep(project)).toBeNull();
    } finally {
      rmSync(project, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    }
  });

  it("accepts an external symlink to an external binary (refs #174)", () => {
    const external = mkdtempSync(join(tmpdir(), "termina-content-extok-"));
    try {
      writeFileSync(join(external, "real-rg"), "#!/bin/sh\nexit 0\n");
      symlinkSync(join(external, "real-rg"), join(external, "rg"));
      process.env.PATH = external;
      expect(findRipgrep(join(tmpdir(), "termina-content-other"))).toBe(join(realpathSync(external), "real-rg"));
    } finally {
      rmSync(external, { recursive: true, force: true });
    }
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

  it.runIf(process.platform !== "win32")("never blocks on a FIFO .gitignore in the fallback (refs #170)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "termina-content-fifo-"));
    try {
      writeFileSync(join(dir, "a.txt"), "a needle in hay\n");
      expect(spawnSync("mkfifo", [join(dir, ".gitignore")]).status).toBe(0);
      const result = await Promise.race([
        searchProjectContent(dir, "needle", { rg: null, candidates: { paths: ["a.txt"], truncated: false } }),
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("fallback blocked on FIFO")), 5000)),
      ]);
      expect(result.hits).toContainEqual({ relPath: "a.txt", line: 1, column: 3, text: "a needle in hay" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
