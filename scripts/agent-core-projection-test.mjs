/**
 * RED fixtures for the request-only working-set projection contract.
 *
 * The request-projection seam is intentionally loaded dynamically so the
 * suite reports a feature-level RED result before the private module exists.
 *
 *   node --experimental-strip-types --no-warnings scripts/agent-core-projection-test.mjs
 */
process.env.TERMINA_CORE_TEST = "1";

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import * as session from "../agent-core/session.ts";

const projectionModule = await import("../agent-core/request-projection.ts").catch(() => null);
const projectRequest = projectionModule?.projectRequest;
const projectPersistedMessages = projectionModule?.projectPersistedMessages;
const appendRequestOverlay = projectionModule?.appendRequestOverlay;
const buildRequestOverlay = projectionModule?.buildRequestOverlay;
const userPromptContent = projectionModule?.userPromptContent;

const results = [];
const pendingChecks = [];
const check = (name, fn) => {
  const pending = Promise.resolve()
    .then(fn)
    .then(
      () => {
        results.push(true);
        console.log(`PASS  ${name}`);
      },
      (err) => {
        results.push(false);
        console.log(`FAIL  ${name} — ${String(err?.message ?? err).slice(0, 320)}`);
      },
    );
  pendingChecks.push(pending);
};

const projection = (input) => {
  if (typeof projectRequest !== "function") {
    throw new Error("missing request projection implementation (expected P0 RED)");
  }
  const result = projectRequest(input);
  if (!result || typeof result !== "object") throw new Error("request projection returned no result");
  return result;
};

const requestMessages = (result) => {
  if (result?.ok !== true) throw new Error(result?.error ?? "request projection rejected input");
  if (!Array.isArray(result.messages)) throw new Error("projection result is missing messages");
  return result.messages;
};

const overlayFor = (messages, hostContext = "fresh host state", maxBytes = 64 * 1024) => {
  if (typeof buildRequestOverlay !== "function") {
    throw new Error("missing request overlay builder (expected P0 RED)");
  }
  return buildRequestOverlay({ messages, hostContext, maxBytes });
};

const persistedPrompt = (prompt, images = []) => {
  if (typeof userPromptContent !== "function") {
    throw new Error("missing canonical userPromptContent (expected P0 RED)");
  }
  return userPromptContent(prompt, images);
};

const serializedNeedle = (needle) => {
  const encoded = JSON.stringify(String(needle));
  return encoded ? encoded.slice(1, -1) : String(needle);
};

const countText = (value, needle) => {
  const source = String(value);
  const direct = source.split(String(needle)).length - 1;
  if (direct > 0) return direct;
  return source.split(serializedNeedle(needle)).length - 1;
};

const indexText = (value, needle) => {
  const source = String(value);
  const direct = source.indexOf(String(needle));
  return direct >= 0 ? direct : source.indexOf(serializedNeedle(needle));
};

function toolUse(id, name, path) {
  return { type: "tool_use", id, name, input: { path } };
}

function toolResult(id, content = "ok") {
  return { type: "tool_result", tool_use_id: id, content };
}

function message(role, content, sseq = 0) {
  return { role, content, sseq, tokens: 0 };
}

function inventoryMessages(paths, start = 1) {
  return paths.map((path, index) => message("assistant", [toolUse(`call-${start + index}`, "read_file", path)], start + index));
}

function jsonBytes(value) {
  return Buffer.from(JSON.stringify(value), "utf8");
}

const baseHistory = [
  message("user", "open the file", 1),
  message("assistant", [toolUse("call-1", "read_file", "src/entry.ts")], 2),
  message("user", [toolResult("call-1", "source")], 3),
  message("assistant", [{ type: "text", text: "I inspected it." }], 4),
];

check("new prompts persist the submitted prompt but not the volatile overlay", () => {
  // The third argument used to be a persisted working set. It must no longer
  // be part of the canonical userPromptContent API or the durable message.
  const persistedContent = persistedPrompt("open the file", [], "ignored legacy argument");
  assert.equal(JSON.stringify(persistedContent).includes("working-set"), false);
  const persisted = [message("user", persistedContent, 1)];
  const overlay = overlayFor(persisted);
  assert.ok(overlay);
  const request = requestMessages(projection({ messages: persisted, overlay }));
  assert.equal(JSON.stringify(persisted).includes("<working-set>"), false);
  assert.equal(countText(JSON.stringify(request), overlay.text), 1);
  assert.equal(persisted[0]?.content, "open the file");
});

