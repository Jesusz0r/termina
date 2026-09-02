// @ts-nocheck
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

const marker = process.env.TERMINA_SANDBOX_GATE_TEST_MARKER;
if (!marker) throw new Error("TERMINA_SANDBOX_GATE_TEST_MARKER is required");

const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], { stdio: "ignore" });
await writeFile(marker, `${JSON.stringify({ child: process.pid, descendant: descendant.pid })}\n`);

if (process.env.TERMINA_SANDBOX_GATE_TEST_MODE === "fail") {
  console.error("live sandbox probes failed in the controlled child");
  process.exit(7);
}

setInterval(() => {}, 1_000);
