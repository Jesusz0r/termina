/**
 * Focused tests for the deterministic agent-core rate/cost seam.
 * No network, provider credentials, or main.ts boot required.
 */
import assert from "node:assert/strict";

let fetchCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  fetchCalls += 1;
  throw new Error(`network access is forbidden in rates seam: ${String(args[0])}`);
};

let rates;
try {
  rates = await import("../agent-core/rates.ts");
} catch (error) {
  assert.fail(`rates module must load without provider I/O: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  globalThis.fetch = originalFetch;
}
assert.equal(fetchCalls, 0);

const {
  RATE_FIELDS,
  TOKEN_RATE_FIELDS,
  validateRateSnapshot,
  normalizeRateSnapshot,
  computeTraceCost,
  serializeRateSnapshot,
  serializeTraceCost,
} = rates;

assert.deepEqual(RATE_FIELDS, ["input", "cacheRead", "cacheWrite", "output", "reasoning", "storage"]);
assert.deepEqual(TOKEN_RATE_FIELDS, ["input", "cacheRead", "cacheWrite", "output", "reasoning"]);

const mainScope = {
  provider: "fixture-provider",
  protocol: "fixture-protocol",
  model: "fixture-model",
  route: "fixture-route",
};

const tokenUnits = {
  input: "usd_per_token",
  cacheRead: "usd_per_token",
  cacheWrite: "usd_per_token",
  output: "usd_per_token",
  reasoning: "usd_per_token",
  storage: "usd_per_gib_second",
};

const completeSnapshot = {
  scope: { ...mainScope, role: "main" },
  reasoningBilling: "separate",
  cacheWriteTtlClass: "5m",
  units: tokenUnits,
  lookedUpAt: "2026-08-30T12:00:00.000Z",
  rates: {
    storage: 0.0000000005,
    output: 0.000002,
    cacheWrite: 0.000003,
    input: 0.000001,
    reasoning: 0.000004,
    cacheRead: 0.0000001,
  },
  version: "fixture-v1",
  source: "fixture-catalog",
};

const valid = validateRateSnapshot(completeSnapshot);
assert.equal(valid.ok, true);
assert.deepEqual(valid.value.rates, {
  input: 0.000001,
  cacheRead: 0.0000001,
  cacheWrite: 0.000003,
  output: 0.000002,
  reasoning: 0.000004,
  storage: 0.0000000005,
});
  assert.equal(valid.value.source, "fixture-catalog");
assert.equal(valid.value.version, "fixture-v1");
assert.equal(valid.value.lookedUpAt, "2026-08-30T12:00:00.000Z");

const malformed = validateRateSnapshot({
  scope: { ...mainScope, role: "main" },
  reasoningBilling: "separate",
  cacheWriteTtlClass: "5m",
  units: tokenUnits,
  source: "fixture",
  lookedUpAt: "not-a-date",
  rates: { input: -1, output: Infinity },
});
assert.equal(malformed.ok, false);
assert.ok(malformed.errors.includes("lookedUpAt"));
assert.ok(malformed.errors.includes("rates.input"));
assert.ok(malformed.errors.includes("rates.output"));

const missingRequiredShape = validateRateSnapshot({
  scope: { ...mainScope },
  units: { ...tokenUnits },
  rates: {},
});
assert.equal(missingRequiredShape.ok, false);
assert.ok(missingRequiredShape.errors.includes("scope.role"));

const missingUnit = validateRateSnapshot({
  scope: { ...mainScope, role: "main" },
  units: { ...tokenUnits, output: undefined },
  rates: {},
});
assert.equal(missingUnit.ok, false);
assert.ok(missingUnit.errors.includes("units.output"));

const partial = normalizeRateSnapshot({
  scope: { ...mainScope, role: "main" },
  reasoningBilling: "separate",
  cacheWriteTtlClass: "5m",
  units: tokenUnits,
  source: "partial",
  lookedUpAt: null,
  rates: { input: 0.000001, cacheWrite: null },
});
assert.ok(partial);
assert.deepEqual(partial.rates, {
  input: 0.000001,
  cacheRead: null,
  cacheWrite: null,
  output: null,
  reasoning: null,
  storage: null,
});

const usage = {
  input: 100,
  cacheRead: 20,
  cacheWrite: 10,
  output: 5,
  reasoning: 2,
};
const expectedUsd =
  100 * 0.000001 +
  20 * 0.0000001 +
  10 * 0.000003 +
  5 * 0.000002 +
  2 * 0.000004;
const mainCost = computeTraceCost({ role: "main", scope: mainScope, usage, snapshot: valid.value });
const summarySnapshot = normalizeRateSnapshot({
  ...valid.value,
  scope: { ...mainScope, role: "summary" },
});
const summaryCost = computeTraceCost({ role: "summary", scope: mainScope, usage, snapshot: summarySnapshot });
assert.equal(mainCost.role, "main");
assert.equal(summaryCost.role, "summary");
assert.equal(mainCost.usd, expectedUsd);
assert.equal(summaryCost.usd, expectedUsd);
assert.deepEqual(mainCost.unknownFields, []);
assert.deepEqual(mainCost.knownFields, ["input", "cacheRead", "cacheWrite", "output", "reasoning"]);
assert.equal(mainCost.source, "fixture-catalog");
assert.equal(mainCost.version, "fixture-v1");
assert.equal(mainCost.lookedUpAt, "2026-08-30T12:00:00.000Z");
assert.equal(mainCost.scope.provider, "fixture-provider");
assert.equal(mainCost.cacheWriteTtlClass, "5m");
assert.equal(mainCost.reasoningBilling, "separate");

const missingCacheWriteRate = computeTraceCost({
  scope: mainScope,
  role: "main",
  usage,
  snapshot: normalizeRateSnapshot({
    scope: { ...mainScope, role: "main" },
    reasoningBilling: "separate",
    cacheWriteTtlClass: "5m",
    units: tokenUnits,
    source: "no-cache-write-rate",
    version: "fixture-v1",
    lookedUpAt: "2026-08-30T12:00:00.000Z",
    rates: {
      input: 0.000001,
      cacheRead: 0.0000001,
      cacheWrite: null,
      output: 0.000002,
      reasoning: 0.000004,
    },
  }),
});
assert.equal(missingCacheWriteRate.usd, null);
assert.deepEqual(missingCacheWriteRate.unknownFields, ["cacheWrite"]);
assert.ok(Math.abs(missingCacheWriteRate.components.input - 0.0001) < Number.EPSILON);
assert.equal(missingCacheWriteRate.components.cacheWrite, null);

const missingReasoningCounter = computeTraceCost({
  scope: mainScope,
  role: "summary",
  usage: { input: 100, cacheRead: 20, cacheWrite: 10, output: 5, reasoning: null },
  snapshot: summarySnapshot,
});
assert.equal(missingReasoningCounter.usd, null);
assert.deepEqual(missingReasoningCounter.unknownFields, ["reasoning"]);

const storageUsage = computeTraceCost({
  scope: mainScope,
  role: "main",
  usage: { ...usage, storage: { quantity: 1_000, unit: "gib", durationSeconds: 60 } },
  snapshot: valid.value,
});
assert.equal(storageUsage.usd, expectedUsd + 1_000 * 60 * 0.0000000005);
assert.ok(storageUsage.knownFields.includes("storage"));

const missingStorageRate = computeTraceCost({
  scope: mainScope,
  role: "main",
  usage: { ...usage, storage: { quantity: 1_000, unit: "gib", durationSeconds: 60 } },
  snapshot: normalizeRateSnapshot({
    scope: { ...mainScope, role: "main" },
    reasoningBilling: "separate",
    cacheWriteTtlClass: "5m",
    units: tokenUnits,
    source: "no-storage-rate",
    version: "fixture-v1",
    lookedUpAt: "2026-08-30T12:00:00.000Z",
    rates: { ...valid.value.rates, storage: null },
  }),
});
assert.equal(missingStorageRate.usd, null);
assert.deepEqual(missingStorageRate.unknownFields, ["storage"]);

const zeroCost = computeTraceCost({
  scope: mainScope,
  role: "main",
  usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
  snapshot: valid.value,
});
assert.equal(zeroCost.usd, 0);
assert.deepEqual(zeroCost.unknownFields, []);

const canonicalA = serializeRateSnapshot(valid.value);
const canonicalB = serializeRateSnapshot(normalizeRateSnapshot({
  scope: { ...mainScope, role: "main" },
  source: "fixture-catalog",
  version: "fixture-v1",
  lookedUpAt: "2026-08-30T12:00:00.000Z",
  reasoningBilling: "separate",
  cacheWriteTtlClass: "5m",
  units: tokenUnits,
  rates: {
    input: 0.000001,
    cacheRead: 0.0000001,
    cacheWrite: 0.000003,
    output: 0.000002,
    reasoning: 0.000004,
    storage: 0.0000000005,
  },
}));
assert.equal(canonicalA, canonicalB);
assert.equal(canonicalA, '{"scope":{"provider":"fixture-provider","protocol":"fixture-protocol","model":"fixture-model","route":"fixture-route","role":"main"},"source":"fixture-catalog","version":"fixture-v1","lookedUpAt":"2026-08-30T12:00:00.000Z","units":{"input":"usd_per_token","cacheRead":"usd_per_token","cacheWrite":"usd_per_token","output":"usd_per_token","reasoning":"usd_per_token","storage":"usd_per_gib_second"},"cacheWriteTtlClass":"5m","reasoningBilling":"separate","rates":{"input":0.000001,"cacheRead":1e-7,"cacheWrite":0.000003,"output":0.000002,"reasoning":0.000004,"storage":5e-10}}');

const costJson = serializeTraceCost(mainCost);
assert.equal(costJson, serializeTraceCost({ ...mainCost, components: { ...mainCost.components } }));
assert.ok(costJson.indexOf('"role":"main"') < costJson.indexOf('"usd"'));
assert.ok(costJson.includes('"unknownFields":[]'));

const millionTokenSnapshot = normalizeRateSnapshot({
  ...valid.value,
  units: {
    ...valid.value.units,
    input: "usd_per_million_tokens",
    output: "usd_per_million_tokens",
    reasoning: "usd_per_million_tokens",
  },
  rates: {
    ...valid.value.rates,
    input: 2,
    output: 4,
    reasoning: 8,
  },
});
const millionTokenCost = computeTraceCost({
  scope: mainScope,
  role: "main",
  usage: { input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 1_000_000, reasoning: 1_000_000 },
  snapshot: millionTokenSnapshot,
});
assert.equal(millionTokenCost.usd, 14);

const unknownTtl = computeTraceCost({
  scope: mainScope,
  role: "main",
  usage,
  snapshot: normalizeRateSnapshot({ ...valid.value, cacheWriteTtlClass: "unknown" }),
});
assert.equal(unknownTtl.usd, null);
assert.ok(unknownTtl.unknownFields.includes("cacheWriteTtlClass"));

const noWritesNeedsNoTtl = computeTraceCost({
  scope: mainScope,
  role: "main",
  usage: { ...usage, cacheWrite: 0 },
  snapshot: normalizeRateSnapshot({ ...valid.value, cacheWriteTtlClass: "unknown" }),
});
assert.equal(noWritesNeedsNoTtl.usd, expectedUsd - 10 * 0.000003);
assert.ok(!noWritesNeedsNoTtl.unknownFields.includes("cacheWriteTtlClass"));

const noSnapshot = computeTraceCost({
  scope: mainScope,
  role: "main",
  usage,
  snapshot: null,
});
assert.equal(noSnapshot.usd, null);
assert.ok(noSnapshot.unknownFields.includes("cacheWriteTtlClass"));

const mismatchedScope = computeTraceCost({
  scope: { ...mainScope, route: "different-route" },
  role: "main",
  usage,
  snapshot: valid.value,
});
assert.equal(mismatchedScope.scopeMatch, false);
assert.equal(mismatchedScope.usd, null);
assert.ok(mismatchedScope.unknownFields.includes("scope"));

const incompleteProvenance = computeTraceCost({
  scope: mainScope,
  role: "main",
  usage,
  snapshot: normalizeRateSnapshot({
    ...valid.value,
    source: null,
    version: null,
    lookedUpAt: null,
  }),
});
assert.equal(incompleteProvenance.usd, null);
assert.ok(incompleteProvenance.unknownFields.includes("source"));
assert.ok(incompleteProvenance.unknownFields.includes("version"));
assert.ok(incompleteProvenance.unknownFields.includes("lookedUpAt"));

const includedReasoning = computeTraceCost({
  scope: mainScope,
  role: "main",
  usage: { ...usage, reasoning: null },
  snapshot: normalizeRateSnapshot({
    ...valid.value,
    reasoningBilling: "included-in-output",
    rates: { ...valid.value.rates, reasoning: null },
  }),
});
assert.equal(includedReasoning.usd, 100 * 0.000001 + 20 * 0.0000001 + 10 * 0.000003 + 5 * 0.000002);
assert.ok(!includedReasoning.knownFields.includes("reasoning"));
assert.ok(!includedReasoning.unknownFields.includes("reasoning"));

const includedReasoningWithStorage = computeTraceCost({
  scope: mainScope,
  role: "main",
  usage: { ...usage, reasoning: null, storage: { quantity: 1, unit: "gib", durationSeconds: 1 } },
  snapshot: normalizeRateSnapshot({
    ...valid.value,
    reasoningBilling: "included-in-output",
    rates: { ...valid.value.rates, reasoning: null },
  }),
});
assert.equal(includedReasoningWithStorage.usd, 100 * 0.000001 + 20 * 0.0000001 + 10 * 0.000003 + 5 * 0.000002 + 0.0000000005);
assert.ok(includedReasoningWithStorage.knownFields.includes("storage"));

const invalidStorageShape = computeTraceCost({
  scope: mainScope,
  role: "main",
  usage: { ...usage, storage: { quantity: 1_000, unit: "byte", durationSeconds: null } },
  snapshot: valid.value,
});
assert.equal(invalidStorageShape.usd, null);
assert.ok(invalidStorageShape.unknownFields.includes("storage"));

const aggregateOverflow = computeTraceCost({
  scope: mainScope,
  role: "main",
  usage: { input: Number.MAX_VALUE, output: Number.MAX_VALUE },
  requiredFields: ["input", "output"],
  snapshot: normalizeRateSnapshot({
    ...valid.value,
    rates: { ...valid.value.rates, input: 1, output: 1 },
  }),
});
assert.equal(aggregateOverflow.usd, null);
assert.ok(aggregateOverflow.unknownFields.includes("aggregate"));

console.log("PASS agent-core-rates-test");