check("request projection is stable byte-for-byte and reports the exact overlay hash", () => {
  const overlay = overlayFor(baseHistory);
  assert.ok(overlay);
  const first = projection({ messages: baseHistory, overlay });
  const second = projection({ messages: baseHistory, overlay });
  const firstRequest = jsonBytes(requestMessages(first));
  const secondRequest = jsonBytes(requestMessages(second));
  assert.deepEqual(firstRequest, secondRequest);
  assert.equal(first.overlay?.text, overlay.text);
  assert.equal(first.overlay?.bytes, Buffer.byteLength(overlay.text, "utf8"));
  assert.equal(first.overlay?.hash, createHash("sha256").update(Buffer.from(overlay.text, "utf8")).digest("hex"));
  assert.deepEqual(first.overlay, second.overlay);
});

check("persisted projection can be stamped before the overlay is appended", () => {
  assert.equal(typeof projectPersistedMessages, "function");
  assert.equal(typeof appendRequestOverlay, "function");
  const overlay = overlayFor(baseHistory);
  assert.ok(overlay);
  const persisted = projectPersistedMessages({ messages: baseHistory });
  assert.equal(persisted.ok, true);
  const stamped = persisted.messages.map((entry) => ({
    ...entry,
    content: typeof entry.content === "string"
      ? entry.content
      : entry.content.map((block) => ({ ...block, cache_control: { type: "ephemeral" } })),
  }));
  const assembled = appendRequestOverlay(stamped, overlay);
  assert.equal(assembled.length, stamped.length + 1);
  assert.equal(assembled.at(-1)?.content, overlay.text);
  assert.equal(JSON.stringify(assembled.at(-1)).includes("cache_control"), false);
});

check("caller-supplied overlays must carry exact metadata and fit the active cap", () => {
  const overlay = overlayFor([], "caller overlay");
  assert.ok(overlay);
  const exact = projection({ messages: [], overlay, maxBytes: overlay.bytes });
  assert.equal(exact.ok, true);
  assert.deepEqual(exact.overlay, overlay);

  const tooSmall = projection({ messages: [], overlay, maxBytes: overlay.bytes - 1 });
  assert.equal(tooSmall.ok, false);
  assert.match(tooSmall.error, /exceeds/);

  const tampered = projection({ messages: [], overlay: { ...overlay, bytes: overlay.bytes + 1 } });
  assert.equal(tampered.ok, false);
  assert.match(tampered.error, /bytes\/hash/);
});

check("inventory projection emits deterministic sorted paths and escapes XML", () => {
  const paths = ["z.ts", "a&b.ts", "m/<tag>.ts", "unicode/árbol.ts"];
  const overlay = overlayFor(inventoryMessages([...paths].reverse()), "");
  assert.ok(overlay);
  const readSection = overlay.text.match(/<read-files>\n([\s\S]*?)\n<\/read-files>/)?.[1] ?? "";
  const rows = readSection.split("\n").filter((row) => row && !row.startsWith("<!--"));
  assert.deepEqual(rows, ["a&amp;b.ts", "m/&lt;tag&gt;.ts", "unicode/árbol.ts", "z.ts"]);
  assert.equal(overlay.text.includes("a&b.ts"), false);
  assert.equal(overlay.text.includes("m/<tag>.ts"), false);
});

check("inventory boundary keeps all 40 entries without an omission marker", () => {
  const paths = Array.from({ length: 40 }, (_, i) => `src/file-${String(i).padStart(2, "0")}.ts`).reverse();
  const overlay = overlayFor(inventoryMessages(paths), "");
  assert.ok(overlay);
  const section = overlay.text.match(/<read-files>\n([\s\S]*?)\n<\/read-files>/)?.[1] ?? "";
  const rows = section.split("\n").filter(Boolean);
  assert.equal(rows.length, 40);
  assert.equal(section.includes("paths omitted"), false);
  assert.deepEqual(rows, paths.slice().sort());
});

