import { describe, expect, it } from "vitest";
import { parseSessionBlock, parseSessionMessage, parseStoredSessionRecord, sessionBlockHash } from "../../../agent-core/session.ts";
import { parseSessionMessageLine } from "../../../electron/session-search.ts";

const message = { role: "assistant", sseq: 1, content: [{ type: "tool_use", id: "call-1", name: "bash", input: { command: "pnpm run test:unit" } }] };

describe("canonical session message parser", () => {
  it.each([null, 42, "message", []])("rejects non-object message %j", (value) => {
    expect(parseSessionMessage(value).ok).toBe(false);
    expect(parseStoredSessionRecord(value).ok).toBe(false);
  });

  it("rejects missing role, sequence and block type at admission", () => {
    expect(parseSessionMessage({ sseq: 1, content: "text" }).ok).toBe(false);
    expect(parseSessionMessage({ role: "user", content: "text" }).ok).toBe(false);
    expect(parseSessionMessage({ ...message, content: [{}] }).ok).toBe(false);
    expect(parseSessionBlock([])).toBeNull();
    expect(parseSessionBlock({})).toBeNull();
    expect(parseStoredSessionRecord({ type: "message", message }).ok).toBe(false);
    expect(parseStoredSessionRecord({ storageSeq: 1, type: "message", message: { content: "text" } }).ok).toBe(false);
  });

  it("gives search the same typed tool-call message as replay", () => {
    const record = { storageSeq: 1, type: "message", message: { role: message.role, content: message.content } };
    const parsed = parseStoredSessionRecord(record);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.record?.type !== "message") throw new Error("fixture must be a message");
    expect(parsed.record.message).toEqual(message);
    expect(parseSessionMessageLine(JSON.stringify(record))?.text).toContain("[bash] pnpm run test:unit");
    expect(parseSessionMessageLine(JSON.stringify({ ...record, message: { content: "text" } }))).toBeNull();
  });

  it("preserves block JSON and hashes instead of normalizing stored fields", () => {
    const raw = { content: [{ text: "result", type: "text" }], extra: { retained: true }, type: "tool_result", tool_use_id: "call-1" };
    const parsed = parseSessionBlock(raw);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(raw));
    expect(sessionBlockHash(parsed)).toBe(sessionBlockHash(raw));
  });

  it("does not parse a future payload beyond the requested prefix", () => {
    expect(parseStoredSessionRecord({ storageSeq: 2, type: "message", message: [] }, 1)).toEqual({ ok: true, record: null });
    expect(parseStoredSessionRecord({ storageSeq: 2, type: "message", message: [] }).ok).toBe(false);
  });
});
