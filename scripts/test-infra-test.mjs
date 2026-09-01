import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

function runCommand(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
}

function runNode(args, options = {}) {
  return runCommand(process.execPath, args, options);
}

function scriptGraph(scripts, name, chain = []) {
  assert.ok(scripts[name], `package script ${name} is missing`);
  assert.ok(!chain.includes(name), `package script cycle: ${[...chain, name].join(" -> ")}`);
  const command = scripts[name];
  const nodes = [{ name, command }];
  for (const match of command.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)) {
    nodes.push(...scriptGraph(scripts, match[1], [...chain, name]));
  }
  return nodes;
}

test("the package-wired session gate executes its exported checks", () => {
  const result = runCommand("npm", ["run", "test:agent-core-session"], {
    env: { ...process.env, TERMINA_CORE_TEST: "1" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /fresh session creates a missing project session directory/);
  assert.equal((result.stdout.match(/^112\/112 passed$/gm) ?? []).length, 1);
  assert.equal((result.stdout.match(/^all focused session receipt tests passed$/gm) ?? []).length, 1);
});

test("the canonical callback reporter propagates a failed check as nonzero", () => {
  const supportUrl = pathToFileURL(join(repo, "scripts/test-support.mjs")).href;
  const source = [
    `import { runExportedChecks } from ${JSON.stringify(supportUrl)};`,
    'const result = await runExportedChecks(({ check }) => check("forced failure", false), { label: "forced" });',
    "process.exitCode = result.exitCode;",
  ].join("\n");
  const result = runNode(["--input-type=module", "-e", source]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /FAIL  forced failure/);
  assert.equal((result.stdout.match(/^FAIL  forced failure$/gm) ?? []).length, 1);
  assert.equal((result.stdout.match(/^0\/1 passed$/gm) ?? []).length, 1);
  assert.doesNotMatch(result.stdout, /PASS  forced failure/);
});

test("default and release graphs execute trace-report exactly once", () => {
  const scripts = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).scripts;
  for (const root of ["test", "test:release"]) {
    const nodes = scriptGraph(scripts, root);
    const executions = nodes.reduce(
      (count, node) => count + (node.command.match(/scripts\/agent-core-trace-report-test\.mjs/g) ?? []).length,
      0,
    );
    assert.equal(executions, 1, `${root} executes agent-core-trace-report-test ${executions} times`);
  }
});

test("the registered session gate is the only session matrix owner", () => {
  const scripts = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).scripts;
  const harness = readFileSync(join(repo, "scripts/agent-core-harness-test.mjs"), "utf8");
  assert.equal((harness.match(/agent-core-session-test\.mjs/g) ?? []).length, 0);
  for (const root of ["test", "test:release"]) {
    const nodes = scriptGraph(scripts, root);
    const sessionRuns = nodes.reduce(
      (count, node) => count + (node.command.match(/scripts\/agent-core-session-test\.mjs/g) ?? []).length,
      0,
    );
    const receiptRuns = nodes.reduce(
      (count, node) => count + (node.command.match(/scripts\/agent-core-session-receipt-test\.mjs/g) ?? []).length,
      0,
    );
    assert.equal(sessionRuns, 1, `${root} executes the session matrix ${sessionRuns} times`);
    assert.equal(receiptRuns, 1, `${root} executes the session receipt ${receiptRuns} times`);
  }
});

test("ipc-navigation is wired through its isolated E2E spec runner", () => {
  const scripts = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).scripts;
  assert.equal(scripts["test:ipc-navigation"], "node scripts/e2e.mjs --skip-build ipc-navigation-test.mjs");
});

test("native read-budget failures derive their decimal byte bound", async () => {
  const { parseNativeByteBound } = await import("./test-support.mjs");
  assert.equal(parseNativeByteBound("blob fixture exceeds its 49283072-byte bound"), 49_283_072);
  assert.throws(() => parseNativeByteBound("blob fixture exceeded the native read budget"), /byte bound/);
});
