/**
 * Shared result/reporting support for callback-style test modules.
 *
 * This deliberately owns only PASS/FAIL accounting and cleanup for an
 * explicitly supplied list of temporary roots. Process groups, native
 * boundaries, and Electron lifecycles remain with their dedicated probes.
 */
import { rmSync } from "node:fs";

export type CheckFn = (name: string, ok: unknown, detail?: unknown) => boolean;
export type CheckWriter = (message: string) => void;

export function createCheckReporter({ write = console.log }: { write?: CheckWriter } = {}): { check: CheckFn; results: boolean[] } {
  const results: boolean[] = [];
  const check: CheckFn = (name, ok, detail = "") => {
    const passed = Boolean(ok);
    results.push(passed);
    write(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? " — " + String(detail).slice(0, 240) : ""}`);
    return passed;
  };
  return { check, results };
}

export function cleanupTestRoots(paths: Iterable<unknown>) {
  for (const path of new Set(paths)) {
    if (typeof path !== "string") continue;
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      /* Best-effort cleanup must not hide the assertion that already failed. */
    }
  }
}

export function summarizeCheckResults(results: boolean[]) {
  const failed = results.filter((passed) => !passed).length;
  return {
    total: results.length,
    passed: results.length - failed,
    failed,
    exitCode: failed === 0 ? 0 : 1,
  };
}

export function parseNativeByteBound(message: unknown) {
  const match = String(message).match(/exceeds its (?<bytes>[0-9]+)-byte bound/);
  const bytes = Number(match?.groups?.bytes);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error("native read-budget error does not expose a decimal byte bound");
  }
  return bytes;
}

export async function runExportedChecks(
  run: (api: { check: CheckFn; leftovers: string[] }) => unknown | Promise<unknown>,
  { label = "test", write = console.log }: { label?: string; write?: CheckWriter } = {},
) {
  const reporter = createCheckReporter({ write });
  const leftovers: string[] = [];
  try {
    await run({ check: reporter.check, leftovers });
  } catch (error) {
    reporter.check(`${label} execution failed`, false, error instanceof Error ? error.stack : error);
  } finally {
    cleanupTestRoots(leftovers);
  }
  const summary = summarizeCheckResults(reporter.results);
  write(`${summary.passed}/${summary.total} passed`);
  return summary;
}
