import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as host from "../../../agent-core/host.ts";

describe("Agent Core Host Output & Context Bounding", () => {
  let root: string;
  const terminalId = "term-host-output";

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "agent-core-host-output-"));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    for (const kind of ["verify", "edits", "mine", "mailbox"]) {
      rmSync(join(root, `${kind}-${terminalId}.md`), { force: true, recursive: true });
    }
  });

  it("preserves complete UTF-8 text below the cap", () => {
    writeFileSync(join(root, `verify-${terminalId}.md`), "before-é-😀-after");
    const result = host.readContextFilesResult(root, terminalId);

    expect(result.state).toBe("complete");
    expect(result.text).toBe("before-é-😀-after");
    expect(result.truncated).toBe(false);
    expect(result.inputBytes).toBe(Buffer.byteLength(result.text, "utf8"));
    expect(result.omittedBytes).toBe(0);
    expect(result.outputBytes).toBe(Buffer.byteLength(result.text, "utf8"));
  });

  it("caps at a UTF-8 boundary and reports omission", () => {
    const prefix = "x".repeat(host.HOST_CONTEXT_BYTES - Buffer.byteLength("é", "utf8") + 1);
    writeFileSync(join(root, `verify-${terminalId}.md`), `${prefix}é-tail`);
    const result = host.readContextFilesResult(root, terminalId);

    expect(result.state).toBe("complete");
    expect(result.truncated).toBe(true);
    expect(result.outputBytes).toBe(Buffer.byteLength(result.text, "utf8"));
    expect(result.outputBytes).toBeLessThanOrEqual(host.HOST_CONTEXT_BYTES);
    expect(result.omittedBytes).toBeGreaterThan(0);
    expect(result.text).not.toContain("\uFFFD");
    expect(result.text).toMatch(/\[host context truncated\]$/);
    expect(host.readContextFiles(root, terminalId)).toBe(result.text);
  });

  it("distinguishes an interrupted read", () => {
    writeFileSync(join(root, `verify-${terminalId}.md`), "large-😀-context");
    const result = host.readContextFilesResult(root, terminalId, { shouldStop: () => true });

    expect(result.state).toBe("interrupted");
    expect(result.truncated).toBe(true);
    expect(result.text).toMatch(/\[host context incomplete: interrupted\]$/);
  });

  it("stops after an interruption instead of reading later files", () => {
    writeFileSync(join(root, `verify-${terminalId}.md`), "verify-".repeat(10_000));
    writeFileSync(join(root, `edits-${terminalId}.md`), "edits-".repeat(10_000));
    let probes = 0;
    const result = host.readContextFilesResult(root, terminalId, {
      shouldStop: () => ++probes === 3,
    });

    expect(result.state).toBe("interrupted");
    expect(result.inputBytes).toBeLessThanOrEqual(16 * 1024);
  });

  it("uses stat to bound a sparse oversized read", () => {
    const sparseBytes = 4 * 1024 * 1024 * 1024;
    const path = join(root, `verify-${terminalId}.md`);
    writeFileSync(path, "");
    truncateSync(path, sparseBytes);
    const started = performance.now();
    const result = host.readContextFilesResult(root, terminalId);
    const elapsedMs = performance.now() - started;

    expect(result.state).toBe("complete");
    expect(result.inputBytes).toBe(sparseBytes);
    expect(result.omittedBytes).toBeGreaterThan(0);
    expect(result.truncated).toBe(true);
    expect(result.outputBytes).toBeLessThanOrEqual(host.HOST_CONTEXT_BYTES);
    expect(elapsedMs).toBeLessThan(1500);
  });

  it("distinguishes an unreadable context entry", () => {
    mkdirSync(join(root, `verify-${terminalId}.md`));
    const result = host.readContextFilesResult(root, terminalId);

    expect(result.state).toBe("unreadable");
    expect(result.truncated).toBe(true);
    expect(result.text).toMatch(/\[host context incomplete: unreadable\]$/);
  });

  it("distinguishes a failed stop probe", () => {
    writeFileSync(join(root, `verify-${terminalId}.md`), "context");
    const result = host.readContextFilesResult(root, terminalId, {
      shouldStop: () => {
        throw new Error("stop probe failed");
      },
    });

    expect(result.state).toBe("failed");
    expect(result.truncated).toBe(true);
    expect(result.text).toMatch(/\[host context incomplete: failed\]$/);
  });

  it("fails closed for symlink entries in context and image reads", () => {
    const contextTarget = join(root, "context-secret.md");
    writeFileSync(contextTarget, "secret context");
    symlinkSync(contextTarget, join(root, `verify-${terminalId}.md`));
    const context = host.readContextFilesResult(root, terminalId);
    expect(context.state).toBe("unreadable");
    expect(context.text).not.toContain("secret context");

    const imageRoot = join(root, "images");
    mkdirSync(imageRoot, { recursive: true });
    const imageTarget = join(root, "image-secret.png");
    writeFileSync(imageTarget, Buffer.from("not-an-image"));
    symlinkSync(imageTarget, join(imageRoot, "session-img-1.png"));
    const image = host.expandFileImageSource(
      { type: "file", name: "session-img-1.png", media_type: "image/png" },
      [imageRoot],
    );
    expect(image).toBeNull();
  });
});
