import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const calibration = await import("./agent-core-token-calibration.mjs");
const { calibrateSamples, readCalibrationInput, renderCalibrationReport } = calibration;

const root = mkdtempSync(join(tmpdir(), "agent-core-token-calibration-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

const fixture = {
  samples: [
    { id: "code-a", class: "code", provider: "openai", model: "model-a", value: "abcd", providerInputTokens: 2 },
    { id: "prose-a", class: "prose", provider: "anthropic", model: "model-b", value: "hello", providerInputTokens: 1 },
    { id: "json-a", class: "json", value: { b: 1, a: 2 }, providerInputTokens: 4 },
    { id: "schema-a", class: "schema", value: { name: "read_file", input: { path: "src/a.ts" } }, providerInputTokens: 8 },
    { id: "non-english-a", class: "non-English", value: "日本語", providerInputTokens: 5 },
    { id: "image-a", class: "image", value: { type: "image", source: { media_type: "image/png", data: "AA==" } }, providerInputTokens: 20 },
    {
      id: "tool-payload-a",
      class: "tool-payload",
      value: { type: "tool_result", tool: "read_file", content: "result" },
      usage: { input: 3, cacheRead: 2, cacheWrite: 1 },
    },
    {
      id: "unknown-cache-read",
      class: "tool-payload",
      value: { type: "tool_result", content: "unknown" },
      usage: { input: 3, cacheRead: null, cacheWrite: 0 },
    },
    { id: "zero-estimate", class: "prose", value: "", providerInputTokens: 3 },
  ],
};

const report = calibrateSamples(fixture.samples);

assert.equal(report.schemaVersion, 1);
assert.equal(report.totalSamples, 9);
assert.equal(report.knownSamples, 8);
assert.equal(report.unknownSamples, 1);
assert.deepEqual(report.unknownReasons, { "provider-usage-incomplete": 1 });
assert.deepEqual(report.sampleIds, fixture.samples.map((sample) => sample.id).sort());

assert.equal(report.samples.find((sample) => sample.id === "code-a").estimatedTokens, 1);
assert.equal(report.samples.find((sample) => sample.id === "code-a").providerInputTokens, 2);
assert.equal(report.samples.find((sample) => sample.id === "code-a").signedErrorTokens, -1);
assert.equal(report.samples.find((sample) => sample.id === "code-a").absoluteErrorTokens, 1);
assert.equal(report.samples.find((sample) => sample.id === "prose-a").signedErrorTokens, 1);
assert.equal(report.samples.find((sample) => sample.id === "non-english-a").estimatedTokens, 3);
assert.equal(report.samples.find((sample) => sample.id === "tool-payload-a").providerInputTokens, 6);

const unknown = report.samples.find((sample) => sample.id === "unknown-cache-read");
assert.equal(unknown.providerInputTokens, null);
assert.equal(unknown.signedErrorTokens, null);
assert.equal(unknown.absoluteErrorTokens, null);
assert.equal(unknown.unknownReason, "provider-usage-incomplete");

assert.equal(report.byClass.code.knownSamples, 1);
assert.equal(report.byClass.code.signedErrorTokens, -1);
assert.equal(report.byClass.code.absoluteErrorTokens, 1);
assert.equal(report.byClass["tool-payload"].knownSamples, 1);
assert.equal(report.byClass["tool-payload"].unknownSamples, 1);
assert.equal(report.byClass["tool-payload"].providerInputTokens, 6);
assert.equal(report.byClass.prose.safetyFactorStatus, "unbounded");
assert.equal(report.byClass.prose.conservativeSafetyFactor, null);
assert.equal(report.safetyFactorStatus, "unbounded");
assert.equal(report.conservativeSafetyFactor, null);
assert.equal(report.byModel["openai/model-a"].byClass.code.knownSamples, 1);
assert.equal(report.byModel["openai/model-a"].providerInputTokens, 2);
assert.equal(report.byModel["unknown/unknown"].unknownSamples, 1);
assert.match(report.errorDefinition, /estimatedTokens - providerInputTokens/);

const reordered = calibrateSamples([...fixture.samples].reverse());
assert.deepEqual(reordered, report);

const traceFile = join(root, "controlled.json");
writeFileSync(traceFile, JSON.stringify(fixture));
assert.deepEqual(await readCalibrationInput(traceFile), fixture.samples);

const traceDir = join(root, "traces");
mkdirSync(traceDir);
writeFileSync(join(traceDir, "turn-2.json"), JSON.stringify({ schemaVersion: 1, recordType: "calibration-sample", sample: fixture.samples[1] }));
writeFileSync(join(traceDir, "turn-1.json"), JSON.stringify({ schemaVersion: 1, recordType: "calibration-sample", sample: fixture.samples[0] }));
writeFileSync(join(traceDir, "ignore.json"), JSON.stringify(fixture.samples[2]));
assert.deepEqual(await readCalibrationInput(traceDir), [fixture.samples[0], fixture.samples[1]]);

const v2Attempt = join(root, "provider-attempt.json");
writeFileSync(v2Attempt, JSON.stringify({
  schemaVersion: 2,
  recordType: "attempt",
  runId: "run-1",
  taskId: "task-1",
  attemptId: "attempt-1",
  provider: "openai",
  model: "model-a",
  usage: { input: 10, cacheRead: 0, cacheWrite: 0 },
}));
await assert.rejects(
  () => readCalibrationInput(v2Attempt),
  /trace-v2 provider record.*raw calibration sample content/i,
);

const v2TraceDir = join(root, "provider-traces");
mkdirSync(v2TraceDir);
writeFileSync(join(v2TraceDir, "turn-1.json"), readFileSync(v2Attempt));
await assert.rejects(
  () => readCalibrationInput(v2TraceDir),
  /calibration-sample record.*trace-v2 provider record/i,
);

const human = renderCalibrationReport(report);
assert.match(human, /pure reclaim-payload estimator/i);
assert.match(human, /runtime watermark\/message-overhead estimate is not calibrated/i);
assert.match(human, /provider usage is authoritative/i);
assert.match(human, /unknown denominators excluded/i);
assert.match(human, /safety factor: unbounded/i);

const cliBin = new URL("./agent-core-token-calibration.mjs", import.meta.url).pathname;
const cli = spawnSync(process.execPath, [
  "--experimental-strip-types",
  "--no-warnings",
  cliBin,
  "--json",
  traceFile,
], { encoding: "utf8" });
assert.equal(cli.status, 0, cli.stderr);
assert.deepEqual(JSON.parse(cli.stdout), report);

const duplicateFile = join(root, "duplicate.json");
writeFileSync(duplicateFile, JSON.stringify({ samples: [fixture.samples[0], fixture.samples[0]] }));
const duplicate = spawnSync(process.execPath, [
  "--experimental-strip-types",
  "--no-warnings",
  cliBin,
  duplicateFile,
], { encoding: "utf8" });
assert.notEqual(duplicate.status, 0);
assert.match(duplicate.stderr, /duplicate sample id/i);

console.log("agent-core token calibration tests passed");
