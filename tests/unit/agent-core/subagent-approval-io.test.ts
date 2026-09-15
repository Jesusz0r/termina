import { describe, it, expect, afterAll } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendSubagentInboxMessage,
  clearSubagentApprovalFiles,
  parseSubagentApprovalName,
  readSubagentApprovalRequest,
  readSubagentInbox,
  subagentApprovalRequestName,
  subagentApprovalTimeoutMs,
  subagentInboxFileName,
  writeSubagentAckFile,
  writeSubagentApprovalRequest,
} from "../../../agent-core/subagents/approval.ts";
import {
  MAX_SUBAGENT_FILE_BYTES,
  MAX_SUBAGENT_INBOX_MSGS,
  MAX_SUBAGENT_MESSAGE_CHARS,
  appendSubagentInboxMessage as publicAppendInbox,
  writeSubagentApprovalRequest as publicWriteApproval,
} from "../../../agent-core/subagents.ts";

describe("subagent approval + inbox I/O", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });

  it("re-exports the same helpers from the public entry", () => {
    expect(publicWriteApproval).toBe(writeSubagentApprovalRequest);
    expect(publicAppendInbox).toBe(appendSubagentInboxMessage);
  });

  it("parses approval request names", () => {
    expect(parseSubagentApprovalName("term-7", "subagent-term-7-bg-1.approval-appr-1.json")).toEqual({ runId: "bg-1", reqId: "appr-1" });
    expect(parseSubagentApprovalName("term-7", "subagent-term-9-bg-1.approval-appr-1.json")).toBeNull();
    expect(parseSubagentApprovalName("term-7", "subagent-term-7-bg-1.inbox.json")).toBeNull();
    expect(parseSubagentApprovalName("term-7", "subagent-term-7-bg-1.approval-.json")).toBeNull();
  });

  it("clamps the approval timeout", () => {
    expect(subagentApprovalTimeoutMs({})).toBe(120_000);
    expect(subagentApprovalTimeoutMs({ TERMINA_SUBAGENT_APPROVAL_TIMEOUT_MS: "5000" })).toBe(5000);
    expect(subagentApprovalTimeoutMs({ TERMINA_SUBAGENT_APPROVAL_TIMEOUT_MS: "50" })).toBe(120_000);
    expect(subagentApprovalTimeoutMs({ TERMINA_SUBAGENT_APPROVAL_TIMEOUT_MS: "nope" })).toBe(120_000);
  });

  it("round-trips approval requests and rejects malformed ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "subagent-appr-"));
    roots.push(dir);
    expect(subagentApprovalRequestName("term-7", "bg-1", "appr-1")).toBe("subagent-term-7-bg-1.approval-appr-1.json");
    expect(subagentApprovalRequestName("../x", "bg-1", "appr-1")).toBeNull();
    const written = writeSubagentApprovalRequest(dir, "term-7", "bg-1", { reqId: "appr-1", kind: "bash", text: "rm -rf /" });
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    const read = readSubagentApprovalRequest(join(dir, written.file));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.file).toMatchObject({ runId: "bg-1", kind: "bash", text: "rm -rf /" });
    expect(writeSubagentApprovalRequest(dir, "term-7", "bg-1", { reqId: "appr-2", kind: "protected", text: "  " }).ok).toBe(false);
    expect(readSubagentApprovalRequest(join(dir, "missing.json")).ok).toBe(false);
    expect(writeSubagentAckFile(dir, "sub-term-7-bg-1", "appr-1", { ok: true })).toBe(true);
    expect(writeSubagentAckFile(dir, "../x", "appr-1", { ok: true })).toBe(false);
  });

  it("clears one terminal's approval files and nothing else", () => {
    const dir = mkdtempSync(join(tmpdir(), "subagent-clear-"));
    roots.push(dir);
    writeFileSync(join(dir, "subagent-term-7-bg-1.approval-appr-1.json"), "{}");
    writeFileSync(join(dir, "subagent-term-7-bg-1.task.json"), "{}");
    writeFileSync(join(dir, "subagent-term-9-bg-1.approval-appr-1.json"), "{}");
    expect(clearSubagentApprovalFiles(dir, "term-7")).toBe(1);
    expect(existsSync(join(dir, "subagent-term-7-bg-1.approval-appr-1.json"))).toBe(false);
    expect(existsSync(join(dir, "subagent-term-7-bg-1.task.json"))).toBe(true);
    expect(existsSync(join(dir, "subagent-term-9-bg-1.approval-appr-1.json"))).toBe(true);
    expect(clearSubagentApprovalFiles(dir, "term-7")).toBe(0);
    expect(clearSubagentApprovalFiles("/nonexistent-xyz", "term-7")).toBe(0);
    expect(clearSubagentApprovalFiles(dir, "../x")).toBe(0);
  });

  it("appends inbox messages with sequence numbers and a cap", () => {
    const dir = mkdtempSync(join(tmpdir(), "subagent-inbox-"));
    roots.push(dir);
    const first = appendSubagentInboxMessage(dir, "term-7", "bg-1", "hello");
    expect(first).toEqual({ ok: true, seq: 1 });
    const second = appendSubagentInboxMessage(dir, "term-7", "bg-1", "again");
    expect(second).toEqual({ ok: true, seq: 2 });
    expect(appendSubagentInboxMessage(dir, "term-7", "bg-1", "  ").ok).toBe(false);
    expect(appendSubagentInboxMessage(dir, "term-7", "bg-1", "x".repeat(MAX_SUBAGENT_MESSAGE_CHARS)).ok).toBe(true);
    expect(appendSubagentInboxMessage(dir, "term-7", "bg-1", "x".repeat(MAX_SUBAGENT_MESSAGE_CHARS + 1)).ok).toBe(false);
    const inbox = readSubagentInbox(dir, "term-7", "bg-1");
    expect(inbox?.messages.map((m) => [m.seq, m.text])).toEqual([
      [1, "hello"],
      [2, "again"],
      [3, "x".repeat(MAX_SUBAGENT_MESSAGE_CHARS)],
    ]);
    expect(readSubagentInbox(dir, "term-7", "bg-404")).toBeNull();
    for (let i = 0; i < MAX_SUBAGENT_INBOX_MSGS + 10; i++) appendSubagentInboxMessage(dir, "term-7", "bg-1", `m${i}`);
    expect(readSubagentInbox(dir, "term-7", "bg-1")?.messages.length).toBe(MAX_SUBAGENT_INBOX_MSGS);
  });

  it("caps approval and inbox reads before parsing (#222)", () => {
    const dir = mkdtempSync(join(tmpdir(), "subagent-appr-cap-"));
    roots.push(dir);
    const apprPath = join(dir, "subagent-term-7-bg-1.approval-big.json");
    writeFileSync(apprPath, "y".repeat(9000));
    expect(readSubagentApprovalRequest(apprPath)).toEqual({ ok: false, error: "oversize" });
    const inboxName = subagentInboxFileName("term-7", "bg-1");
    expect(inboxName).not.toBeNull();
    writeFileSync(join(dir, inboxName!), "z".repeat(MAX_SUBAGENT_FILE_BYTES + 1024));
    expect(readSubagentInbox(dir, "term-7", "bg-1")).toBeNull();
  });
});
