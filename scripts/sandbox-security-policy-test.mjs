/**
 * Regression contract for the required-live sandbox gate.
 *
 * A required-live invocation must either run the macOS probes successfully or
 * fail explicitly; static checks plus a silent SKIP is not an acceptable gate.
 */
import assert from "node:assert/strict";
import { runSandboxGate } from "./sandbox-gate-runner.mjs";

const result = await runSandboxGate({ captureOutput: true });
if (result.error) console.error(`sandbox policy child failed to start: ${result.error.message}`);
if (result.cleanupError) console.error(`sandbox policy child cleanup failed: ${result.cleanupError.message}`);
if (result.code !== 0) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}
const output = `${result.stdout}\n${result.stderr}`;

if (result.interrupted) {
  process.exit(result.code ?? 1);
} else if (process.platform === "darwin" && result.code === 0) {
  assert.doesNotMatch(output, /SKIP\s+macOS live sandbox probes/i, "required-live macOS gate must not silently skip");
} else {
  assert.notEqual(result.code, 0, "required-live sandbox gate must fail off macOS or when live probes cannot run");
  assert.match(output, /live sandbox probes|required.*sandbox|macOS runner/i, "required-live failure must explain the missing live probe");
}

console.log("sandbox required-live policy contract passed");
