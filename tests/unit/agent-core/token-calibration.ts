#!/usr/bin/env node

import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// This is deliberately the only estimator used by the calibration report.
// Provider usage remains authoritative; this script never supplies a tokenizer.
const { estimateReclaimTokens } = await import("../../../agent-core/reclaim.ts");

export const CALIBRATION_SCHEMA_VERSION = 1;
export const CALIBRATION_RECORD_TYPE = "calibration-sample";
export const CONTENT_CLASSES = Object.freeze([
  "code",
  "prose",
  "json",
  "schema",
  "non-English",
  "image",
  "tool-payload",
]);

const CLASS_RANK = new Map(CONTENT_CLASSES.map((name, index) => [name, index]));
const MAX_SAMPLE_ID_LENGTH = 128;
const SAMPLE_ID_PATTERN = /^[^\u0000-\u001f\u007f]+$/;
const TRACE_FILE_PATTERN = /^turn-(\d+)\.json$/;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isKnownTokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function compareStable(left, right) {
  const a = Buffer.from(String(left), "utf8");
  const b = Buffer.from(String(right), "utf8");
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

function roundDecimal(value, places = 3) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** places;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function sortedCounts(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries([...counts].sort(([a], [b]) => compareStable(a, b)));
}

function sampleValuePresent(sample) {
  return Object.hasOwn(sample, "value") || Object.hasOwn(sample, "content");
}

function sampleValue(sample) {
  // `content` is accepted for trace-shaped fixtures. `value` wins when both
  // are present so a fixture can carry non-calibration metadata safely.
  return Object.hasOwn(sample, "value") ? sample.value : sample.content;
}

function boundedLabel(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_SAMPLE_ID_LENGTH && SAMPLE_ID_PATTERN.test(value)
    ? value
    : "unknown";
}

function providerInputFor(sample) {
  if (Object.hasOwn(sample, "providerInputTokens")) {
    if (isKnownTokenCount(sample.providerInputTokens)) {
      return { value: sample.providerInputTokens, reason: null };
    }
    return { value: null, reason: "provider-input-invalid" };
  }

  const usage = Object.hasOwn(sample, "providerUsage")
    ? sample.providerUsage
    : Object.hasOwn(sample, "usage") ? sample.usage : undefined;
  if (!isRecord(usage)) return { value: null, reason: "provider-usage-incomplete" };

  const fields = [usage.input, usage.cacheRead, usage.cacheWrite];
  if (!fields.every(isKnownTokenCount)) {
    return { value: null, reason: "provider-usage-incomplete" };
  }
  const total = usage.input + usage.cacheRead + usage.cacheWrite;
  return Number.isSafeInteger(total)
    ? { value: total, reason: null }
    : { value: null, reason: "provider-usage-invalid" };
}

function normalizeSample(raw, index) {
  if (!isRecord(raw)) throw new TypeError(`sample ${index + 1} is not an object`);
  if (typeof raw.id !== "string" || raw.id.length === 0 || raw.id.length > MAX_SAMPLE_ID_LENGTH || !SAMPLE_ID_PATTERN.test(raw.id)) {
    throw new TypeError(`sample ${index + 1} has an invalid id`);
  }
  if (!CLASS_RANK.has(raw.class)) {
    throw new TypeError(`sample ${raw.id} has an unsupported content class`);
  }
  if (!sampleValuePresent(raw)) {
    throw new TypeError(`sample ${raw.id} is missing value`);
  }

  const provider = providerInputFor(raw);
  const estimatedTokens = estimateReclaimTokens(sampleValue(raw));
  const known = provider.value !== null;
  return {
    id: raw.id,
    class: raw.class,
    provider: boundedLabel(raw.provider),
    model: boundedLabel(raw.model),
    estimatedTokens,
    providerInputTokens: provider.value,
    signedErrorTokens: known ? estimatedTokens - provider.value : null,
    absoluteErrorTokens: known ? Math.abs(estimatedTokens - provider.value) : null,
    signedErrorRatio: known && provider.value > 0
      ? roundDecimal((estimatedTokens - provider.value) / provider.value)
      : null,
    absoluteErrorRatio: known && provider.value > 0
      ? roundDecimal(Math.abs(estimatedTokens - provider.value) / provider.value)
      : null,
    unknownReason: known ? null : provider.reason,
  };
}

function safetyFactor(records) {
  const known = records.filter((record) => record.providerInputTokens !== null);
  if (known.length === 0) return { value: null, status: "no-known-samples" };

  let required = 1;
  for (const record of known) {
    if (record.providerInputTokens <= 0) continue;
    if (record.estimatedTokens === 0) return { value: null, status: "unbounded" };
    required = Math.max(required, record.providerInputTokens / record.estimatedTokens);
  }
  // Round upward, rather than to-nearest, so the displayed factor remains
  // conservative for every known sample. This is not a tokenizer guarantee.
  return { value: Math.ceil((required - Number.EPSILON) * 1000) / 1000, status: "bounded" };
}

function summarizeRecords(records) {
  const known = records.filter((record) => record.providerInputTokens !== null);
  const estimatedTokens = known.reduce((sum, record) => sum + record.estimatedTokens, 0);
  const providerInputTokens = known.reduce((sum, record) => sum + record.providerInputTokens, 0);
  const signedErrorTokens = known.reduce((sum, record) => sum + record.signedErrorTokens, 0);
  const absoluteErrorTokens = known.reduce((sum, record) => sum + record.absoluteErrorTokens, 0);
  const maxAbsoluteErrorTokens = known.length === 0
    ? null
    : Math.max(...known.map((record) => record.absoluteErrorTokens));
  const factor = safetyFactor(records);
  return {
    samples: records.length,
    knownSamples: known.length,
    unknownSamples: records.length - known.length,
    estimatedTokens,
    providerInputTokens,
    signedErrorTokens,
    absoluteErrorTokens,
    meanSignedErrorTokens: known.length > 0 ? roundDecimal(signedErrorTokens / known.length) : null,
    meanAbsoluteErrorTokens: known.length > 0 ? roundDecimal(absoluteErrorTokens / known.length) : null,
    signedErrorRatio: providerInputTokens > 0 ? roundDecimal(signedErrorTokens / providerInputTokens) : null,
    absoluteErrorRatio: providerInputTokens > 0 ? roundDecimal(absoluteErrorTokens / providerInputTokens) : null,
    maxAbsoluteErrorTokens,
    conservativeSafetyFactor: factor.value,
    safetyFactorStatus: factor.status,
  };
}

function sortSamples(samples) {
  return samples.slice().sort((left, right) => {
    const classOrder = CLASS_RANK.get(left.class) - CLASS_RANK.get(right.class);
    return classOrder || compareStable(left.id, right.id);
  });
}

function modelKey(sample) {
  return `${sample.provider}/${sample.model}`;
}

function summarizeModelGroups(samples) {
  const groups = new Map();
  for (const sample of samples) {
    const key = modelKey(sample);
    const group = groups.get(key) ?? { provider: sample.provider, model: sample.model, samples: [] };
    group.samples.push(sample);
    groups.set(key, group);
  }
  return Object.fromEntries([...groups]
    .sort(([left], [right]) => compareStable(left, right))
    .map(([key, group]) => {
      const byClass = {};
      for (const contentClass of CONTENT_CLASSES) {
        byClass[contentClass] = summarizeRecords(group.samples.filter((sample) => sample.class === contentClass));
      }
      return [key, {
        provider: group.provider,
        model: group.model,
        ...summarizeRecords(group.samples),
        byClass,
      }];
    }));
}

/**
 * Compare `estimateReclaimTokens` with known provider input counts.
 *
 * `usage.input + usage.cacheRead + usage.cacheWrite` is accepted only when all
 * three fields are known nonnegative integers. A nullable field therefore
 * excludes that sample from every provider-input/error denominator.
 */
export function calibrateSamples(rawSamples) {
  if (!Array.isArray(rawSamples)) throw new TypeError("calibration samples must be an array");
  const normalized = rawSamples.map(normalizeSample);
  const ids = new Set();
  for (const sample of normalized) {
    if (ids.has(sample.id)) throw new TypeError(`duplicate sample id: ${sample.id}`);
    ids.add(sample.id);
  }

  const samples = sortSamples(normalized);
  const byClass = {};
  for (const contentClass of CONTENT_CLASSES) {
    byClass[contentClass] = summarizeRecords(samples.filter((sample) => sample.class === contentClass));
  }
  const summary = summarizeRecords(samples);

  return {
    schemaVersion: CALIBRATION_SCHEMA_VERSION,
    scope: "pure-reclaim-payload-estimator",
    estimator: "agent-core/reclaim.ts:estimateReclaimTokens",
    runtimeEstimatorScope: "runtime watermark/message-overhead estimate is not calibrated by this report",
    providerInputDefinition: "providerInputTokens, or usage.input + usage.cacheRead + usage.cacheWrite when all are known",
    errorDefinition: "signedErrorTokens = estimatedTokens - providerInputTokens; absoluteErrorTokens = absolute(signedErrorTokens)",
    caveat: "Provider usage is authoritative; this heuristic does not claim tokenizer accuracy.",
    denominatorPolicy: "Unknown provider denominators are excluded from error and safety-factor metrics.",
    totalSamples: summary.samples,
    knownSamples: summary.knownSamples,
    unknownSamples: summary.unknownSamples,
    unknownReasons: sortedCounts(samples.filter((sample) => sample.unknownReason).map((sample) => sample.unknownReason)),
    sampleIds: samples.map((sample) => sample.id).sort(compareStable),
    estimatedTokens: summary.estimatedTokens,
    providerInputTokens: summary.providerInputTokens,
    signedErrorTokens: summary.signedErrorTokens,
    absoluteErrorTokens: summary.absoluteErrorTokens,
    meanSignedErrorTokens: summary.meanSignedErrorTokens,
    meanAbsoluteErrorTokens: summary.meanAbsoluteErrorTokens,
    signedErrorRatio: summary.signedErrorRatio,
    absoluteErrorRatio: summary.absoluteErrorRatio,
    maxAbsoluteErrorTokens: summary.maxAbsoluteErrorTokens,
    conservativeSafetyFactor: summary.conservativeSafetyFactor,
    safetyFactorStatus: summary.safetyFactorStatus,
    byClass,
    byModel: summarizeModelGroups(samples),
    samples,
  };
}

function parseJsonFile(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid JSON in ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function extractSamples(value, source, { requireCalibrationRecord = false } = {}) {
  if (requireCalibrationRecord && (!isRecord(value) || value.recordType !== CALIBRATION_RECORD_TYPE)) {
    throw new Error(`${source} must be a calibration-sample record; trace-v2 provider records are not calibration evidence`);
  }
  if (isRecord(value) && value.schemaVersion === 2 &&
    (value.recordType === "attempt" || value.recordType === "task-settled")) {
    throw new Error(`${source} is a trace-v2 provider record; raw calibration sample content is required`);
  }
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) throw new Error(`${source} must contain a sample array`);
  if (value.recordType === CALIBRATION_RECORD_TYPE) {
    if (value.schemaVersion !== CALIBRATION_SCHEMA_VERSION || !isRecord(value.sample)) {
      throw new Error(`${source} is an invalid calibration-sample record`);
    }
    return [value.sample];
  }
  if (Array.isArray(value.samples)) return value.samples;
  if (Array.isArray(value.calibrationSamples)) return value.calibrationSamples;
  if (isRecord(value.sample)) return [value.sample];
  if (isRecord(value.calibration)) return [value.calibration];
  if (Object.hasOwn(value, "id") && Object.hasOwn(value, "class") && sampleValuePresent(value)) return [value];
  throw new Error(`${source} must contain samples`);
}

function traceFileNumber(name) {
  const match = TRACE_FILE_PATTERN.exec(name);
  return match ? Number(match[1]) : null;
}

/** Read one fixture file or a directory of deterministic turn-N trace files. */
export async function readCalibrationInput(inputPath) {
  const target = resolve(inputPath);
  if (!existsSync(target)) throw new Error(`input does not exist: ${target}`);
  const stat = lstatSync(target);
  if (stat.isFile()) return extractSamples(parseJsonFile(target), target);
  if (!stat.isDirectory()) throw new Error(`input is not a file or directory: ${target}`);

  const files = readdirSync(target)
    .map((name) => ({ name, turn: traceFileNumber(name) }))
    .filter((entry) => entry.turn !== null)
    .sort((left, right) => left.turn - right.turn || compareStable(left.name, right.name));
  if (files.length === 0) throw new Error(`no turn-N JSON traces found in ${target}`);
  return files.flatMap(({ name }) => extractSamples(parseJsonFile(join(target, name)), join(target, name), { requireCalibrationRecord: true }));
}

function formatNumber(value) {
  return value === null ? "--" : String(value);
}

function formatFactor(value, status) {
  if (status === "unbounded") return "unbounded";
  if (status === "no-known-samples") return "-- (no known samples)";
  return `${value}x`;
}

/** Render a stable, human-readable audit without printing fixture content. */
export function renderCalibrationReport(report) {
  const lines = [
    "Token calibration (pure reclaim-payload estimator; no tokenizer accuracy claim)",
    "runtime watermark/message-overhead estimate is not calibrated by this report",
    "provider usage is authoritative; estimates are for bounded watermarks only",
    `samples: ${report.totalSamples}; known: ${report.knownSamples}; unknown: ${report.unknownSamples}`,
    "unknown denominators excluded from error and safety-factor metrics",
    `overall: estimate ${report.estimatedTokens}; provider input ${report.providerInputTokens}; signed error ${report.signedErrorTokens}; absolute error ${report.absoluteErrorTokens}`,
    `safety factor: ${formatFactor(report.conservativeSafetyFactor, report.safetyFactorStatus)}`,
    "by class:",
  ];
  for (const contentClass of CONTENT_CLASSES) {
    const summary = report.byClass[contentClass];
    lines.push(
      `  ${contentClass}: ${summary.knownSamples}/${summary.samples} known; ` +
      `signed ${formatNumber(summary.signedErrorTokens)}; abs ${formatNumber(summary.absoluteErrorTokens)}; ` +
      `safety ${formatFactor(summary.conservativeSafetyFactor, summary.safetyFactorStatus)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function usage() {
  return "usage: node --experimental-strip-types scripts/agent-core-token-calibration.mjs [--json] fixture.json|calibration-sample-trace-dir ...";
}

export async function run(argv = process.argv.slice(2)) {
  const json = argv.includes("--json");
  const paths = argv.filter((arg) => arg !== "--json");
  if (argv.includes("--help") || argv.includes("-h")) return { help: usage() };
  const unknown = paths.filter((arg) => arg.startsWith("-"));
  if (unknown.length > 0) throw new Error(`unknown option: ${unknown[0]}\n${usage()}`);
  if (paths.length === 0) throw new Error(usage());

  const rawSamples = [];
  for (const inputPath of paths) rawSamples.push(...await readCalibrationInput(inputPath));
  const report = calibrateSamples(rawSamples);
  return json ? JSON.stringify(report, null, 2) + "\n" : renderCalibrationReport(report);
}

const thisFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedFile === thisFile) {
  try {
    const output = await run();
    if (isRecord(output) && typeof output.help === "string") {
      console.log(output.help);
    } else {
      process.stdout.write(output);
    }
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
