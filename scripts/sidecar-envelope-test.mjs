import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = await mkdtemp(join(tmpdir(), "termina-sidecar-envelope-"));
const bundle = join(root, "agent-core.mjs");
await build({ entryPoints: ["agent-core/main.ts"], bundle: true, platform: "node", format: "esm", outfile: bundle, logLevel: "silent" });
const { boundedSidecarEdits, SIDECAR_TOOL_EDIT_PREVIEW_BYTES } = await import(`${pathToFileURL(bundle).href}?${Date.now()}`);

try {
  const oldText = "old-".repeat(2 * 1024 * 1024);
  const newText = "new-".repeat(2 * 1024 * 1024);
  const bounded = boundedSidecarEdits([{ oldText, newText }]);
  const envelope = {
    bridgeId: "producer",
    seq: 1,
    t: "tool",
    toolName: "edit",
    path: "large.txt",
    toolCallId: "call-large",
    ...bounded,
  };
  assert.equal(envelope.editsTruncated, true, "oversized producer edits retain an explicit truncation boundary");
  assert.equal(envelope.editsBytes > 8 * 1024 * 1024, true, "probe input exceeds the tailer's historical record cap");
  assert.equal(typeof envelope.editsSha256, "string");
  assert.equal(envelope.editsCount, 1);
  assert.equal(Buffer.byteLength(JSON.stringify(envelope), "utf8") < 8 * 1024 * 1024, true, "bounded tool envelope stays below the sidecar record cap");
  assert.equal(Buffer.byteLength(JSON.stringify(envelope.edits), "utf8") <= SIDECAR_TOOL_EDIT_PREVIEW_BYTES, true);
  console.log("sidecar producer envelope checks passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