check("inventory boundary marks exactly the 41st entry after the sorted first 40", () => {
  const paths = Array.from({ length: 41 }, (_, i) => `src/file-${String(i).padStart(2, "0")}.ts`).reverse();
  const overlay = overlayFor(inventoryMessages(paths), "");
  assert.ok(overlay);
  const section = overlay.text.match(/<read-files>\n([\s\S]*?)\n<\/read-files>/)?.[1] ?? "";
  const rows = section.split("\n").filter((row) => row && !row.startsWith("<!--"));
  assert.equal(rows.length, 40);
  assert.equal(section.includes("<!-- 1 paths omitted -->"), true);
  assert.deepEqual(rows, paths.slice().sort().slice(0, 40));
  assert.equal(section.includes("src/file-40.ts"), false);
});

check("overlay follows a complete tool-call/tool-result sequence", () => {
  const overlay = overlayFor(baseHistory);
  assert.ok(overlay);
  const request = requestMessages(projection({ messages: baseHistory, overlay }));
  const serialized = JSON.stringify(request);
  const callAt = indexText(serialized, "call-1");
  const resultAt = indexText(serialized, "source");
  const overlayAt = indexText(serialized, overlay.text);
  assert.ok(callAt >= 0 && resultAt > callAt && overlayAt > resultAt);
  const toolUseMessage = request.findIndex((m) => JSON.stringify(m).includes('"tool_use"'));
  const toolResultMessage = request.findIndex((m) => JSON.stringify(m).includes('"tool_result"'));
  const overlayMessage = request.findIndex((m) => indexText(JSON.stringify(m), overlay.text) >= 0);
  assert.ok(toolUseMessage >= 0 && toolResultMessage > toolUseMessage && overlayMessage > toolResultMessage);
});

check("two consecutive prompts each receive one fresh overlay without persistence", () => {
  const firstPersisted = [message("user", persistedPrompt("first"), 1)];
  const firstOverlay = overlayFor(firstPersisted, "first host state");
  assert.ok(firstOverlay);
  const firstRequest = requestMessages(projection({ messages: firstPersisted, overlay: firstOverlay }));

  const secondPersisted = [...firstPersisted, message("user", persistedPrompt("second"), 2)];
  const secondOverlay = overlayFor(secondPersisted, "second host state");
  assert.ok(secondOverlay);
  const secondRequest = requestMessages(projection({ messages: secondPersisted, overlay: secondOverlay }));

  assert.equal(countText(JSON.stringify(firstRequest), firstOverlay.text), 1);
  assert.equal(countText(JSON.stringify(secondRequest), secondOverlay.text), 1);
  assert.equal(JSON.stringify(firstPersisted).includes(firstOverlay.text), false);
  assert.equal(JSON.stringify(secondPersisted).includes(firstOverlay.text), false);
  assert.equal(JSON.stringify(secondPersisted).includes(secondOverlay.text), false);
});

const legacyBlock = "<working-set>\n<read-files>legacy.ts</read-files>\n</working-set>";
const legacyRecords = [
  { storageSeq: 1, type: "message", message: { role: "user", content: [{ type: "text", text: "resume" }, { type: "context", text: legacyBlock }] } },
  { storageSeq: 2, type: "message", message: { role: "assistant", content: [toolUse("legacy-call", "read_file", "legacy.ts")] } },
  { storageSeq: 3, type: "message", message: { role: "user", content: [toolResult("legacy-call", "legacy source")] } },
];

check("legacy persisted working-set content replays once and stays before the fresh overlay", () => {
  const replayed = session.replaySessionRecords(legacyRecords.map((record) => JSON.stringify(record)).join("\n") + "\n");
  assert.equal(replayed.ok, true);
  const overlay = overlayFor(replayed.messages, "fresh host state");
  assert.ok(overlay);
  const request = requestMessages(projection({ messages: replayed.messages, overlay }));
  const serialized = JSON.stringify(request);
  assert.equal(countText(serialized, legacyBlock), 1);
  assert.equal(countText(serialized, overlay.text), 1);
  assert.ok(indexText(serialized, legacyBlock) < indexText(serialized, overlay.text));
  assert.equal(JSON.stringify(replayed.messages).includes("fresh host state"), false);
});

