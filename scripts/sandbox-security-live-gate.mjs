/** Require the live OS sandbox probes for a release-platform gate. */
import { runSandboxGate } from "./sandbox-gate-runner.mjs";

const result = await runSandboxGate();
if (result.error) console.error(`live sandbox gate failed to start: ${result.error.message}`);
if (result.cleanupError) console.error(`live sandbox gate cleanup failed: ${result.cleanupError.message}`);
process.exit(result.code ?? 1);
