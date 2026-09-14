import { afterAll, describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describePromptPayloadFailure,
  readPromptPayloadFile,
  readPromptPayloadResult,
} from "../../../electron/prompt-payload.ts";
import type { ReadPromptResult } from "../../../electron/session-fork.ts";

const failingWorker = async (): Promise<ReadPromptResult> => ({ ok: false, error: "worker gone" });

describe("prompt payload error channel (issue #248)", () => {
  const work = mkdtempSync(join(tmpdir(), "termina-payload-read-"));

  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it("classifies missing, oversize, malformed, and valid empty", async () => {
    expect(await readPromptPayloadResult(join(work, "nope.json"), { maxBytes: 1024, offload: failingWorker }))
      .toEqual({ ok: false, reason: "missing" });
    expect(describePromptPayloadFailure("missing")).toBe("the prompt payload is unavailable");

    const over = join(work, "over.json");
    writeFileSync(over, JSON.stringify({ prompt: "x".repeat(2048) }));
    expect(await readPromptPayloadResult(over, { maxBytes: 1024, offload: failingWorker }))
      .toEqual({ ok: false, reason: "oversize" });
    expect(describePromptPayloadFailure("oversize")).toBe("the prompt payload exceeds the 20 MB budget");

    const bad = join(work, "bad.json");
    writeFileSync(bad, "{oops");
    expect(await readPromptPayloadResult(bad, { maxBytes: 1024 * 1024, offload: failingWorker }))
      .toEqual({ ok: false, reason: "malformed" });
    expect(describePromptPayloadFailure("malformed")).toBe("the prompt payload is unreadable");

    const dir = join(work, "not-a-file");
    mkdirSync(dir);
    expect(await readPromptPayloadResult(dir, { maxBytes: 1024, offload: failingWorker }))
      .toEqual({ ok: false, reason: "not-a-file" });

    const empty = join(work, "empty.json");
    writeFileSync(empty, JSON.stringify({ prompt: "", images: [], context: "" }));
    expect(await readPromptPayloadResult(empty, { maxBytes: 1024 * 1024, offload: failingWorker }))
      .toEqual({ ok: true, payload: { text: "", images: [], context: "" } });

    expect(await readPromptPayloadFile(bad, { maxBytes: 1024 * 1024, offload: failingWorker })).toBeNull();
  });

  it("maps a worker fail-closed miss to unreadable without inventing absence", async () => {
    const file = join(work, "present.json");
    writeFileSync(file, JSON.stringify({ prompt: "task", images: [], context: "" }));
    const offload = async (): Promise<ReadPromptResult> => ({ ok: true, found: false });
    expect(await readPromptPayloadResult(file, { maxBytes: 1024 * 1024, offload }))
      .toEqual({ ok: false, reason: "unreadable" });
    expect(await readPromptPayloadFile(file, { maxBytes: 1024 * 1024, offload })).toBeNull();
  });
});
