#!/usr/bin/env -S node --experimental-strip-types
import readline from "node:readline";

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  const request = JSON.parse(line);
  await new Promise((resolve) => setTimeout(resolve, 30));
  process.stdout.write(`${JSON.stringify({ requestId: request.requestId, ok: true, state: { value: request.value } })}\n`);
}
