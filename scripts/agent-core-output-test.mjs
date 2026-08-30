/**
 * Focused RED/GREEN contract tests for the pure bounded-output foundation.
 *
 * The pure section stays independent from the call sites. The integration
 * section below exercises the currently exported main.ts, host.ts, and mcp.ts
 * seams with deterministic temporary fixtures; missing modules/exports are
 * reported as failures rather than being silently skipped.
 *
 * Run with:
 *   node --experimental-strip-types --no-warnings scripts/agent-core-output-test.mjs
 */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TERMINA_CORE_TEST = "1";

let output;
let importError;
try {
  output = await import("../agent-core/tool-output.ts");
} catch (error) {
  importError = error;
}

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

if (!output) {
  console.log(`FAIL  bounded-output module loads — ${importError instanceof Error ? importError.message : String(importError)}`);
  failures.push({ name: "bounded-output module loads", error: importError });
} else {
  const {
    BoundedTextAccumulator,
    COMPLETION_STATES,
    boundText,
    boundedToolResult,
  } = output;

  check("completion states expose every incomplete-walk outcome", () => {
    assert.deepEqual(COMPLETION_STATES, [
      "complete",
      "visit-cap",
      "timeout",
      "interrupted",
      "unreadable",
      "failed",
    ]);
  });

  check("head accumulator joins split UTF-8 without replacement bytes", () => {
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

    assert.equal(result.text, "prefix-é-end");
    assert.equal(result.truncated, false);
    assert.equal(result.state, "complete");
    assert.equal(result.inputBytes, input.byteLength);
    assert.equal(result.retainedBytes, input.byteLength);
    assert.equal(result.omittedBytes, 0);
    assert.equal(result.outputBytes, Buffer.byteLength(result.text, "utf8"));
  });

  check("every split position preserves valid UTF-8 for head and tail streams", () => {
    const input = Buffer.from("ASCII-é-漢-🙂-終", "utf8");
    for (const direction of ["head", "tail"]) {
      for (let split = 0; split <= input.byteLength; split += 1) {
        const accumulator = new BoundedTextAccumulator({
          maxBytes: input.byteLength,
          direction,
          marker: "[truncated]",
        });
        accumulator.push(input.subarray(0, split));
        accumulator.push(input.subarray(split));
        const result = accumulator.finish();
        assert.equal(result.text, input.toString("utf8"), `${direction} split ${split}`);
        assert.equal(result.truncated, false, `${direction} split ${split}`);
        assert.equal(result.inputBytes, input.byteLength, `${direction} split ${split}`);
        assert.equal(result.outputBytes, input.byteLength, `${direction} split ${split}`);
        assert.ok(!result.text.includes("\uFFFD"), `${direction} split ${split}`);
      }
    }
  });

  check("head cap keeps a valid prefix and marks omission", () => {
    const input = Buffer.from("abé-0123456789", "utf8");
    const accumulator = new BoundedTextAccumulator({
      maxBytes: 12,
      direction: "head",
      marker: "[cut]",
    });
    accumulator.push(input.subarray(0, 3));
    accumulator.push(input.subarray(3));
    const result = accumulator.finish();

    assert.equal(result.text, "abé-0\n[cut]");
    assert.equal(result.truncated, true);
    assert.equal(result.inputBytes, input.byteLength);
    assert.equal(result.retainedBytes, Buffer.byteLength("abé-0", "utf8"));
    assert.equal(result.omittedBytes, input.byteLength - result.retainedBytes);
    assert.equal(result.outputBytes, Buffer.byteLength(result.text, "utf8"));
    assert.ok(result.outputBytes <= result.limitBytes);
    assert.ok(!result.text.includes("\uFFFD"));
  });

  check("tail accumulator keeps the latest complete code points across chunks", () => {
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

    assert.equal(result.text, "TAIL\n[cut]");
    assert.equal(result.truncated, true);
    assert.equal(result.inputBytes, input.byteLength);
    assert.equal(result.outputBytes, Buffer.byteLength(result.text, "utf8"));
    assert.ok(result.outputBytes <= result.limitBytes);
    assert.ok(!result.text.includes("\uFFFD"));
  });

  check("exact UTF-8 boundary does not emit a false omission marker", () => {
    const input = Buffer.from("éé", "utf8");
    const result = boundText(input, {
      maxBytes: input.byteLength,
      direction: "head",
      marker: "[truncated]",
    });

    assert.equal(result.text, "éé");
    assert.equal(result.truncated, false);
    assert.equal(result.outputBytes, input.byteLength);
    assert.equal(result.omittedBytes, 0);
  });

  check("an incomplete operation is marked even when its bytes fit", () => {
    const result = boundText("partial result", {
      maxBytes: 100,
      marker: (details) => `[state=${details.state}]`,
      state: "interrupted",
    });

    assert.equal(result.state, "interrupted");
    assert.equal(result.truncated, true);
    assert.match(result.text, /\[state=interrupted\]$/);
    assert.equal(result.outputBytes, Buffer.byteLength(result.text, "utf8"));
  });

  check("marker callbacks receive final retained and omitted byte counts", () => {
    let seen;
    const result = boundText("a".repeat(40), {
      maxBytes: 24,
      direction: "head",
      marker: (details) => {
        seen = details;
        return `[omitted=${details.omittedBytes}]`;
      },
    });

    assert.ok(seen);
    assert.equal(seen.inputBytes, result.inputBytes);
    assert.equal(seen.retainedBytes, result.retainedBytes);
    assert.equal(seen.omittedBytes, result.omittedBytes);
    assert.match(result.text, new RegExp(`omitted=${result.omittedBytes}\\]$`));
    assert.equal(result.outputBytes, Buffer.byteLength(result.text, "utf8"));
    assert.ok(result.outputBytes <= result.limitBytes);
  });

  check("incomplete UTF-8 at stream end is omitted without replacement bytes", () => {
    const accumulator = new BoundedTextAccumulator({
      maxBytes: 32,
      direction: "head",
      marker: "[incomplete]",
    });
    accumulator.push("ok");
    accumulator.push(Uint8Array.of(0xe2, 0x82));
    const result = accumulator.finish();

    assert.equal(result.text, "ok\n[incomplete]");
    assert.equal(result.inputBytes, 4);
    assert.equal(result.retainedBytes, 2);
    assert.equal(result.omittedBytes, 2);
    assert.equal(result.truncated, true);
    assert.equal(result.outputBytes, Buffer.byteLength(result.text, "utf8"));
    assert.ok(!result.text.includes("\uFFFD"));
  });

  check("malformed UTF-8 is dropped as bounded omission while valid bytes survive", () => {
    const malformed = Uint8Array.of(0x41, 0xe2, 0x28, 0xa1, 0x42);
    const result = boundText(malformed, {
      maxBytes: 32,
      direction: "head",
      marker: "[malformed]",
    });

    assert.equal(result.text, "A(B\n[malformed]");
    assert.equal(result.inputBytes, malformed.byteLength);
    assert.equal(result.retainedBytes, 3);
    assert.equal(result.omittedBytes, 2);
    assert.equal(result.truncated, true);
    assert.equal(result.outputBytes, Buffer.byteLength(result.text, "utf8"));
    assert.ok(!result.text.includes("\uFFFD"));
  });

  check("finish is immutable and idempotent", () => {
    const accumulator = new BoundedTextAccumulator({ maxBytes: 32, direction: "tail" });
    accumulator.push("stable");
    const first = accumulator.finish();
    const second = accumulator.finish("complete");

    assert.equal(second, first);
    assert.ok(Object.isFrozen(first));
    assert.throws(() => accumulator.push("late"), /finished/i);
    assert.throws(() => {
      first.text = "mutated";
    }, TypeError);
  });

  check("bounded tool result preserves error status and exact accounting", () => {
    const result = boundedToolResult("x".repeat(100), {
      maxBytes: 24,
      direction: "tail",
      marker: "[re-run tool]",
      isError: true,
      state: "failed",
    });

    assert.equal(result.content, result.text);
    assert.equal(result.isError, true);
    assert.equal(result.state, "failed");
    assert.equal(result.truncated, true);
    assert.equal(result.outputBytes, Buffer.byteLength(result.content, "utf8"));
    assert.ok(result.outputBytes <= result.limitBytes);
    assert.ok(result.omittedBytes > 0);
    assert.ok(Object.isFrozen(result));
  });

  check("custom markers remain UTF-8 safe when the total limit is tight", () => {
    const result = boundText("0123456789", {
      maxBytes: 9,
      direction: "head",
      marker: "é-marker",
    });

    assert.ok(result.truncated);
    assert.ok(result.outputBytes <= 9);
    assert.equal(result.outputBytes, Buffer.byteLength(result.text, "utf8"));
    assert.ok(!result.text.includes("\uFFFD"));
  });

  check("invalid accumulator limits fail before any bytes are accepted", () => {
    assert.throws(() => new BoundedTextAccumulator({ maxBytes: -1 }), /maxBytes/i);
    assert.throws(() => new BoundedTextAccumulator({ maxBytes: Number.NaN }), /maxBytes/i);
    assert.throws(() => new BoundedTextAccumulator({ maxBytes: 1.5 }), /maxBytes/i);
  });
}

