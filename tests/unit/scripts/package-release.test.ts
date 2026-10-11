import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function packageAttempt(message: string, failAgain = false) {
  const root = mkdtempSync(join(tmpdir(), "termina-package-test-"));
  roots.push(root);
  const count = join(root, "count");
  const args = join(root, "args");
  writeFileSync(join(root, "pnpm"), `#!/bin/sh
count=0
[ ! -f "$COUNTER_FILE" ] || count=$(cat "$COUNTER_FILE")
count=$((count + 1))
echo "$count" > "$COUNTER_FILE"
echo "$*" >> "$ARGS_FILE"
if [ "$count" = 1 ] || [ "$FAIL_AGAIN" = 1 ]; then
  echo "$FAILURE_MESSAGE" >&2
  exit 73
fi
`, { mode: 0o755 });
  const result = spawnSync("bash", [resolve("scripts/package-release.sh")], {
    cwd: root, encoding: "utf8", timeout: 10_000,
    env: { PATH: `${root}${delimiter}${process.env.PATH}`, TMPDIR: root,
      COUNTER_FILE: count, ARGS_FILE: args, FAILURE_MESSAGE: message, FAIL_AGAIN: failAgain ? "1" : "0" },
  });
  return { result, count: Number(readFileSync(count, "utf8")), args: readFileSync(args, "utf8") };
}

describe("bounded packaging retries", () => {
  it("retries a transient network failure once and keeps publication disabled", () => {
    const { result, count, args } = packageAttempt("download failed: ECONNRESET");
    expect(result.status, result.stderr).toBe(0);
    expect(count).toBe(2);
    expect(args.trim().split("\n")).toEqual(["exec electron-builder --publish never", "exec electron-builder --publish never"]);
  });

  it.each(["invalid configuration", "invalid configuration: unexpected EOF", "Code signing failed: certificate not found", "HTTP 401 Unauthorized"])("does not retry %s", (message) => {
    const { result, count } = packageAttempt(message);
    expect(result.status, result.stderr).toBe(73);
    expect(count).toBe(1);
  });

  it("stops after the second network failure and preserves its exit status", () => {
    const { result, count } = packageAttempt("ETIMEDOUT", true);
    expect(result.status, result.stderr).toBe(73);
    expect(count).toBe(2);
  });
});
