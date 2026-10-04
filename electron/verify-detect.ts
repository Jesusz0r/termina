/**
 * Test/benchmark detection: the project's own test command from the live
 * tree or a captured state. Pure probes over fs and the snapshot store;
 * execution stays on the verify path in main.
 */
import { readFile, realpath as fsRealpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type { SnapshotStore } from "./worldline-git.js";

type DetectedTestCommand = { command: string; args: string[]; label: string };

/**
 * Detect the project's test command: package.json scripts (prefer `test`,
 * then the first `test:*` script), pytest, cargo test, go test.
 */
export async function detectTestCommand(cwd: string): Promise<DetectedTestCommand | null> {
  const pkgText = await safeWorkspaceRead(cwd, "package.json");
  if (pkgText !== null) {
    const script = testScriptFromPkg(pkgText);
    if (script) {
      // Live Verify must use npm itself: it supplies local binary lookup,
      // lifecycle hooks, and the package-script environment.
      return { command: "npm", args: ["run", script.name], label: `npm run ${script.name}` };
    }
  }
  return detectTestFromFiles(cwd);
}

async function safeWorkspaceRead(root: string, relPath: string): Promise<string | null> {
  try {
    const [canonicalRoot, canonicalPath] = await Promise.all([fsRealpath(root), fsRealpath(join(root, relPath))]);
    const rel = relative(canonicalRoot, canonicalPath);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
    return await readFile(canonicalPath, "utf8");
  } catch {
    return null;
  }
}

function testScriptFromPkg(pkgText: string): { name: string; body: string } | null {
  try {
    const pkg = JSON.parse(pkgText) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    const names = Object.keys(scripts);
    const name = names.includes("test") ? "test" : names.find((n) => n.startsWith("test:"));
    if (!name) return null;
    const body = (scripts[name] ?? "").trim();
    return body ? { name, body } : null;
  } catch {
    return null;
  }
}

/** The captured npm test script, resolved to its immutable base command
 *  body (WORLDLINES §6.8). Unlike live Verify, evidence must not invoke a
 *  candidate's mutable package-script alias. */
export function detectTestFromPkg(pkgText: string): DetectedTestCommand | null {
  const script = testScriptFromPkg(pkgText);
  if (!script) return null;
  // Preserve the captured shell body, including quotes and metacharacters,
  // without tokenization. The label records its original package alias.
  return { command: "sh", args: ["-c", script.body], label: `npm run ${script.name}` };
}

/** The pytest/cargo/go detection of a workspace. */
export async function detectTestFromFiles(cwd: string): Promise<DetectedTestCommand | null> {
  try {
    await stat(join(cwd, "pytest.ini"));
    return { command: "pytest", args: [], label: "pytest" };
  } catch {
    const pyproject = await safeWorkspaceRead(cwd, "pyproject.toml");
    if (pyproject?.includes("[tool.pytest")) return { command: "pytest", args: [], label: "pytest" };
  }
  try {
    await stat(join(cwd, "Cargo.toml"));
    return { command: "cargo", args: ["test"], label: "cargo test" };
  } catch {
    /* Cargo is not configured. */
  }
  try {
    await stat(join(cwd, "go.mod"));
    return { command: "go", args: ["test", "./..."], label: "go test ./..." };
  } catch {
    return null;
  }
}

/** The test command of a captured state (the shared base). */
export async function detectTestFromState(store: SnapshotStore, stateId: string): Promise<DetectedTestCommand | null> {
  const pkg = await store.readBlob(stateId, "package.json");
  if (pkg) {
    const fromPkg = detectTestFromPkg(pkg.toString("utf8"));
    if (fromPkg) return fromPkg;
  }
  return null;
}

/** The benchmark harness config of a captured state, or null. */
export async function benchmarkConfigFrom(store: SnapshotStore, stateId: string): Promise<{ command: string[]; unit: string; direction: "lower" | "higher"; samples: number; thresholdPct: number } | null> {
  const pkg = await store.readBlob(stateId, "package.json");
  if (!pkg) return null;
  try {
    const cfg = (JSON.parse(pkg.toString("utf8")) as { "termina"?: { benchmark?: { command?: string; unit?: string; direction?: string; samples?: number; thresholdPct?: number } } })["termina"]?.benchmark;
    if (!cfg?.command) return null;
    const body = cfg.command.trim();
    if (!body) return null;
    return {
      // The harness declaration is shell, like a package script: preserve
      // it verbatim through sh instead of tokenizing it.
      command: ["sh", "-c", body],
      unit: cfg.unit ?? "ms",
      direction: cfg.direction === "higher" ? "higher" : "lower",
      samples: Math.min(10, Math.max(3, cfg.samples ?? 5)),
      thresholdPct: Math.max(1, cfg.thresholdPct ?? 5) / 100,
    };
  } catch {
    return null;
  }
}