let core;
let coreImportError;
try {
  core = await import("../agent-core/main.ts");
} catch (error) {
  coreImportError = error;
}
let host;
let hostImportError;
try {
  host = await import("../agent-core/host.ts");
} catch (error) {
  hostImportError = error;
}
let mcp;
let mcpImportError;
try {
  mcp = await import("../agent-core/mcp.ts");
} catch (error) {
  mcpImportError = error;
}

async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`FAIL  ${name} — ${error instanceof Error ? error.message : String(error)}`);
  }
}

function requireModule(module, label, importError) {
  if (module) return module;
  const reason = importError instanceof Error ? importError.message : String(importError);
  throw new Error(`${label} import failed: ${reason}`);
}

function requireExport(module, label, name, importError) {
  const loaded = requireModule(module, label, importError);
  assert.equal(typeof loaded[name], "function", `missing export ${label}.${name}`);
  return loaded[name];
}

function shellArg(text) {
  return `'${String(text).replace(/'/g, `'\\''`)}'`;
}

function assertBoundedText(result, label) {
  assert.equal(typeof result?.content, "string", `${label} content`);
  assert.equal(result.outputBytes, Buffer.byteLength(result.content, "utf8"), `${label} byte accounting`);
  assert.ok(result.outputBytes <= result.limitBytes, `${label} exceeds limit`);
  assert.ok(!result.content.includes("\uFFFD"), `${label} contains replacement bytes`);
}

function responseWithChunks(chunks, { contentLength, status = 200 } = {}) {
  let cursor = 0;
  let reads = 0;
  let cancelReason;
  let released = false;
  const reader = {
    async read() {
      reads += 1;
      if (cursor >= chunks.length) return { done: true, value: undefined };
      const value = chunks[cursor++];
      return { done: false, value: value instanceof Uint8Array ? value : Buffer.from(value) };
    },
    async cancel(reason) {
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
      get(name) {
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
      get reads() {
        return reads;
      },
      get cancelReason() {
        return cancelReason;
      },
      get released() {
        return released;
      },
    },
  };
}

await checkAsync("bounded response-body helper is exported", () => {
  requireExport(output, "tool-output.ts", "readBoundedResponseBody", importError);
});

await checkAsync("response-body helper preserves UTF-8 split across stream chunks", async () => {
  const readBoundedResponseBody = requireExport(output, "tool-output.ts", "readBoundedResponseBody", importError);
  const payload = Buffer.from("prefix-é-漢-🙂-suffix", "utf8");
  const chunks = [];
  for (let index = 0; index < payload.byteLength; index += 1) chunks.push(payload.subarray(index, index + 1));
  const { response, control } = responseWithChunks(chunks, { contentLength: payload.byteLength });
  const result = await readBoundedResponseBody(response, { maxBytes: payload.byteLength });

  assert.equal(result.text, payload.toString("utf8"));
  assert.equal(result.state, "complete");
  assert.equal(result.truncated, false);
  assert.equal(result.inputBytes, payload.byteLength);
  assert.equal(result.omittedBytes, 0);
  assert.equal(result.outputBytes, payload.byteLength);
  assert.equal(control.cancelReason, undefined);
  assert.equal(control.released, true);
});

await checkAsync("response-body helper cancels at the cap and uses known length for omission", async () => {
  const readBoundedResponseBody = requireExport(output, "tool-output.ts", "readBoundedResponseBody", importError);
  const payload = Buffer.from(`${"é".repeat(20_000)}-tail`, "utf8");
  const { response, control } = responseWithChunks([payload], { contentLength: payload.byteLength });
  const result = await readBoundedResponseBody(response, {
    maxBytes: 48,
    marker: (details) => `[omitted=${details.omittedBytes}]`,
  });

  assert.equal(control.reads, 1);
  assert.equal(typeof control.cancelReason, "string");
  assert.equal(control.released, true);
  assert.equal(result.state, "complete");
  assert.equal(result.truncated, true);
  assert.equal(result.inputBytes, payload.byteLength);
  assert.equal(result.omittedBytes, payload.byteLength - result.retainedBytes);
  assert.match(result.text, new RegExp(`omitted=${result.omittedBytes}\\]$`));
  assert.equal(result.outputBytes, Buffer.byteLength(result.text, "utf8"));
  assert.ok(result.outputBytes <= result.limitBytes);
});

await checkAsync("response-body helper can bound an HTTP error body without consulting status helpers", async () => {
  const readBoundedResponseBody = requireExport(output, "tool-output.ts", "readBoundedResponseBody", importError);
  const payload = Buffer.from(`${"error-é-".repeat(4_000)}details`, "utf8");
  const { response } = responseWithChunks([payload], { contentLength: payload.byteLength, status: 503 });
  const result = await readBoundedResponseBody(response, {
    maxBytes: 64,
    state: "failed",
    marker: "[provider error body truncated]",
  });

  assert.equal(response.ok, false);
  assert.equal(response.status, 503);
  assert.equal(result.state, "failed");
  assert.equal(result.truncated, true);
  assert.equal(result.inputBytes, payload.byteLength);
  assert.match(result.text, /provider error body truncated/);
  assert.equal(result.outputBytes, Buffer.byteLength(result.text, "utf8"));
  assert.ok(result.outputBytes <= result.limitBytes);
});

await checkAsync("response-body helper never falls back to unbounded body methods", async () => {
  const readBoundedResponseBody = requireExport(output, "tool-output.ts", "readBoundedResponseBody", importError);
  const calls = [];
  const response = {
    body: null,
    headers: {
      get(name) {
        return name.toLowerCase() === "content-length" ? "not-a-safe-length" : null;
      },
    },
    text() {
      calls.push("text");
      return Promise.resolve("unbounded");
    },
    json() {
      calls.push("json");
      return Promise.resolve({ unbounded: true });
    },
    arrayBuffer() {
      calls.push("arrayBuffer");
      return Promise.resolve(Buffer.from("unbounded"));
    },
  };
  const result = await readBoundedResponseBody(response, {
    maxBytes: 32,
    marker: "[response body unavailable]",
  });

  assert.deepEqual(calls, []);
  assert.equal(result.state, "failed");
  assert.equal(result.truncated, true);
  assert.equal(result.inputBytes, 0);
  assert.equal(result.omittedBytes, 0);
  assert.match(result.text, /response body unavailable/);
  assert.equal(result.outputBytes, Buffer.byteLength(result.text, "utf8"));
  assert.ok(result.outputBytes <= result.limitBytes);
});

await checkAsync("response-body helper accepts a declared empty body without a stream", async () => {
  const readBoundedResponseBody = requireExport(output, "tool-output.ts", "readBoundedResponseBody", importError);
  const result = await readBoundedResponseBody({
    body: null,
    headers: { get: () => "0" },
    status: 204,
  }, { maxBytes: 32 });

  assert.equal(result.text, "");
  assert.equal(result.state, "complete");
  assert.equal(result.truncated, false);
  assert.equal(result.inputBytes, 0);
  assert.equal(result.omittedBytes, 0);
});

const integrationRoot = mkdtempSync(join(tmpdir(), "agent-core-output-integration-"));
try {
  await checkAsync("main exports every bounded tool integration seam", () => {
    for (const name of ["readFileResult", "fetchUrl", "grepFiles", "globFiles", "runBash", "collectFiles"]) {
      requireExport(core, "main.ts", name, coreImportError);
    }
  });

  await checkAsync("read_file returns bounded UTF-8-safe content with continuation", () => {
    const readPath = join(integrationRoot, "read-é.txt");
    const payload = `${"r".repeat(40 * 1024)}éé`;
    writeFileSync(readPath, Buffer.from(payload, "utf8"));
    const result = requireExport(core, "main.ts", "readFileResult", coreImportError)(readPath, 0);

    assertBoundedText(result, "read_file");
    assert.equal(result.isError, false);
    assert.equal(result.state, "complete");
    assert.equal(result.truncated, true);
    assert.match(result.content, /truncated at .*read_file offset/);
    assert.equal(typeof result.continuation, "string");
    assert.ok(result.repro?.startsWith("read_file("));
  });

  await checkAsync("fetch returns bounded UTF-8-safe content without localhost", async () => {
    const previousFetch = globalThis.fetch;
    const payload = Buffer.from(`${"f".repeat(20 * 1024)}éé`, "utf8");
    globalThis.fetch = async () => new Response(payload, {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
    try {
      const result = await requireExport(core, "main.ts", "fetchUrl", coreImportError)(
        "https://provider.invalid/output",
        { timeoutMs: 1_000 },
      );
      assertBoundedText(result, "fetch");
      assert.equal(result.isError, false);
      assert.equal(result.state, "complete");
      assert.equal(result.truncated, true);
      assert.equal(typeof result.continuation, "string");
      assert.ok(result.repro?.startsWith("fetch 'https://provider.invalid"));
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  const grepRoot = join(integrationRoot, "grep-fixture");
  mkdirSync(grepRoot);
  writeFileSync(join(grepRoot, "é-match.txt"), "first needle é\nsecond line\n");
  writeFileSync(join(grepRoot, "other.txt"), "nothing here\n");

  await checkAsync("fallback grep returns bounded matches and UTF-8-safe metadata", async () => {
    const result = await requireExport(core, "main.ts", "grepFiles", coreImportError)(
      integrationRoot,
      { pattern: "needle", path: "grep-fixture" },
      { jsOnly: true, budgetMs: 1_000 },
    );
    assertBoundedText(result, "grep");
    assert.equal(result.state, "complete");
    assert.equal(result.isError, false);
    assert.match(result.content, /é-match\.txt/);
    assert.match(result.content, /needle/);
  });

  await checkAsync("fallback grep propagates timeout instead of reporting no matches", async () => {
    const result = await requireExport(core, "main.ts", "grepFiles", coreImportError)(
      integrationRoot,
      { pattern: "needle", path: "grep-fixture" },
      { jsOnly: true, budgetMs: 0 },
    );
    assertBoundedText(result, "grep timeout");
    assert.equal(result.state, "timeout");
    assert.equal(result.isError, true);
    assert.match(result.content, /grep timeout/i);
    assert.notEqual(result.content, "(no matches)");
    assert.equal(typeof result.continuation, "string");
  });

  await checkAsync("fallback grep propagates user interruption", async () => {
    const result = await requireExport(core, "main.ts", "grepFiles", coreImportError)(
      integrationRoot,
      { pattern: "needle", path: "grep-fixture" },
      { jsOnly: true, budgetMs: 1_000, shouldStop: () => true },
    );
    assertBoundedText(result, "grep interruption");
    assert.equal(result.state, "interrupted");
    assert.equal(result.isError, true);
    assert.match(result.content, /grep interrupted/i);
    assert.notEqual(result.content, "(no matches)");
  });

  await checkAsync("collectFiles preserves the visit-cap completion state", async () => {
    const result = await requireExport(core, "main.ts", "collectFiles", coreImportError)(
      grepRoot,
      integrationRoot,
      1,
      { budgetMs: 1_000 },
    );
    assert.equal(result.state, "visit-cap");
    assert.equal(result.hitCap, true);
    assert.equal(result.timedOut, false);
  });

  const glob = requireExport(core, "main.ts", "globFiles", coreImportError);
  const globPrefixes = new Map();
  for (const count of [199, 200, 201]) {
    const prefix = `glob-${count}`;
    const globRoot = join(integrationRoot, prefix);
    mkdirSync(globRoot);
    globPrefixes.set(count, prefix);
    for (let index = 0; index < count; index += 1) {
      writeFileSync(join(globRoot, `f${String(index).padStart(4, "0")}.txt`), `${index}\n`);
    }
  }
  const countGlobFiles = (text, prefix) => text.split("\n").filter((line) => line.startsWith(`${prefix}/f`) && line.endsWith(".txt")).length;

  await checkAsync("glob emits exactly 199 matches without a false marker", async () => {
    const prefix = globPrefixes.get(199);
    const result = await glob(integrationRoot, `${prefix}/*.txt`, { budgetMs: 1_000 });
    assertBoundedText(result, "glob 199");
    assert.equal(result.state, "complete");
    assert.equal(result.isError, false);
    assert.equal(countGlobFiles(result.content, prefix), 199);
    assert.equal(result.truncated, false);
    assert.equal(result.continuation, null);
  });

  await checkAsync("glob emits exactly 200 matches without a false marker", async () => {
    const prefix = globPrefixes.get(200);
    const result = await glob(integrationRoot, `${prefix}/*.txt`, { budgetMs: 1_000 });
    assertBoundedText(result, "glob 200");
    assert.equal(result.state, "complete");
    assert.equal(result.isError, false);
    assert.equal(countGlobFiles(result.content, prefix), 200);
    assert.equal(result.truncated, false);
    assert.equal(result.continuation, null);
  });

  await checkAsync("glob emits 200 matches and marks the 201st omission", async () => {
    // The fixture contains 201 eligible matches; the page is therefore the
    // 200-item visible cap plus an actionable continuation marker.
    const prefix = globPrefixes.get(201);
    const result = await glob(integrationRoot, `${prefix}/*.txt`, { budgetMs: 1_000 });
    assertBoundedText(result, "glob 201");
    assert.equal(result.state, "complete");
    assert.equal(result.isError, false);
    assert.equal(countGlobFiles(result.content, prefix), 200);
    assert.equal(result.truncated, true);
    assert.equal(typeof result.continuation, "string");
    assert.match(result.content, /more matching files not listed|Glob again/i);
  });

  await checkAsync("bash preserves independent streams, exit status, and bounds", async () => {
    const script = [
      'const bytes=Buffer.from("é".repeat(15000),"utf8");',
      "process.stdout.write(bytes);",
      "process.stderr.write(bytes);",
    ].join("");
    const command = `${JSON.stringify(process.execPath)} -e ${shellArg(script)}`;
    const result = await requireExport(core, "main.ts", "runBash", coreImportError)(command, {
      cwd: integrationRoot,
      timeoutMs: 2_000,
    });
    assertBoundedText(result, "bash");
    assert.equal(result.state, "complete");
    assert.equal(result.isError, false);
    assert.equal(result.exitCode, 0);
    assert.equal(result.signal, null);
    assert.match(result.content, /\[exit 0\]/);
    assert.ok(result.stdout && result.stderr);
    for (const [label, stream] of [["stdout", result.stdout], ["stderr", result.stderr]]) {
      assert.equal(stream.outputBytes, Buffer.byteLength(stream.text, "utf8"), `${label} accounting`);
      assert.ok(stream.outputBytes <= stream.limitBytes, `${label} exceeds limit`);
      assert.equal(stream.truncated, true, `${label} should be truncated`);
      assert.ok(stream.inputBytes > stream.retainedBytes, `${label} omission is not accounted`);
      assert.ok(!stream.text.includes("\uFFFD"), `${label} contains replacement bytes`);
    }
  });

  await checkAsync("bash preserves a nonzero exit separately from bounded output", async () => {
    const result = await requireExport(core, "main.ts", "runBash", coreImportError)(
      "printf out; printf err >&2; exit 7",
      { cwd: integrationRoot, timeoutMs: 1_000 },
    );
    assertBoundedText(result, "bash failure");
    assert.equal(result.state, "failed");
    assert.equal(result.isError, true);
    assert.equal(result.exitCode, 7);
    assert.equal(result.signal, null);
    assert.match(result.content, /out/);
    assert.match(result.content, /err/);
    assert.match(result.content, /\[exit 7\]/);
  });

  const hostEvents = join(integrationRoot, "host-events");
  mkdirSync(hostEvents);
  const hostPayload = `${"c".repeat(64 * 1024)}é`;
  writeFileSync(join(hostEvents, "verify-term-output.md"), Buffer.from(hostPayload, "utf8"));

  await checkAsync("host context reads are bounded, marked, and UTF-8 safe", () => {
    const result = requireExport(host, "host.ts", "readContextFilesResult", hostImportError)(
      hostEvents,
      "term-output",
    );
    assert.equal(result.state, "complete");
    assert.equal(result.truncated, true);
    assert.equal(result.inputBytes, Buffer.byteLength(hostPayload, "utf8"));
    assert.equal(result.outputBytes, Buffer.byteLength(result.text, "utf8"));
    assert.ok(result.outputBytes <= result.limitBytes);
    assert.match(result.text, /host context truncated/i);
    assert.ok(!result.text.includes("\uFFFD"));
  });

  await checkAsync("host context propagates interruption state", () => {
    const result = requireExport(host, "host.ts", "readContextFilesResult", hostImportError)(
      hostEvents,
      "term-output",
      { shouldStop: () => true },
    );
    assert.equal(result.state, "interrupted");
    assert.equal(result.truncated, true);
    assert.match(result.text, /host context incomplete: interrupted/i);
  });

  await checkAsync("MCP normalizes bounded UTF-8 text while retaining success status", () => {
    const continuation = requireExport(mcp, "mcp.ts", "createMcpContinuation", mcpImportError)("output", "huge");
    const normalize = requireExport(mcp, "mcp.ts", "normalizeMcpCallResult", mcpImportError);
    const result = normalize({ isError: false, content: [{ type: "text", text: "m".repeat(20 * 1024) + "éé" }] }, continuation);
    assertBoundedText(result, "MCP success");
    assert.equal(result.state, "complete");
    assert.equal(result.isError, false);
    assert.equal(result.truncated, true);
    assert.equal(result.continuation, continuation);
    assert.match(result.content, /mcp output truncated|call again/i);
  });

  await checkAsync("MCP preserves error status while bounding output", () => {
    const continuation = requireExport(mcp, "mcp.ts", "createMcpContinuation", mcpImportError)("output", "huge-error");
    const normalize = requireExport(mcp, "mcp.ts", "normalizeMcpCallResult", mcpImportError);
    const result = normalize({ isError: true, content: [{ type: "text", text: "m".repeat(20 * 1024) + "éé" }] }, continuation);
    assertBoundedText(result, "MCP error");
    assert.equal(result.state, "complete");
    assert.equal(result.isError, true);
    assert.equal(result.truncated, true);
    assert.equal(result.continuation, continuation);
    assert.ok(!result.content.includes("\uFFFD"));
  });
} finally {
  rmSync(integrationRoot, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} bounded-output contract test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log("\nPure and integration bounded-output contract tests passed.");
}
