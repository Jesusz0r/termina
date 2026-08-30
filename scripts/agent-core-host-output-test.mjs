/**
 * Focused RED/GREEN tests for host-context bounded output.
 *
 * Run with:
 *   node --experimental-strip-types --no-warnings scripts/agent-core-host-output-test.mjs
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const host = await import("../agent-core/host.ts");

const failures = [];
function check(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`FAIL  ${name} — ${error instanceof Error ? error.message : String(error)}`);
  }
}

const root = mkdtempSync(join(tmpdir(), "agent-core-host-output-"));
const terminalId = "term-host-output";
try {
  check("host context preserves complete UTF-8 text below the cap", () => {
    writeFileSync(join(root, `verify-${terminalId}.md`), "before-é-😀-after");
    const result = host.readContextFilesResult(root, terminalId);

    assert.equal(result.state, "complete");
    assert.equal(result.text, "before-é-😀-after");
    assert.equal(result.truncated, false);
    assert.equal(result.inputBytes, Buffer.byteLength(result.text, "utf8"));
    assert.equal(result.omittedBytes, 0);
    assert.equal(result.outputBytes, Buffer.byteLength(result.text, "utf8"));
  });

  check("host context caps at a UTF-8 boundary and reports omission", () => {
    const prefix = "x".repeat(host.HOST_CONTEXT_BYTES - Buffer.byteLength("é", "utf8") + 1);
    writeFileSync(join(root, `verify-${terminalId}.md`), `${prefix}é-tail`);
    const result = host.readContextFilesResult(root, terminalId);

    assert.equal(result.state, "complete");
    assert.equal(result.truncated, true);
    assert.equal(result.outputBytes, Buffer.byteLength(result.text, "utf8"));
    assert.ok(result.outputBytes <= host.HOST_CONTEXT_BYTES);
    assert.ok(result.omittedBytes > 0);
    assert.ok(!result.text.includes("\uFFFD"));
    assert.match(result.text, /\[host context truncated\]$/);
    assert.equal(host.readContextFiles(root, terminalId), result.text);
  });

  check("host context distinguishes an interrupted read", () => {
    writeFileSync(join(root, `verify-${terminalId}.md`), "large-😀-context");
    const result = host.readContextFilesResult(root, terminalId, { shouldStop: () => true });

    assert.equal(result.state, "interrupted");
    assert.equal(result.truncated, true);
    assert.match(result.text, /\[host context incomplete: interrupted\]$/);
  });

  check("host context stops after an interruption instead of reading later files", () => {
    writeFileSync(join(root, `verify-${terminalId}.md`), "verify-".repeat(10_000));
    writeFileSync(join(root, `edits-${terminalId}.md`), "edits-".repeat(10_000));
    let probes = 0;
    const result = host.readContextFilesResult(root, terminalId, {
      shouldStop: () => ++probes === 3,
    });

    assert.equal(result.state, "interrupted");
    assert.ok(result.inputBytes <= 16 * 1024);
  });

  check("host context uses stat to bound a sparse oversized read", () => {
    for (const kind of ["verify", "edits", "mine", "mailbox"]) {
      rmSync(join(root, `${kind}-${terminalId}.md`), { force: true });
    }
    const sparseBytes = 4 * 1024 * 1024 * 1024;
    const path = join(root, `verify-${terminalId}.md`);
    writeFileSync(path, "");
    truncateSync(path, sparseBytes);
    const started = performance.now();
    const result = host.readContextFilesResult(root, terminalId);
    const elapsedMs = performance.now() - started;

    assert.equal(result.state, "complete");
    assert.equal(result.inputBytes, sparseBytes);
    assert.ok(result.omittedBytes > 0);
    assert.ok(result.truncated);
    assert.ok(result.outputBytes <= host.HOST_CONTEXT_BYTES);
    assert.ok(elapsedMs < 1500, `oversized context read took ${elapsedMs.toFixed(0)}ms`);
  });

  check("host context distinguishes an unreadable context entry", () => {
    rmSync(join(root, `verify-${terminalId}.md`), { force: true });
    mkdirSync(join(root, `verify-${terminalId}.md`));
    const result = host.readContextFilesResult(root, terminalId);

    assert.equal(result.state, "unreadable");
    assert.equal(result.truncated, true);
    assert.match(result.text, /\[host context incomplete: unreadable\]$/);
  });

  check("host context distinguishes a failed stop probe", () => {
    rmSync(join(root, `verify-${terminalId}.md`), { recursive: true, force: true });
    writeFileSync(join(root, `verify-${terminalId}.md`), "context");
    const result = host.readContextFilesResult(root, terminalId, {
      shouldStop: () => {
        throw new Error("stop probe failed");
      },
    });

    assert.equal(result.state, "failed");
    assert.equal(result.truncated, true);
    assert.match(result.text, /\[host context incomplete: failed\]$/);
  });

  check("context and image reads fail closed for symlink entries", () => {
    rmSync(join(root, `verify-${terminalId}.md`), { recursive: true, force: true });
    const contextTarget = join(root, "context-secret.md");
    writeFileSync(contextTarget, "secret context");
    symlinkSync(contextTarget, join(root, `verify-${terminalId}.md`));
    const context = host.readContextFilesResult(root, terminalId);
    assert.equal(context.state, "unreadable");
    assert.ok(!context.text.includes("secret context"));

    const imageRoot = join(root, "images");
    mkdirSync(imageRoot);
    const imageTarget = join(root, "image-secret.png");
    writeFileSync(imageTarget, Buffer.from("not-an-image"));
    symlinkSync(imageTarget, join(imageRoot, "session-img-1.png"));
    const image = host.expandFileImageSource(
      { type: "file", name: "session-img-1.png", media_type: "image/png" },
      [imageRoot],
    );
    assert.equal(image, null);
  });
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} host-output contract test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log("\nHost-output contract tests passed.");
}
