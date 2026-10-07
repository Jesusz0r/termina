import { describe, expect, it } from "vitest";
import { buildRequestOverlay, projectRequest, RequestOverlays } from "../../../agent-core/request-projection.ts";
import { responsesBody } from "../../../agent-core/openai-compat/responses.ts";
import { matchingInputPrefix } from "../../../scripts/prefix-measure.ts";
import type { KernelMessage } from "../../../agent-core/openai-compat/types.ts";

const user = (sseq: number, content = `prompt ${sseq}`) => ({ role: "user" as const, content, sseq });
const assistant = (sseq: number) => ({ role: "assistant" as const, content: "finished", sseq });
const overlay = (text: string) => buildRequestOverlay({ hostContext: text })!;
function request(messages: Parameters<typeof projectRequest>[0]["messages"], overlays: RequestOverlays) {
  const result = projectRequest({ messages, overlays });
  if (!result.ok) throw new Error(result.error);
  return result;
}
function input(messages: Parameters<typeof projectRequest>[0]["messages"], overlays: RequestOverlays) {
  return responsesBody("fixture", "fixed instructions", request(messages, overlays).messages as KernelMessage[], [], {}).input as unknown[];
}

describe("append-only request working sets", () => {
  it("keeps the complete previous wire input when a later prompt changes context", () => {
    const snapshots = new RequestOverlays();
    const messages = [user(1), assistant(2)];
    snapshots.capture(1, overlay("revision A"));
    const before = input(messages, snapshots);
    snapshots.capture(3, overlay("revision B"));
    const next = [...messages, user(3)];
    const after = input(next, snapshots);
    expect(matchingInputPrefix(before, after).items).toBe(before.length);
    expect(JSON.stringify(after)).toContain("revision A");
    expect(JSON.stringify(after)).toContain("revision B");
    expect(JSON.stringify(next)).not.toContain("working-set");
    expect(request(next, snapshots).persistedMessages).toHaveLength(3);
  });

  it("does not move context on tool turns or retries", () => {
    const snapshots = new RequestOverlays();
    snapshots.capture(1, overlay("snapshot"));
    const messages = [user(1)];
    const before = input(messages, snapshots);
    const next = [...messages,
      { role: "assistant" as const, sseq: 2, content: [{ type: "tool_use", id: "call", name: "read_file", input: { path: "file.ts" } }] },
      { role: "user" as const, sseq: 3, content: [{ type: "tool_result", tool_use_id: "call", content: "source" }] },
    ];
    const after = input(next, snapshots);
    expect(matchingInputPrefix(before, after).items).toBe(before.length);
    expect(input(next, snapshots)).toEqual(after);
    expect(request(next, snapshots).messages.filter(m => String(m.content).includes("working-set"))).toHaveLength(1);
  });

  it("removes evicted snapshots and counts all retained snapshot tokens", () => {
    const snapshots = new RequestOverlays();
    snapshots.capture(1, overlay("old"));
    snapshots.capture(3, overlay("new"));
    const messages = [user(1), assistant(2), user(3)];
    expect(snapshots.tokens(messages, () => 7)).toBe(14);
    snapshots.retain([user(3)]);
    expect(snapshots.tokens([user(3)], () => 7)).toBe(7);
    const projected = request([user(3)], snapshots);
    expect(JSON.stringify(projected.messages)).not.toContain("old");
    expect(JSON.stringify(projected.messages)).toContain("new");
  });

  it("evicts only missing anchors despite nonmonotonic handoff sequences", () => {
    const snapshots = new RequestOverlays();
    snapshots.capture(1, overlay("evicted snapshot"));
    snapshots.capture(3, overlay("retained snapshot"));
    const messages = [user(10, "<context-handoff>summary</context-handoff>"), user(3)];
    snapshots.retain(messages);
    const projected = JSON.stringify(request(messages, snapshots).messages);
    expect(projected).not.toContain("evicted snapshot");
    expect(projected).toContain("retained snapshot");
    expect(snapshots.tokens(messages, () => 7)).toBe(7);
  });

  it("records disappearing context without rewriting earlier snapshots", () => {
    const snapshots = new RequestOverlays();
    snapshots.capture(1, overlay("old snapshot"));
    const before = input([user(1), assistant(2)], snapshots);
    snapshots.capture(3, null);
    const after = input([user(1), assistant(2), user(3)], snapshots);
    expect(matchingInputPrefix(before, after).items).toBe(before.length);
    expect(JSON.stringify(after)).toContain("No current host context");
    const empty = new RequestOverlays();
    empty.capture(1, null);
    expect(request([user(1)], empty).messages).toHaveLength(1);
  });

  it("validates snapshot metadata, addresses, and immutable capture", () => {
    const snapshots = new RequestOverlays();
    const original = overlay("snapshot");
    expect(() => snapshots.capture(0, original)).toThrow(/storage sequence/);
    expect(() => snapshots.capture(1, { ...original, hash: "wrong" })).toThrow(/bytes\/hash/);
    snapshots.capture(1, original);
    original.text = "mutated caller";
    expect(JSON.stringify(request([user(1)], snapshots).messages)).toContain("snapshot");
    expect(() => snapshots.capture(1, overlay("replacement"))).toThrow(/already captured/);
    snapshots.clear();
    expect(request([user(1)], snapshots).messages).toHaveLength(1);
  });

  it("never inserts a snapshot between a tool call and result", () => {
    const snapshots = new RequestOverlays();
    snapshots.capture(3, overlay("invalid boundary"));
    const result = projectRequest({ overlays: snapshots, messages: [
      user(1),
      { role: "assistant", sseq: 2, content: [{ type: "tool_use", id: "call", name: "read_file", input: {} }] },
      { role: "user", sseq: 3, content: [{ type: "tool_result", tool_use_id: "call", content: "source" }] },
    ] });
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/prompt boundary/) });
  });
});
