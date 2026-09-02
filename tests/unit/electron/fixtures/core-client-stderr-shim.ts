#!/usr/bin/env -S node --experimental-strip-types
/** A JSON-lines core fixture which will block on stderr unless its parent drains it. */
import readline from "node:readline";
import { spawn } from "node:child_process";

const stderrFlood = (marker, done) => {
  const bytes = Buffer.concat([Buffer.alloc(512 * 1024, "x"), Buffer.from(`\n${marker}\n`)]);
  process.stderr.write(bytes, done);
};

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  const request = JSON.parse(line);
  const marker = typeof request.marker === "string" ? request.marker : "stderr-tail";
  if (request.op === "stderr-exit") {
    stderrFlood(marker, () => process.exit(23));
    continue;
  }
  if (request.op === "stderr-fail") {
    stderrFlood(marker, () => {
      process.stdout.write(`${JSON.stringify({ requestId: request.requestId, ok: false, error: "fixture rejected" })}\n`);
    });
    continue;
  }
  if (request.op === "stderr-warn-success") {
    process.stderr.write(`${marker}\n`, () => {
      process.stdout.write(`${JSON.stringify({ requestId: request.requestId, ok: true, state: { value: "warning completed" } })}\n`);
    });
    continue;
  }
  if (request.op === "success-late-stderr") {
    process.stdout.write(`${JSON.stringify({ requestId: request.requestId, ok: true, state: { value: "late warning completed" } })}\n`);
    setTimeout(() => process.stderr.write(`${marker}\n`), 75);
    continue;
  }
  if (request.op === "plain-fail") {
    process.stdout.write(`${JSON.stringify({ requestId: request.requestId, ok: false, error: "fixture plain rejected" })}\n`);
    continue;
  }
  if (request.op === "late-inherited-stderr") {
    const writer = spawn(process.execPath, ["-e", "setTimeout(() => process.stderr.write(process.argv[1]), 75)", `\n${marker}\n`], {
      stdio: ["ignore", "ignore", 2],
    });
    writer.unref();
    process.exit(23);
  }
  if (request.op === "delayed-fail") {
    setTimeout(() => {
      process.stdout.write(`${JSON.stringify({ requestId: request.requestId, ok: false, error: "fixture delayed rejected" })}\n`);
    }, 200);
    continue;
  }
  if (request.op === "delayed-exit") {
    setTimeout(() => process.exit(24), 200);
    continue;
  }
  if (request.op === "protocol-fail") {
    process.stderr.write(`${marker}\n`, () => {
      process.stdout.write(`${JSON.stringify({ op: "error", error: "fixture protocol rejected" })}\n`);
    });
    continue;
  }
  if (request.op === "stderr-flood") {
    stderrFlood(marker, () => {
      process.stdout.write(`${JSON.stringify({ requestId: request.requestId, ok: true, state: { value: "drained" } })}\n`);
    });
    continue;
  }
  process.stdout.write(`${JSON.stringify({ requestId: request.requestId, ok: true, state: { value: "later request completed" } })}\n`);
}
