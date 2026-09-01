/**
 * Shared result/reporting support for callback-style test modules.
 *
 * This deliberately owns only PASS/FAIL accounting and cleanup for an
 * explicitly supplied list of temporary roots. Process groups, native
 * boundaries, and Electron lifecycles remain with their dedicated probes.
 */
import { rmSync } from "node:fs";

export function createCheckReporter({ write = console.log } = {}) {
  const results = [];
  const check = (name, ok, detail = "") => {
    const passed = Boolean(ok);
    results.push(passed);
    write(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? " — " + String(detail).slice(0, 240) : ""}`);
    return passed;
  };
  return { check, results };
}

export function cleanupTestRoots(paths) {
  for (const path of new Set(paths)) {
    if (typeof path !== "string") continue;
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      /* Best-effort cleanup must not hide the assertion that already failed. */
    }
  }
}

export function summarizeCheckResults(results) {
  const failed = results.filter((passed) => !passed).length;
  return {
    total: results.length,
    passed: results.length - failed,
    failed,
    exitCode: failed === 0 ? 0 : 1,
  };
}

export function parseNativeByteBound(message) {
  const match = String(message).match(/exceeds its (?<bytes>[0-9]+)-byte bound/);
  const bytes = match ? Number(match.groups.bytes) : NaN;
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error("native read-budget error does not expose a decimal byte bound");
  }
  return bytes;
}

export async function runExportedChecks(run, { label = "test", write = console.log } = {}) {
  const reporter = createCheckReporter({ write });
  const leftovers = [];
  try {
    await run({ check: reporter.check, leftovers });
  } catch (error) {
    reporter.check(`${label} execution failed`, false, error?.stack ?? error);
  } finally {
    cleanupTestRoots(leftovers);
  }
  const summary = summarizeCheckResults(reporter.results);
  write(`${summary.passed}/${summary.total} passed`);
  return summary;
}
