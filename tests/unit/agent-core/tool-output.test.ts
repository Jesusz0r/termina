import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Buffer } from "node:buffer";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as output from "../../../agent-core/tool-output.ts";
import * as core from "../../../agent-core/main.ts";
import * as host from "../../../agent-core/host.ts";
import * as mcp from "../../../agent-core/mcp.ts";

const {
  BoundedTextAccumulator,
  COMPLETION_STATES,
  boundText,
  boundedToolResult,
  readBoundedResponseBody,
} = output;

function shellArg(text: string) {
  return `'${String(text).replace(/'/g, `'\\''`)}'`;
}

function assertBoundedText(result: any, label: string) {
  expect(typeof result?.content).toBe("string");
  expect(result.outputBytes).toBe(Buffer.byteLength(result.content, "utf8"));
  expect(result.outputBytes).toBeLessThanOrEqual(result.limitBytes);
  expect(result.content).not.toContain("\uFFFD");
}

function responseWithChunks(chunks: any[], { contentLength, status = 200 }: { contentLength?: number; status?: number } = {}) {
  let cursor = 0;
  let reads = 0;
  let cancelReason: any;
  let released = false;
  const reader = {
    async read() {
      reads += 1;
      if (cursor >= chunks.length) return { done: true, value: undefined };
      const value = chunks[cursor++];
      return { done: false, value: value instanceof Uint8Array ? value : Buffer.from(value) };
    },
    async cancel(reason: any) {
      cancelReason = reason;
    },
    releaseLock() {
      released = true;
    },
  };
  const headerValue = contentLength === undefined ? null : String(contentLength);
  const response = {
    body: { getReader: () => reader },
    headers: {
      get(name: string) {
        return name.toLowerCase() === "content-length" ? headerValue : null;
      },
    },
    status,
    ok: status >= 200 && status < 300,
    text() {
      throw new Error("unbounded response.text() must not be called");
    },
    json() {
      throw new Error("unbounded response.json() must not be called");
    },
    arrayBuffer() {
      throw new Error("unbounded response.arrayBuffer() must not be called");
    },
  };
  return {
    response,
    control: {
      get reads() { return reads; },
      get cancelReason() { return cancelReason; },
      get released() { return released; },
    },
  };
}

describe("Agent Core Bounded Output Foundation", () => {
  describe("Pure Accumulator & Bounded Text Logic", () => {
    it("exposes every incomplete-walk outcome in completion states", () => {
      expect(COMPLETION_STATES).toEqual([
        "complete",
        "visit-cap",
        "timeout",
        "interrupted",
        "unreadable",
        "failed",
      ]);
    });

    it("head accumulator joins split UTF-8 without replacement bytes", () => {
      const input = Buffer.from("prefix-é-end", "utf8");
      const split = input.indexOf(0xc3) + 1;
      const accumulator = new BoundedTextAccumulator({
        maxBytes: 20,
        direction: "head",
        marker: "[truncated: continue]",
      });
      accumulator.push(input.subarray(0, split));
      accumulator.push(input.subarray(split));
      const result = accumulator.finish();

      expect(result.text).toBe("prefix-é-end");
      expect(result.truncated).toBe(false);
      expect(result.state).toBe("complete");
      expect(result.inputBytes).toBe(input.byteLength);
      expect(result.retainedBytes).toBe(input.byteLength);
      expect(result.omittedBytes).toBe(0);
      expect(result.outputBytes).toBe(Buffer.byteLength(result.text, "utf8"));
    });

    it("every split position preserves valid UTF-8 for head and tail streams", () => {
      const input = Buffer.from("ASCII-é-漢-🙂-終", "utf8");
      for (const direction of ["head", "tail"] as const) {
        for (let split = 0; split <= input.byteLength; split += 1) {
          const accumulator = new BoundedTextAccumulator({
            maxBytes: input.byteLength,
            direction,
            marker: "[truncated]",
          });
          accumulator.push(input.subarray(0, split));
          accumulator.push(input.subarray(split));
          const result = accumulator.finish();
          expect(result.text).toBe(input.toString("utf8"));
          expect(result.truncated).toBe(false);
          expect(result.inputBytes).toBe(input.byteLength);
          expect(result.outputBytes).toBe(input.byteLength);
          expect(result.text).not.toContain("\uFFFD");
        }
      }
    });

    it("head cap keeps a valid prefix and marks omission", () => {
      const input = Buffer.from("abé-0123456789", "utf8");
      const accumulator = new BoundedTextAccumulator({
        maxBytes: 12,
        direction: "head",
        marker: "[cut]",
      });
      accumulator.push(input.subarray(0, 3));
      accumulator.push(input.subarray(3));
      const result = accumulator.finish();

      expect(result.text).toBe("abé-0\n[cut]");
      expect(result.truncated).toBe(true);
      expect(result.inputBytes).toBe(input.byteLength);
      expect(result.retainedBytes).toBe(Buffer.byteLength("abé-0", "utf8"));
      expect(result.omittedBytes).toBe(input.byteLength - result.retainedBytes);
      expect(result.outputBytes).toBe(Buffer.byteLength(result.text, "utf8"));
      expect(result.outputBytes).toBeLessThanOrEqual(result.limitBytes);
      expect(result.text).not.toContain("\uFFFD");
    });

    it("tail accumulator keeps latest complete code points across chunks", () => {
      const input = Buffer.from("head-é-TAIL", "utf8");
      const split = input.indexOf(0xa9);
      const accumulator = new BoundedTextAccumulator({
        maxBytes: 10,
        direction: "tail",
        marker: "[cut]",
      });
      accumulator.push(input.subarray(0, split));
      accumulator.push(input.subarray(split, split + 1));
      accumulator.push(input.subarray(split + 1));
      const result = accumulator.finish();

      expect(result.text).toBe("TAIL\n[cut]");
      expect(result.truncated).toBe(true);
      expect(result.inputBytes).toBe(input.byteLength);
      expect(result.outputBytes).toBe(Buffer.byteLength(result.text, "utf8"));
      expect(result.outputBytes).toBeLessThanOrEqual(result.limitBytes);
      expect(result.text).not.toContain("\uFFFD");
    });

    it("exact UTF-8 boundary does not emit false omission marker", () => {
      const input = Buffer.from("éé", "utf8");
      const result = boundText(input, {
        maxBytes: input.byteLength,
        direction: "head",
        marker: "[truncated]",
      });

      expect(result.text).toBe("éé");
      expect(result.truncated).toBe(false);
      expect(result.outputBytes).toBe(input.byteLength);
      expect(result.omittedBytes).toBe(0);
    });

    it("marks an incomplete operation even when bytes fit", () => {
      const result = boundText("partial result", {
        maxBytes: 100,
        marker: (details) => `[state=${details.state}]`,
        state: "interrupted",
      });

      expect(result.state).toBe("interrupted");
      expect(result.truncated).toBe(true);
      expect(result.text).toMatch(/\[state=interrupted\]$/);
      expect(result.outputBytes).toBe(Buffer.byteLength(result.text, "utf8"));
    });

    it("provides final retained and omitted byte counts to marker callbacks", () => {
      let seen: any;
      const result = boundText("a".repeat(40), {
        maxBytes: 24,
        direction: "head",
        marker: (details) => {
          seen = details;
          return `[omitted=${details.omittedBytes}]`;
        },
      });

      expect(seen).toBeTruthy();
      expect(seen.inputBytes).toBe(result.inputBytes);
      expect(seen.retainedBytes).toBe(result.retainedBytes);
      expect(seen.omittedBytes).toBe(result.omittedBytes);
      expect(result.text).toMatch(new RegExp(`omitted=${result.omittedBytes}\\]$`));
      expect(result.outputBytes).toBe(Buffer.byteLength(result.text, "utf8"));
      expect(result.outputBytes).toBeLessThanOrEqual(result.limitBytes);
    });

    it("omits incomplete UTF-8 at stream end without replacement bytes", () => {
      const accumulator = new BoundedTextAccumulator({
        maxBytes: 32,
        direction: "head",
        marker: "[incomplete]",
      });
      accumulator.push("ok");
      accumulator.push(Uint8Array.of(0xe2, 0x82));
      const result = accumulator.finish();

      expect(result.text).toBe("ok\n[incomplete]");
      expect(result.inputBytes).toBe(4);
      expect(result.retainedBytes).toBe(2);
      expect(result.omittedBytes).toBe(2);
      expect(result.truncated).toBe(true);
      expect(result.outputBytes).toBe(Buffer.byteLength(result.text, "utf8"));
      expect(result.text).not.toContain("\uFFFD");
    });

    it("drops malformed UTF-8 as bounded omission while valid bytes survive", () => {
      const malformed = Uint8Array.of(0x41, 0xe2, 0x28, 0xa1, 0x42);
      const result = boundText(malformed, {
        maxBytes: 32,
        direction: "head",
        marker: "[malformed]",
      });

      expect(result.text).toBe("A(B\n[malformed]");
      expect(result.inputBytes).toBe(malformed.byteLength);
      expect(result.retainedBytes).toBe(3);
      expect(result.omittedBytes).toBe(2);
      expect(result.truncated).toBe(true);
      expect(result.outputBytes).toBe(Buffer.byteLength(result.text, "utf8"));
      expect(result.text).not.toContain("\uFFFD");
    });

    it("ensures finish is immutable and idempotent", () => {
      const accumulator = new BoundedTextAccumulator({ maxBytes: 32, direction: "tail" });
      accumulator.push("stable");
      const first = accumulator.finish();
      const second = accumulator.finish("complete");

      expect(second).toBe(first);
      expect(Object.isFrozen(first)).toBe(true);
      expect(() => accumulator.push("late")).toThrow(/finished/i);
      expect(() => {
        (first as any).text = "mutated";
      }).toThrow(TypeError);
    });

    it("bounded tool result preserves error status and exact accounting", () => {
      const result = boundedToolResult("x".repeat(100), {
        maxBytes: 24,
        direction: "tail",
        marker: "[re-run tool]",
        isError: true,
        state: "failed",
      });

      expect(result.content).toBe(result.text);
      expect(result.isError).toBe(true);
      expect(result.state).toBe("failed");
      expect(result.truncated).toBe(true);
      expect(result.outputBytes).toBe(Buffer.byteLength(result.content, "utf8"));
      expect(result.outputBytes).toBeLessThanOrEqual(result.limitBytes);
      expect(result.omittedBytes).toBeGreaterThan(0);
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("fails early on invalid accumulator limits", () => {
      expect(() => new BoundedTextAccumulator({ maxBytes: -1 })).toThrow(/maxBytes/i);
      expect(() => new BoundedTextAccumulator({ maxBytes: Number.NaN })).toThrow(/maxBytes/i);
      expect(() => new BoundedTextAccumulator({ maxBytes: 1.5 })).toThrow(/maxBytes/i);
    });
  });

  describe("Bounded Response Body Helper", () => {
    it("preserves UTF-8 split across stream chunks", async () => {
      const payload = Buffer.from("prefix-é-漢-🙂-suffix", "utf8");
      const chunks = [];
      for (let index = 0; index < payload.byteLength; index += 1) chunks.push(payload.subarray(index, index + 1));
      const { response, control } = responseWithChunks(chunks, { contentLength: payload.byteLength });
      const result = await readBoundedResponseBody(response as any, { maxBytes: payload.byteLength });

      expect(result.text).toBe(payload.toString("utf8"));
      expect(result.state).toBe("complete");
      expect(result.truncated).toBe(false);
      expect(result.inputBytes).toBe(payload.byteLength);
      expect(result.omittedBytes).toBe(0);
      expect(result.outputBytes).toBe(payload.byteLength);
      expect(control.cancelReason).toBeUndefined();
      expect(control.released).toBe(true);
    });

    it("cancels at cap and uses known length for omission", async () => {
      const payload = Buffer.from(`${"é".repeat(20_000)}-tail`, "utf8");
      const { response, control } = responseWithChunks([payload], { contentLength: payload.byteLength });
      const result = await readBoundedResponseBody(response as any, {
        maxBytes: 48,
        marker: (details) => `[omitted=${details.omittedBytes}]`,
      });

      expect(control.reads).toBe(1);
      expect(typeof control.cancelReason).toBe("string");
      expect(control.released).toBe(true);
      expect(result.state).toBe("complete");
      expect(result.truncated).toBe(true);
      expect(result.inputBytes).toBe(payload.byteLength);
      expect(result.omittedBytes).toBe(payload.byteLength - result.retainedBytes);
      expect(result.text).toMatch(new RegExp(`omitted=${result.omittedBytes}\\]$`));
      expect(result.outputBytes).toBe(Buffer.byteLength(result.text, "utf8"));
      expect(result.outputBytes).toBeLessThanOrEqual(result.limitBytes);
    });

    it("bounds HTTP error bodies safely", async () => {
      const payload = Buffer.from(`${"error-é-".repeat(4_000)}details`, "utf8");
      const { response } = responseWithChunks([payload], { contentLength: payload.byteLength, status: 503 });
      const result = await readBoundedResponseBody(response as any, {
        maxBytes: 64,
        state: "failed",
        marker: "[provider error body truncated]",
      });

      expect(response.ok).toBe(false);
      expect(response.status).toBe(503);
      expect(result.state).toBe("failed");
      expect(result.truncated).toBe(true);
      expect(result.inputBytes).toBe(payload.byteLength);
      expect(result.text).toMatch(/provider error body truncated/);
      expect(result.outputBytes).toBe(Buffer.byteLength(result.text, "utf8"));
      expect(result.outputBytes).toBeLessThanOrEqual(result.limitBytes);
    });
  });

  describe("Integration Seams (read_file, grep, glob, bash, host context, mcp)", () => {
    let integrationRoot: string;

    beforeAll(() => {
      integrationRoot = mkdtempSync(join(tmpdir(), "agent-core-output-integration-"));
    });

    afterAll(() => {
      rmSync(integrationRoot, { recursive: true, force: true });
    });

    it("read_file returns bounded UTF-8-safe content with continuation", () => {
      const readPath = join(integrationRoot, "read-é.txt");
      const payload = `${"r".repeat(40 * 1024)}éé`;
      writeFileSync(readPath, Buffer.from(payload, "utf8"));
      const result = core.readFileResult(readPath, 0);

      assertBoundedText(result, "read_file");
      expect(result.isError).toBe(false);
      expect(result.state).toBe("complete");
      expect(result.truncated).toBe(true);
      expect(result.content).toMatch(/truncated at .*read_file offset/);
      expect(typeof result.continuation).toBe("string");
      expect(result.repro?.startsWith("read_file(")).toBe(true);
    });

    it("glob respects count limits and emits continuation marker", async () => {
      const prefix = "glob-test";
      const globRoot = join(integrationRoot, prefix);
      mkdirSync(globRoot);
      for (let i = 0; i < 201; i++) {
        writeFileSync(join(globRoot, `f${String(i).padStart(4, "0")}.txt`), `${i}\n`);
      }
      const result = await core.globFiles(integrationRoot, `${prefix}/*.txt`, { budgetMs: 2_000 });
      assertBoundedText(result, "glob 201");
      expect(result.state).toBe("complete");
      expect(result.isError).toBe(false);
      expect(result.truncated).toBe(true);
      expect(typeof result.continuation).toBe("string");
      expect(result.content).toMatch(/more matching files not listed|Glob again/i);
    });

    it("bash preserves independent streams, exit status, and bounds", async () => {
      const script = [
        'const bytes=Buffer.from("é".repeat(15000),"utf8");',
        "process.stdout.write(bytes);",
        "process.stderr.write(bytes);",
      ].join("");
      const command = `${JSON.stringify(process.execPath)} -e ${shellArg(script)}`;
      const result = await core.runBash(command, {
        cwd: integrationRoot,
        timeoutMs: 3_000,
      });
      assertBoundedText(result, "bash");
      expect(result.state).toBe("complete");
      expect(result.isError).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(result.signal).toBeNull();
      expect(result.content).toMatch(/\[exit 0\]/);
      expect(result.stdout && result.stderr).toBeTruthy();
    });

    it("host context reads are bounded, marked, and UTF-8 safe", () => {
      const hostEvents = join(integrationRoot, "host-events");
      mkdirSync(hostEvents);
      const hostPayload = `${"c".repeat(64 * 1024)}é`;
      writeFileSync(join(hostEvents, "verify-term-output.md"), Buffer.from(hostPayload, "utf8"));

      const result = host.readContextFilesResult(hostEvents, "term-output");
      expect(result.state).toBe("complete");
      expect(result.truncated).toBe(true);
      expect(result.inputBytes).toBe(Buffer.byteLength(hostPayload, "utf8"));
      expect(result.outputBytes).toBe(Buffer.byteLength(result.text, "utf8"));
      expect(result.outputBytes).toBeLessThanOrEqual(result.limitBytes);
      expect(result.text).toMatch(/host context truncated/i);
      expect(result.text).not.toContain("\uFFFD");
    });

    it("MCP normalizes bounded UTF-8 text while preserving status", () => {
      const continuation = mcp.createMcpContinuation("output", "huge");
      const result = mcp.normalizeMcpCallResult(
        { isError: false, content: [{ type: "text", text: "m".repeat(20 * 1024) + "éé" }] },
        continuation,
      );
      assertBoundedText(result, "MCP success");
      expect(result.state).toBe("complete");
      expect(result.isError).toBe(false);
      expect(result.truncated).toBe(true);
      expect(result.continuation).toBe(continuation);
      expect(result.content).toMatch(/mcp output truncated|call again/i);
    });
  });
});
