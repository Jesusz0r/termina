import { describe, expect, it } from "vitest";
import { CHALLENGE_PROFILES } from "../../../shared/types.ts";
import {
  isChallengeProfile,
  isFlushResult,
  isUnsavedConfirmResult,
  isWorldlineLabel,
  parsePtyAckPayload,
  parseRendererCapability,
  parseTerminalCreateOptions,
  parseTerminalTarget,
} from "../../../electron/main/ipc-validate.ts";

describe("IPC request-shape checks", () => {
  it("accepts challenge profiles and worldline labels only", () => {
    expect(isChallengeProfile(CHALLENGE_PROFILES[0])).toBe(true);
    expect(isChallengeProfile("not-a-profile")).toBe(false);
    expect(isWorldlineLabel("A")).toBe(true);
    expect(isWorldlineLabel("B")).toBe(true);
    expect(isWorldlineLabel("C")).toBe(false);
  });

  it("accepts flush and unsaved confirm shapes", () => {
    expect(isFlushResult({ ok: true, failed: [] })).toBe(true);
    expect(isFlushResult({ ok: false, failed: ["a.ts"] })).toBe(true);
    expect(isFlushResult({ ok: true, failed: [1] })).toBe(false);
    expect(isFlushResult({ ok: true })).toBe(false);
    expect(isUnsavedConfirmResult({ ok: true })).toBe(true);
    expect(isUnsavedConfirmResult({ ok: false, cancelled: true })).toBe(true);
    expect(isUnsavedConfirmResult({ ok: false, error: "x" })).toBe(true);
    expect(isUnsavedConfirmResult({ ok: true, cancelled: "no" })).toBe(false);
    const token = "11111111-1111-1111-1111-111111111111";
    expect(isUnsavedConfirmResult({ ok: true, discardDraftTokens: [] })).toBe(true);
    expect(isUnsavedConfirmResult({ ok: true, discardDraftTokens: Array(2000).fill(token) })).toBe(true);
    for (const discardDraftTokens of [null, token, [1], ["short"], Array(2001).fill(token)]) {
      expect(isUnsavedConfirmResult({ ok: true, discardDraftTokens })).toBe(false);
    }
  });

  it("parses renderer capabilities and PTY acks", () => {
    const capability = {
      windowGeneration: 1,
      rendererGeneration: 2,
      loadGeneration: 3,
      nonce: "n".repeat(16),
      processId: 4,
      frameRoutingId: 5,
    };
    expect(parseRendererCapability(capability)).toEqual(capability);
    expect(parseRendererCapability({ ...capability, nonce: "short" })).toBeNull();
    expect(parsePtyAckPayload({
      id: "term-1",
      generation: 1,
      windowGeneration: 2,
      rendererGeneration: 3,
      sequence: 4,
    })).toEqual({
      id: "term-1",
      generation: 1,
      windowGeneration: 2,
      rendererGeneration: 3,
      sequence: 4,
    });
    expect(parsePtyAckPayload({ id: "term-1", generation: 0, windowGeneration: 1, rendererGeneration: 1, sequence: 1 })).toBeNull();
  });

  it("requires an explicit terminal identity and positive generation", () => {
    expect(parseTerminalTarget("term-1", 2)).toEqual({ id: "term-1", generation: 2 });
    for (const id of [undefined, null, "", " ", "x".repeat(65), 1]) {
      expect(parseTerminalTarget(id, 1)).toBeNull();
    }
    for (const generation of [undefined, null, 0, -1, 1.5, Infinity, "1", Number.MAX_SAFE_INTEGER + 1]) {
      expect(parseTerminalTarget("term-1", generation)).toBeNull();
    }
  });

  it("shape-checks terminals:create options", () => {
    expect(parseTerminalCreateOptions(undefined)).toEqual({ ok: true, value: {} });
    expect(parseTerminalCreateOptions({ type: "agent", projectId: " proj-1 " })).toEqual({
      ok: true,
      value: { type: "agent", shell: undefined, engine: undefined, fromTerminalId: undefined, projectId: "proj-1" },
    });
    expect(parseTerminalCreateOptions("bad")).toEqual({ ok: false, error: "invalid terminal options" });
    expect(parseTerminalCreateOptions({ type: "pty" })).toEqual({ ok: false, error: "invalid terminal type" });
    expect(parseTerminalCreateOptions({ engine: "other" })).toEqual({ ok: false, error: "invalid agent engine" });
  });
});
