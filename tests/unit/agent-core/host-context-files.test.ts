import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HOST_CONTEXT_BYTES, readContextFilesResult } from "../../../agent-core/host/context.ts";
import { cache } from "../../../agent-core/trace/normalize.ts";

const TERMINAL_ID = "term-1";

function contextFile(dir: string, kind: string): string {
  return join(dir, `${kind}-${TERMINAL_ID}.md`);
}

function contentHash(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

describe("host context file digests", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "termina-context-files-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports one digest per context kind with consumed-byte hashes", () => {
    writeFileSync(contextFile(dir, "project"), "project notes\n");
    writeFileSync(contextFile(dir, "edits"), "edit log\n");

    const result = readContextFilesResult(dir, TERMINAL_ID);
    expect(result.files.map((file) => file.kind)).toEqual(["verify", "edits", "mailbox", "project", "diagnostics"]);

    const project = result.files.find((file) => file.kind === "project")!;
    expect(project.present).toBe(true);
    expect(project.size).toBe(Buffer.byteLength("project notes\n", "utf8"));
    expect(project.mtimeMs).toBeGreaterThan(0);
    expect(project.consumedBytes).toBe(project.size);
    expect(project.contentHash).toBe(contentHash("project notes\n"));

    for (const kind of ["verify", "mailbox", "diagnostics"]) {
      const missing = result.files.find((file) => file.kind === kind)!;
      expect(missing).toMatchObject({ present: false, size: null, mtimeMs: null, consumedBytes: 0, contentHash: null });
    }
  });

  it("attributes a content change to exactly the file that moved", () => {
    writeFileSync(contextFile(dir, "project"), "project notes\n");
    writeFileSync(contextFile(dir, "edits"), "edit log\n");
    const before = readContextFilesResult(dir, TERMINAL_ID);

    writeFileSync(contextFile(dir, "edits"), "edit log\nmore edits\n");
    const after = readContextFilesResult(dir, TERMINAL_ID);

    expect(after.text).not.toBe(before.text);
    for (const kind of ["verify", "mailbox", "project", "diagnostics"]) {
      expect(after.files.find((file) => file.kind === kind)).toEqual(before.files.find((file) => file.kind === kind));
    }
    const editsBefore = before.files.find((file) => file.kind === "edits")!;
    const editsAfter = after.files.find((file) => file.kind === "edits")!;
    expect(editsAfter.present).toBe(true);
    expect(editsAfter.size).not.toBe(editsBefore.size);
    expect(editsAfter.contentHash).not.toBe(editsBefore.contentHash);
    expect(editsAfter.contentHash).toBe(contentHash("edit log\nmore edits\n"));
  });

  it("hashes only the consumed prefix when the read truncates", () => {
    const oversized = "x".repeat(HOST_CONTEXT_BYTES + 1024);
    writeFileSync(contextFile(dir, "verify"), oversized);

    const result = readContextFilesResult(dir, TERMINAL_ID);
    expect(result.truncated).toBe(true);
    expect(result.inputBytes).toBe(Buffer.byteLength(oversized, "utf8"));
    const verify = result.files.find((file) => file.kind === "verify")!;
    expect(verify.present).toBe(true);
    expect(verify.size).toBe(oversized.length);
    expect(verify.consumedBytes).toBeGreaterThan(0);
    expect(verify.consumedBytes).toBeLessThan(verify.size!);
    expect(verify.contentHash).toBe(contentHash(Buffer.from(oversized.slice(0, verify.consumedBytes), "utf8")));
  });
});

describe("trace cache hostContext normalization", () => {
  it("persists bounded metadata plus per-file digests", () => {
    const normalized = cache({
      namespace: "test",
      hostContext: {
        state: "complete",
        direction: "head",
        limitBytes: HOST_CONTEXT_BYTES,
        inputBytes: 100,
        retainedBytes: 100,
        omittedBytes: 0,
        outputBytes: 100,
        truncated: false,
        files: [
          { kind: "project", present: true, size: 14, mtimeMs: 123.4, consumedBytes: 14, contentHash: "abc123" },
          { kind: "edits", present: false, size: null, mtimeMs: null, consumedBytes: 0, contentHash: null },
        ],
      },
    });
    expect(normalized.hostContext).toMatchObject({
      state: "complete",
      direction: "head",
      truncated: false,
      files: [
        { kind: "project", present: true, size: 14, mtimeMs: 123.4, consumedBytes: 14, contentHash: "abc123" },
        { kind: "edits", present: false, size: null, mtimeMs: null, consumedBytes: 0, contentHash: null },
      ],
    });
  });

  it("nulls invalid digest fields and drops non-record entries", () => {
    const normalized = cache({
      namespace: "test",
      hostContext: {
        state: "complete",
        files: [
          { kind: "project", present: "yes", size: -5, mtimeMs: -1, consumedBytes: 1.5, contentHash: 42 },
          "not-a-record" as never,
          null as never,
        ],
      },
    });
    expect(normalized.hostContext?.files).toEqual([
      { kind: "project", present: null, size: null, mtimeMs: null, consumedBytes: null, contentHash: null },
    ]);
  });

  it("reports null hostContext when absent or not a record", () => {
    expect(cache({ namespace: "test" }).hostContext).toBeNull();
    expect(cache({ namespace: "test", hostContext: "junk" as never }).hostContext).toBeNull();
  });
});