check("legacy content survives resume, fork, and image materialization without projection duplication", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-core-projection-"));
  try {
    const source = session.coreSessionFile(root, "source");
    const dest = session.coreSessionFile(root, "fork");
    const prepared = session.prepareFreshSession(source);
    assert.equal(prepared.ok, true);
    writeFileSync(join(dirname(source), "resume-img-1.png"), Buffer.from("image-bytes"), { mode: 0o600 });
    const opened = session.SessionWriter.open(source, 0);
    assert.equal(opened.ok, true);
    const records = [
      { storageSeq: 1, type: "message", message: { role: "user", content: [{ type: "text", text: "resume" }, { type: "context", text: legacyBlock }, { type: "image", source: { type: "file", name: "resume-img-1.png", media_type: "image/png" } }] } },
      { storageSeq: 2, type: "message", message: { role: "assistant", content: [toolUse("fork-call", "read_file", "legacy.ts")] } },
      { storageSeq: 3, type: "message", message: { role: "user", content: [toolResult("fork-call", "legacy source")] } },
    ];
    for (const record of records) assert.equal(opened.writer.appendRecord(record).ok, true);
    opened.writer.close();
    const resumed = await session.replaySessionBundle(source);
    assert.equal(resumed.ok, true);
    assert.equal(resumed.messages.length, 3);
    const forked = await session.writeForkedSession(source, dest, 3);
    assert.equal(forked.ok, true);
    const forkReplay = await session.replaySessionBundle(dest);
    assert.equal(forkReplay.ok, true);
    assert.deepEqual(forkReplay.messages.map((m) => m.content), resumed.messages.map((m) => m.content));
    assert.equal(existsSync(join(dirname(dest), "resume-img-1.png")), true);
    const overlay = overlayFor(forkReplay.messages, "fresh host state");
    assert.ok(overlay);
    const request = requestMessages(projection({ messages: forkReplay.messages, overlay }));
    assert.equal(countText(JSON.stringify(request), legacyBlock), 1);
    assert.equal(countText(JSON.stringify(request), overlay.text), 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("compaction/revision replay leaves a safe prompt boundary for the fresh overlay", () => {
  const compacted = [
    { storageSeq: 1, type: "message", message: { role: "user", content: [{ type: "text", text: "old" }, { type: "context", text: legacyBlock }] } },
    { storageSeq: 2, type: "message", message: { role: "assistant", content: [toolUse("old-call", "read_file", "old.ts")] } },
    { storageSeq: 3, type: "message", message: { role: "user", content: [toolResult("old-call", "old source")] } },
    { storageSeq: 4, type: "revision", kind: "summarize", evicted: 3, summarySseq: 4, message: { role: "user", content: "<context-handoff>old task recovered</context-handoff>" } },
    { storageSeq: 5, type: "message", message: { role: "assistant", content: [{ type: "text", text: "continue" }] } },
  ];
  const replayed = session.replaySessionRecords(compacted.map((record) => JSON.stringify(record)).join("\n") + "\n");
  assert.equal(replayed.ok, true);
  assert.deepEqual(replayed.messages.map((m) => m.sseq), [4, 5]);
  const overlay = overlayFor(replayed.messages, "fresh host state");
  assert.ok(overlay);
  const request = requestMessages(projection({ messages: replayed.messages, overlay }));
  const serialized = JSON.stringify(request);
  assert.ok(serialized.indexOf("old task recovered") >= 0);
  assert.ok(indexText(serialized, overlay.text) > indexText(serialized, "continue"));
});

check("image and missing-image placeholders retain original user-turn order", () => {
  const imageRoot = mkdtempSync(join(tmpdir(), "agent-core-projection-images-"));
  try {
    writeFileSync(join(imageRoot, "first-img-1.png"), Buffer.from("first-image"), { mode: 0o600 });
    const persisted = [message("user", persistedPrompt("before", [
      { name: "first-img-1.png", mediaType: "image/png" },
      { name: "missing-img-2.png", mediaType: "image/png" },
    ]), 1)];
    const result = projection({ messages: persisted, overlay: null, imageRoots: [imageRoot] });
    const blocks = requestMessages(result)[0]?.content;
    assert.ok(Array.isArray(blocks));
    assert.deepEqual(blocks.map((block) => block.type), ["text", "image", "text"]);
    assert.equal(blocks[0].text, "before");
    assert.equal(blocks[2].text, "[image missing]");
    const serialized = JSON.stringify(requestMessages(result));
    assert.ok(serialized.indexOf("before") < serialized.indexOf("[image missing]"));
  } finally {
    rmSync(imageRoot, { recursive: true, force: true });
  }
});

check("incomplete or orphaned tool sequences fail closed before overlay injection", () => {
  const incomplete = [message("assistant", [toolUse("open-call", "read_file", "open.ts")], 1)];
  const overlay = overlayFor(incomplete, "fresh host state");
  assert.ok(overlay);
  const result = projection({ messages: incomplete, overlay });
  assert.equal(result.ok, false);
  assert.match(result.error, /incomplete tool-call sequence/);

  const orphan = [message("user", [toolResult("missing-call")], 1)];
  const orphanResult = projection({ messages: orphan, overlay });
  assert.equal(orphanResult.ok, false);
  assert.match(orphanResult.error, /no matching call/);
});

check("overlay cap preserves complete framing and never emits a replacement character", () => {
  const host = "🙂".repeat(20);
  const probe = overlayFor([], host, 100);
  assert.ok(probe);
  assert.ok(probe.bytes <= 100);
  assert.ok(probe.text.includes("🙂"));
  assert.ok(probe.text.includes("<!-- host context omitted -->"));
  assert.equal(probe.text.includes("\ufffd"), false);
  assert.equal(probe.text.startsWith("<working-set>\n"), true);
  assert.equal(probe.text.endsWith("\n</working-set>"), true);
  assert.equal(probe.hash, createHash("sha256").update(Buffer.from(probe.text, "utf8")).digest("hex"));
});

check("modified-file inventory is separate, sorted, and escaped", () => {
  const messages = [
    message("assistant", [
      { type: "tool_use", id: "write", name: "write_file", input: { path: "z&out.ts" } },
      { type: "tool_use", id: "edit", name: "edit", input: { path: "a<out.ts" } },
    ], 1),
    message("user", [toolResult("write"), toolResult("edit")], 2),
  ];
  const overlay = overlayFor(messages, "");
  assert.ok(overlay);
  const modified = overlay.text.match(/<modified-files>\n([\s\S]*?)\n<\/modified-files>/)?.[1] ?? "";
  assert.deepEqual(modified.split("\n"), ["a&lt;out.ts", "z&amp;out.ts"]);
});

check("completed tool IDs may be reused on a later turn but active IDs cannot collide", () => {
  const reused = [
    message("user", "first", 1),
    message("assistant", [toolUse("reused", "read_file", "first.ts")], 2),
    message("user", [toolResult("reused", "first result")], 3),
    message("assistant", [{ type: "text", text: "done" }], 4),
    message("user", "second", 5),
    message("assistant", [toolUse("reused", "read_file", "second.ts")], 6),
    message("user", [toolResult("reused", "second result")], 7),
  ];
  const overlay = overlayFor(reused, "fresh host state");
  assert.ok(overlay);
  assert.equal(projection({ messages: reused, overlay }).ok, true);

  const activeCollision = [
    message("assistant", [
      toolUse("active", "read_file", "first.ts"),
      toolUse("active", "read_file", "second.ts"),
    ], 1),
  ];
  const rejected = projection({ messages: activeCollision, overlay });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /duplicate active tool call id/);
});

check("inventory paths cannot inject rows or XML framing through CR/LF", () => {
  const messages = [
    message("assistant", [toolUse("newline", "read_file", "safe\r\n<injected>.ts")], 1),
    message("user", [toolResult("newline")], 2),
  ];
  const overlay = overlayFor(messages, "");
  assert.ok(overlay);
  const readSection = overlay.text.match(/<read-files>\n([\s\S]*?)\n<\/read-files>/)?.[1] ?? "";
  assert.deepEqual(readSection.split("\n"), ["safe&lt;injected&gt;.ts"]);
});

check("host and inventory content remove C1 XML controls without changing framing", () => {
  const host = "before\u0085after\u009f\nnext";
  const hostOverlay = overlayFor([], host);
  assert.ok(hostOverlay);
  assert.equal(hostOverlay.text.includes("\u0085"), false);
  assert.equal(hostOverlay.text.includes("\u009f"), false);
  assert.equal(hostOverlay.text.includes("beforeafter\nnext"), true);

  const messages = [
    message("assistant", [toolUse("c1", "read_file", "safe\u0085<path>.ts")], 1),
    message("user", [toolResult("c1")], 2),
  ];
  const inventoryOverlay = overlayFor(messages, "");
  assert.ok(inventoryOverlay);
  const section = inventoryOverlay.text.match(/<read-files>\n([\s\S]*?)\n<\/read-files>/)?.[1] ?? "";
  assert.deepEqual(section.split("\n"), ["safe&lt;path&gt;.ts"]);
});

await Promise.all(pendingChecks);
const failed = results.filter((value) => !value).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
