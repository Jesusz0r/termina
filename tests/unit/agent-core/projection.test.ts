import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as session from "../../../agent-core/session.ts";

let projectRequest: any;
let projectPersistedMessages: any;
let appendRequestOverlay: any;
let buildRequestOverlay: any;
let userPromptContent: any;

function toolUse(id: string, name: string, path: string) {
  return { type: "tool_use", id, name, input: { path } };
}

function toolResult(id: string, content = "ok") {
  return { type: "tool_result", tool_use_id: id, content };
}

function message(role: string, content: any, sseq = 0) {
  return { role, content, sseq, tokens: 0 };
}

function inventoryMessages(paths: string[], start = 1) {
  return paths.map((path, index) => message("assistant", [toolUse(`call-${start + index}`, "read_file", path)], start + index));
}

function jsonBytes(value: any) {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function serializedNeedle(needle: string) {
  const encoded = JSON.stringify(String(needle));
  return encoded ? encoded.slice(1, -1) : String(needle);
}

function countText(value: any, needle: string) {
  const source = String(value);
  const direct = source.split(String(needle)).length - 1;
  if (direct > 0) return direct;
  return source.split(serializedNeedle(needle)).length - 1;
}

function indexText(value: any, needle: string) {
  const source = String(value);
  const direct = source.indexOf(String(needle));
  return direct >= 0 ? direct : source.indexOf(serializedNeedle(needle));
}

describe("Agent Core Request Projection & Volatile Overlays", () => {
  const baseHistory = [
    message("user", "open the file", 1),
    message("assistant", [toolUse("call-1", "read_file", "src/entry.ts")], 2),
    message("user", [toolResult("call-1", "source")], 3),
    message("assistant", [{ type: "text", text: "I inspected it." }], 4),
  ];

  beforeAll(async () => {
    process.env.TERMINA_CORE_TEST = "1";
    const mod = await import("../../../agent-core/request-projection.ts");
    projectRequest = mod.projectRequest;
    projectPersistedMessages = mod.projectPersistedMessages;
    appendRequestOverlay = mod.appendRequestOverlay;
    buildRequestOverlay = mod.buildRequestOverlay;
    userPromptContent = mod.userPromptContent;
  });

  const projection = (input: any) => {
    const result = projectRequest(input);
    expect(result).toBeTruthy();
    return result;
  };

  const requestMessages = (result: any) => {
    expect(result?.ok).toBe(true);
    expect(Array.isArray(result.messages)).toBe(true);
    return result.messages;
  };

  const overlayFor = (messages: any[], hostContext = "fresh host state", maxBytes = 64 * 1024) => {
    return buildRequestOverlay({ messages, hostContext, maxBytes });
  };

  it("persists submitted prompt but not volatile overlay", () => {
    const persistedContent = userPromptContent("open the file", [], "ignored host argument");
    expect(JSON.stringify(persistedContent)).not.toContain("working-set");
    const persisted = [message("user", persistedContent, 1)];
    const overlay = overlayFor(persisted);
    expect(overlay).toBeTruthy();
    const request = requestMessages(projection({ messages: persisted, overlay }));
    expect(JSON.stringify(persisted)).not.toContain("<working-set>");
    expect(countText(JSON.stringify(request), overlay.text)).toBe(1);
    expect(persisted[0]?.content).toBe("open the file");
  });

  it("produces byte-for-byte stable request projections and exact overlay hash", () => {
    const overlay = overlayFor(baseHistory);
    expect(overlay).toBeTruthy();
    const first = projection({ messages: baseHistory, overlay });
    const second = projection({ messages: baseHistory, overlay });
    const firstRequest = jsonBytes(requestMessages(first));
    const secondRequest = jsonBytes(requestMessages(second));
    expect(firstRequest).toEqual(secondRequest);
    expect(first.overlay?.text).toBe(overlay.text);
    expect(first.overlay?.bytes).toBe(Buffer.byteLength(overlay.text, "utf8"));
    expect(first.overlay?.hash).toBe(createHash("sha256").update(Buffer.from(overlay.text, "utf8")).digest("hex"));
    expect(first.overlay).toEqual(second.overlay);
  });

  it("stamps persisted projection before appending overlay", () => {
    const overlay = overlayFor(baseHistory);
    expect(overlay).toBeTruthy();
    const persisted = projectPersistedMessages({ messages: baseHistory });
    expect(persisted.ok).toBe(true);
    const stamped = persisted.messages.map((entry: any) => ({
      ...entry,
      content: typeof entry.content === "string"
        ? entry.content
        : entry.content.map((block: any) => ({ ...block, cache_control: { type: "ephemeral" } })),
    }));
    const assembled = appendRequestOverlay(stamped, overlay);
    expect(assembled.length).toBe(stamped.length + 1);
    expect(assembled.at(-1)?.content).toBe(overlay.text);
    expect(JSON.stringify(assembled.at(-1))).not.toContain("cache_control");
  });

  it("enforces exact metadata on caller-supplied overlays", () => {
    const overlay = overlayFor([], "caller overlay");
    expect(overlay).toBeTruthy();
    const exact = projection({ messages: [], overlay, maxBytes: overlay.bytes });
    expect(exact.ok).toBe(true);
    expect(exact.overlay).toEqual(overlay);

    const tooSmall = projection({ messages: [], overlay, maxBytes: overlay.bytes - 1 });
    expect(tooSmall.ok).toBe(false);
    expect(tooSmall.error).toMatch(/exceeds/);

    const tampered = projection({ messages: [], overlay: { ...overlay, bytes: overlay.bytes + 1 } });
    expect(tampered.ok).toBe(false);
    expect(tampered.error).toMatch(/bytes\/hash/);
  });

  it("does not duplicate file inventories into model requests", () => {
    const paths = ["z.ts", "a&b.ts", "m/<tag>.ts", "unicode/árbol.ts"];
    const messages = inventoryMessages(paths);
    expect(overlayFor(messages, "")).toBeNull();

    const overlay = overlayFor(messages, "fresh host state");
    expect(overlay).toBeTruthy();
    expect(overlay.text).toContain("fresh host state");
    expect(overlay.text).not.toContain("read-files");
    expect(overlay.text).not.toContain("modified-files");
    for (const path of paths) expect(overlay.text).not.toContain(path);
  });

  it("does not inject empty host context sections", () => {
    expect(overlayFor([], "")).toBeNull();
    expect(overlayFor([], " \n\t ")).toBeNull();
  });

  it("places overlay after complete tool-call/tool-result sequence", () => {
    const overlay = overlayFor(baseHistory);
    expect(overlay).toBeTruthy();
    const request = requestMessages(projection({ messages: baseHistory, overlay }));
    const serialized = JSON.stringify(request);
    const callAt = indexText(serialized, "call-1");
    const resultAt = indexText(serialized, "source");
    const overlayAt = indexText(serialized, overlay.text);
    expect(callAt).toBeGreaterThanOrEqual(0);
    expect(resultAt).toBeGreaterThan(callAt);
    expect(overlayAt).toBeGreaterThan(resultAt);
  });

  it("rejects persisted context blocks", () => {
    const persistedContext = "<working-set>\n<read-files>stale.ts</read-files>\n</working-set>";
    const result = projectPersistedMessages({
      messages: [message("user", [{ type: "text", text: "resume" }, { type: "context", text: persistedContext }], 1)],
    });
    expect(result).toEqual({ ok: false, error: "persisted context block at message 0 is unsupported" });
  });

  it("survives resume, fork, and image materialization without projection duplication", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-core-projection-"));
    try {
      const source = session.coreSessionFile(root, "source");
      const dest = session.coreSessionFile(root, "fork");
      const prepared = session.prepareFreshSession(source);
      expect(prepared.ok).toBe(true);
      writeFileSync(join(dirname(source), "resume-img-1.png"), Buffer.from("image-bytes"), { mode: 0o600 });
      const opened = session.SessionWriter.open(source, 0);
      expect(opened.ok).toBe(true);
      const records = [
        { storageSeq: 1, type: "message", message: { role: "user", content: [{ type: "text", text: "resume" }, { type: "image", source: { type: "file", name: "resume-img-1.png", media_type: "image/png" } }] } },
        { storageSeq: 2, type: "message", message: { role: "assistant", content: [toolUse("fork-call", "read_file", "current.ts")] } },
        { storageSeq: 3, type: "message", message: { role: "user", content: [toolResult("fork-call", "current source")] } },
      ];
      for (const record of records) expect(opened.writer.appendRecord(record).ok).toBe(true);
      opened.writer.close();
      const resumed = await session.replaySessionBundle(source);
      expect(resumed.ok).toBe(true);
      expect(resumed.messages.length).toBe(3);
      const forked = await session.writeForkedSession(source, dest, 3);
      expect(forked.ok).toBe(true);
      const forkReplay = await session.replaySessionBundle(dest);
      expect(forkReplay.ok).toBe(true);
      expect(forkReplay.messages.map((m: any) => m.content)).toEqual(resumed.messages.map((m: any) => m.content));
      expect(existsSync(join(dirname(dest), "resume-img-1.png"))).toBe(true);
      const overlay = overlayFor(forkReplay.messages, "fresh host state");
      expect(overlay).toBeTruthy();
      const request = requestMessages(projection({ messages: forkReplay.messages, overlay }));
      expect(countText(JSON.stringify(request), overlay.text)).toBe(1);
      expect(JSON.stringify(request)).toContain("current source");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed on incomplete or orphaned tool sequences before overlay injection", () => {
    const incomplete = [message("assistant", [toolUse("open-call", "read_file", "open.ts")], 1)];
    const overlay = overlayFor(incomplete, "fresh host state");
    expect(overlay).toBeTruthy();
    const result = projection({ messages: incomplete, overlay });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/incomplete tool-call sequence/);

    const orphan = [message("user", [toolResult("missing-call")], 1)];
    const orphanResult = projection({ messages: orphan, overlay });
    expect(orphanResult.ok).toBe(false);
    expect(orphanResult.error).toMatch(/no matching call/);
  });

  it("strips C1 controls from host context without altering framing", () => {
    const host = "before\u0085after\u009f\nnext";
    const hostOverlay = overlayFor([], host);
    expect(hostOverlay).toBeTruthy();
    expect(hostOverlay.text).not.toContain("\u0085");
    expect(hostOverlay.text).not.toContain("\u009f");
    expect(hostOverlay.text).toContain("beforeafter\nnext");
  });
});
