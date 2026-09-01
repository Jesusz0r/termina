/**
 * Evidence engine (WORLDLINES §6.8, §6.9).
 *
 * Computes deterministic, immutable evidence for one candidate against the
 * shared base: Verify (the base test command, in the candidate sandbox),
 * dependency declarations, the public API manifest, the source footprint,
 * and the benchmark harness. Trajectory reads the candidate sidecar.
 * Ranking consumes only current evidence.
 */
import { readFile, realpath as fsRealpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { SnapshotStore } from "./worldline-git.js";
import { MAX_SIDECAR_BYTES, parseSidecarRecord, sidecarEventFromRecord } from "./sidecar.js";
import type { ChallengeProfile } from "../shared/types.js";

export type EvidenceKind = "verify" | "dependencies" | "api" | "footprint" | "benchmark" | "trajectory";

/** Wall-clock budget for all evidence Verify attempts of one candidate. */
const VERIFY_BUDGET_MS = 300_000;
/** Cap on completed evidence Verify attempts inside the budget. */
const MAX_VERIFY_RUNS = 5;
/** Do not start another attempt with less remaining time than this. */
const MIN_VERIFY_REPEAT_MS = 1_000;

/** One measured result for one candidate. */
export interface EvidenceRecord {
  kind: EvidenceKind;
  /** The candidate head state this evidence measures. */
  stateId: string;
  /** The shared base state (R) of the comparison. */
  baseStateId: string;
  status: "pass" | "fail" | "unavailable";
  result: Record<string, unknown>;
  reason: string | null;
}

/** The verdict of one fixed profile. */
export interface ProfileVerdict {
  profile: ChallengeProfile;
  winner: "A" | "B" | "tie" | "unavailable";
  /** The exact reason for the verdict. */
  reason: string;
  /** Per-candidate eligibility reasons ("" when eligible). */
  eligibility: Record<string, string>;
}

export interface EvidenceSummary {
  comparisonId: string;
  ts: number;
  /** One record per candidate per kind (missing kinds are absent). */
  byCandidate: Record<"A" | "B", EvidenceRecord[]>;
  /** One verdict per fixed profile. */
  profiles: ProfileVerdict[];
  /** Why the whole computation is unavailable, when it is. */
  error: string | null;
  /** True when a candidate ran again after the evidence (stale). */
  stale?: boolean;
}

interface CandidateFacts {
  root: string;
  profilePath: string;
  homeDir: string;
  tmpDir: string;
  shell: string;
  /** The candidate's own events directory, or empty when unknown. */
  eventsDir: string;
  /** The candidate terminal id that owns the sidecar file, or null. */
  terminalId: string | null;
}

export interface EvidenceDeps {
  store: SnapshotStore;
  baseStateId: string;
  primaryRoot: string;
  mineFiles: Set<string>;
  /** Capture a candidate head off the main thread. */
  captureHead(root: string, gitDir: string, parent: string | null): Promise<{ commit: string; tree: string }>;
  /** Run a shell command inside the candidate sandbox; bounded combined output. */
  runSandboxed(cand: CandidateFacts, command: string[], timeoutMs: number, signal?: AbortSignal): Promise<{ code: number; stdout: string; timedOut: boolean }>;
  /** The test command of the shared base (from its package manifest). */
  baseTestCommand(): { command: string; args: string[]; label: string } | null;
  /** The benchmark harness config of the shared base, or null. */
  benchmarkConfig(): { command: string[]; unit: string; direction: "lower" | "higher"; samples: number; thresholdPct: number } | null;
  /** The candidate's source files (tracked, bounded) for package checks. */
  sourceFilesOf(root: string): Promise<Array<{ relPath: string; content: string }>>;
}

/** The package declaration sections the dependency adapter measures. */
const DEP_SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function candidatePath(root: string, relPath: string): Promise<string | null> {
  const absolute = resolve(root, relPath);
  const rel = relative(resolve(root), absolute);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  try {
    const [canonicalRoot, canonicalPath] = await Promise.all([fsRealpath(root), fsRealpath(absolute)]);
    const canonicalRel = relative(canonicalRoot, canonicalPath);
    return canonicalRel && !canonicalRel.startsWith("..") && !isAbsolute(canonicalRel) ? canonicalPath : null;
  } catch {
    return null;
  }
}

async function readCandidateText(root: string, relPath: string): Promise<string | null> {
  const path = await candidatePath(root, relPath);
  return path ? readText(path) : null;
}

/** Parse a package.json text into its declaration sections. */
function parseDeps(text: string): Record<string, Record<string, string>> {
  try {
    const pkg = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
    const out: Record<string, Record<string, string>> = {};
    for (const section of DEP_SECTIONS) {
      const s = pkg[section];
      if (s && typeof s === "object") out[section] = s;
    }
    return out;
  } catch {
    return {};
  }
}

/** The added/removed/changed declarations between two package texts. */
export function dependencyDiff(baseText: string, headText: string): { added: string[]; removed: string[]; changed: string[] } {
  const base = parseDeps(baseText);
  const head = parseDeps(headText);
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const section of DEP_SECTIONS) {
    const b = base[section] ?? {};
    const h = head[section] ?? {};
    for (const name of Object.keys(h)) {
      if (!(name in b)) added.push(name);
      else if (b[name] !== h[name]) changed.push(name);
    }
    for (const name of Object.keys(b)) {
      if (!(name in h)) removed.push(name);
    }
  }
  return { added: [...new Set(added)].sort(), removed: [...new Set(removed)].sort(), changed: [...new Set(changed)].sort() };
}

/** The public roots of a package (exports values plus main). */
export function publicRoots(pkgText: string): string[] {
  try {
    const pkg = JSON.parse(pkgText) as { main?: unknown; exports?: unknown };
    const out = new Set<string>();
    if (typeof pkg.main === "string") out.add(pkg.main);
    const exportsValue = pkg.exports;
    const walk = (v: unknown): void => {
      if (typeof v === "string") out.add(v);
      else if (Array.isArray(v)) for (const x of v) walk(x);
      else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x);
    };
    walk(exportsValue);
    return [...out];
  } catch {
    return [];
  }
}

/** Normalize a declaration file: strip comments, trim, drop blank lines. */
export function normalizeSignature(text: string): string {
  const lines = text
    .split("\n")
    .map((l) => l.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/, "").replace(/\s+$/g, ""))
    .filter((l) => l.length > 0);
  return lines.join("\n");
}

/** The declared dependency names of a package text. */
export function declaredNames(pkgText: string): Set<string> {
  const names = new Set<string>();
  for (const section of Object.values(parseDeps(pkgText))) {
    for (const name of Object.keys(section)) names.add(name);
  }
  return names;
}

/** The npm test script of a package text, or null. */
function testScriptOf(pkgText: string): string | null {
  try {
    const pkg = JSON.parse(pkgText) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    const names = Object.keys(scripts);
    const pick = names.includes("test") ? "test" : names.find((n) => n.startsWith("test:"));
    return pick ? scripts[pick] ?? null : null;
  } catch {
    return null;
  }
}

/** Every external package reference in candidate source (import/require). */
/** Node built-in module names: not external packages. */
const NODE_BUILTINS = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console", "constants", "crypto", "dgram", "diagnostics_channel",
  "dns", "domain", "events", "fs", "http", "http2", "https", "inspector", "module", "net", "os", "path", "perf_hooks", "process",
  "punycode", "querystring", "readline", "repl", "stream", "string_decoder", "sys", "timers", "tls", "trace_events", "tty", "url",
  "util", "v8", "vm", "wasi", "worker_threads", "zlib", "node:fs", "node:path", "node:os", "node:url", "node:util", "node:stream",
  "node:crypto", "node:child_process", "node:events", "node:buffer", "node:http", "node:https", "node:net", "node:timers",
  "node:readline", "node:zlib", "node:string_decoder", "node:querystring", "node:punycode", "node:repl", "node:vm", "node:v8",
  "node:worker_threads", "node:assert", "node:async_hooks", "node:cluster", "node:constants", "node:dgram", "node:dns",
  "node:domain", "node:http2", "node:inspector", "node:module", "node:perf_hooks", "node:process", "node:sys", "node:tls",
  "node:trace_events", "node:tty", "node:wasi", "node:diagnostics_channel", "node:test", "node:sea", "node:sqlite",
]);

export function referencedPackages(sourceFiles: Array<{ relPath: string; content: string }>): Set<string> {
  const refs = new Set<string>();
  for (const f of sourceFiles) {
    if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f.relPath)) continue;
    for (const m of f.content.matchAll(/(?:from\s+["']|require\(\s*["'])([^"'./][^"']*)/g)) {
      const first = (m[1] ?? "").split("/")[0];
      if (first && !first.startsWith(".") && !first.startsWith("@") && !NODE_BUILTINS.has(first)) refs.add(first);
    }
    for (const m of f.content.matchAll(/from\s+["'](@[^"'/]+\/[^"'/]+)/g)) {
      if (!NODE_BUILTINS.has(m[1])) refs.add(m[1]);
    }
    // Bare side-effect imports (import "pkg") and dynamic import("pkg").
    for (const m of f.content.matchAll(/import(?:\s*\(\s*|\s+)(["'])([^"'.][^"']*)\1/g)) {
      const name = m[2] ?? "";
      const first = name.split("/")[0];
      if (first && !first.startsWith(".") && !first.startsWith("@") && !NODE_BUILTINS.has(first)) refs.add(first);
      const scoped = /^@[^/]+\/[^/]+/.exec(name)?.[0];
      if (scoped && !NODE_BUILTINS.has(scoped)) refs.add(scoped);
    }
  }
  return refs;
}

const MAX_FAIL_NAMES = 8;
const MAX_FAIL_NAME_CHARS = 80;
/** CSI and 2-byte escape sequences from colored test reporters. */
const ANSI_ESCAPE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

export interface FailingTests {
  /** Unique failing names in the output, including names past the display cap. */
  count: number;
  /** The first names, capped for the badge and the context file. */
  names: string[];
}

/** One-line Verify badge text from parsed failing tests. */
export function verifyFailSummary(parsed: FailingTests): string {
  return `${parsed.count} failed: ${parsed.names.join(", ")}`;
}

/**
 * Collect failing test names from pytest, cargo, go, and jest output.
 * Unknown harnesses return no names. Callers must not fail Verify when
 * this list is empty.
 */
export function parseFailingTests(output: string): FailingTests {
  if (!output) return { count: 0, names: [] };
  const text = output.replace(ANSI_ESCAPE, "");
  const seen = new Set<string>();
  const names: string[] = [];
  const add = (raw: string): void => {
    const name = raw.replace(/\s+/g, " ").replace(/`/g, "").trim().slice(0, MAX_FAIL_NAME_CHARS);
    if (!name || seen.has(name)) return;
    seen.add(name);
    if (names.length < MAX_FAIL_NAMES) names.push(name);
  };
  for (const rawLine of text.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0 || line.length > 500) continue;
    const go = /^--- FAIL: (\S+)/.exec(line);
    if (go) {
      add(go[1] ?? "");
      continue;
    }
    const cargo = /^test (.+?) \.\.\. FAILED\s*$/.exec(line);
    if (cargo) {
      add(cargo[1] ?? "");
      continue;
    }
    const pytest = /^FAILED (.+?)(?:\s+-\s+|$)/.exec(line);
    if (pytest) {
      add(pytest[1] ?? "");
      continue;
    }
    const jest = /^\s*●\s+(.+)$/.exec(line);
    if (!jest) continue;
    const rest = (jest[1] ?? "").trim();
    if (/^(Expected|Received|Difference|at\s)/i.test(rest)) continue;
    add(rest);
  }
  return { count: seen.size, names };
}

/**
 * The evidence engine. Verify, API, dependencies, and footprint run
 * per candidate. The caller serializes those A then B. Benchmarks warm
 * both sides, then interleave scored samples (WORLDLINES §6.8).
 */
export class EvidenceEngine {
  constructor(private deps: EvidenceDeps) {}

  /** The non-benchmark evidence for one candidate. */
  async measure(_label: "A" | "B", cand: CandidateFacts): Promise<EvidenceRecord[]> {
    const out: EvidenceRecord[] = [];
    const head = await this.deps.captureHead(cand.root, join(cand.root, ".git"), this.deps.baseStateId);
    const stateId = head.commit;

    const verify = await this.verifyEvidence(cand, stateId);
    if (verify) out.push(verify);
    const dependencies = await this.dependencyEvidence(cand, stateId);
    if (dependencies) out.push(dependencies);
    const api = await this.apiEvidence(cand, stateId);
    if (api) out.push(api);
    const footprint = await this.footprintEvidence(cand, stateId, dependencies?.result as Record<string, unknown> | undefined);
    if (footprint) out.push(footprint);
    const trajectory = await this.trajectoryEvidence(cand, stateId);
    if (trajectory) out.push(trajectory);
    return out;
  }

  /**
   * Warm A, warm B, then sample A then B for each scored round. One
   * sandboxed run at a time. A failed side does not abort the other.
   */
  async measureBenchmarks(
    cands: Record<"A" | "B", CandidateFacts>,
    stateIds: Record<"A" | "B", string>,
  ): Promise<Record<"A" | "B", EvidenceRecord>> {
    const cfg = this.deps.benchmarkConfig();
    if (!cfg) {
      const reason = "the base declares no benchmark harness (termina.benchmark)";
      return {
        A: this.benchmarkUnavailable(stateIds.A, reason),
        B: this.benchmarkUnavailable(stateIds.B, reason),
      };
    }
    const n = cfg.samples;
    const samples: Record<"A" | "B", number[]> = { A: [], B: [] };
    const out: Partial<Record<"A" | "B", EvidenceRecord>> = {};

    const warmA = await this.warmBenchmark(cands.A, stateIds.A, cfg.command);
    const warmB = await this.warmBenchmark(cands.B, stateIds.B, cfg.command);
    if (warmA) out.A = warmA;
    if (warmB) out.B = warmB;

    const sampleSide = async (label: "A" | "B", start: number): Promise<EvidenceRecord | null> => {
      for (let i = start; i < n; i++) {
        const fail = await this.scoredSample(cands[label], stateIds[label], cfg, samples[label], i);
        if (fail) return fail;
      }
      return null;
    };

    if (out.A && !out.B) {
      out.B = (await sampleSide("B", 0)) ?? this.benchmarkPass(stateIds.B, cfg, samples.B);
    } else if (out.B && !out.A) {
      out.A = (await sampleSide("A", 0)) ?? this.benchmarkPass(stateIds.A, cfg, samples.A);
    } else if (!out.A && !out.B) {
      for (let i = 0; i < n; i++) {
        if (!out.A) {
          const fail = await this.scoredSample(cands.A, stateIds.A, cfg, samples.A, i);
          if (fail) {
            out.A = fail;
            out.B = (await sampleSide("B", i)) ?? this.benchmarkPass(stateIds.B, cfg, samples.B);
            break;
          }
        }
        if (!out.B) {
          const fail = await this.scoredSample(cands.B, stateIds.B, cfg, samples.B, i);
          if (fail) {
            out.B = fail;
            out.A = (await sampleSide("A", i + 1)) ?? this.benchmarkPass(stateIds.A, cfg, samples.A);
            break;
          }
        }
      }
      if (!out.A) out.A = this.benchmarkPass(stateIds.A, cfg, samples.A);
      if (!out.B) out.B = this.benchmarkPass(stateIds.B, cfg, samples.B);
    }
    return { A: out.A ?? this.benchmarkUnavailable(stateIds.A, "the benchmark harness is unavailable"), B: out.B ?? this.benchmarkUnavailable(stateIds.B, "the benchmark harness is unavailable") };
  }

  /**
   * Verify: the base test command in the candidate sandbox, state-checked.
   * Extra attempts share the same 300 s budget. Ranking uses the first run.
   */
  private async verifyEvidence(cand: CandidateFacts, stateId: string): Promise<EvidenceRecord | null> {
    const tc = this.deps.baseTestCommand();
    if (!tc) {
      return { kind: "verify", stateId, baseStateId: this.deps.baseStateId, status: "unavailable", result: {}, reason: "the shared base has no test command" };
    }
    const command = [tc.command, ...tc.args];
    const budgetEnd = Date.now() + VERIFY_BUDGET_MS;
    const stateTree = (await this.deps.captureHead(cand.root, join(cand.root, ".git"), this.deps.baseStateId)).tree;

    const runAttempt = async (timeoutMs: number): Promise<{ code: number; stdout: string; timedOut: boolean; sourceUnchanged: boolean }> => {
      const run = await this.deps.runSandboxed(cand, command, timeoutMs);
      const after = await this.deps.captureHead(cand.root, join(cand.root, ".git"), null);
      return { code: run.code, stdout: run.stdout, timedOut: run.timedOut, sourceUnchanged: after.tree === stateTree };
    };

    const firstStarted = Date.now();
    const first = await runAttempt(Math.max(0, budgetEnd - Date.now()));
    const firstMs = Math.max(0, Date.now() - firstStarted);
    const canonicalPass = !first.timedOut && first.code === 0 && first.sourceUnchanged;
    const status = first.timedOut ? "fail" : canonicalPass ? "pass" : "fail";
    let failedCount = 0;
    let failedNames: string[] = [];
    if (status === "fail" && !first.timedOut && first.code !== 0) {
      try {
        const parsed = parseFailingTests(first.stdout);
        failedCount = parsed.count;
        failedNames = parsed.names;
      } catch {
        /* Ranking uses status, not names. */
      }
    }

    let passCount = canonicalPass ? 1 : 0;
    let runs = 1;
    // Extra attempts measure flake. Skip when the first run timed out or
    // already changed the source: those extras cannot count.
    if (!first.timedOut && first.sourceUnchanged) {
      while (runs < MAX_VERIFY_RUNS) {
        const remaining = budgetEnd - Date.now();
        if (remaining < MIN_VERIFY_REPEAT_MS) break;
        if (remaining < firstMs) break;
        const extra = await runAttempt(remaining);
        if (extra.timedOut) break;
        runs++;
        if (extra.code === 0 && extra.sourceUnchanged) passCount++;
      }
    }

    return {
      kind: "verify",
      stateId,
      baseStateId: this.deps.baseStateId,
      status,
      result: {
        command: tc.label,
        code: first.code,
        timedOut: first.timedOut,
        sourceUnchanged: first.sourceUnchanged,
        output: first.stdout.slice(-2000),
        passCount,
        runs,
        ...(failedCount > 0 ? { failedCount, failedNames } : {}),
      },
      reason:
        first.timedOut ? "the test command timed out" :
        first.code !== 0 ? `the test command exited with code ${first.code}` :
        !first.sourceUnchanged ? "the tests changed the source" : null,
    };
  }

  /** Dependencies: added/removed/changed declarations vs the shared base. */
  private async dependencyEvidence(cand: CandidateFacts, stateId: string): Promise<EvidenceRecord | null> {
    const basePkg = await this.deps.store.readBlob(this.deps.baseStateId, "package.json");
    const headPkg = await readCandidateText(cand.root, "package.json");
    if (!basePkg || headPkg === null) {
      return { kind: "dependencies", stateId, baseStateId: this.deps.baseStateId, status: "unavailable", result: {}, reason: "the base or head has no package manifest" };
    }
    const diff = dependencyDiff(basePkg.toString("utf8"), headPkg);
    // Reject an external package used by candidate source when it is
    // undeclared, even when it exists in the cloned runtime (§6.9).
    const declared = declaredNames(basePkg.toString("utf8"));
    for (const name of declaredNames(headPkg)) declared.add(name);
    const sourceFiles = await this.deps.sourceFilesOf(cand.root);
    const referenced = referencedPackages(sourceFiles);
    const undeclared = [...referenced].filter((name) => !declared.has(name)).sort();
    // Show when a candidate changes the test configuration (§6.8): the
    // evidence still runs the captured base command.
    const baseScript = testScriptOf(basePkg.toString("utf8"));
    const headScript = testScriptOf(headPkg);
    const testScriptChanged = baseScript !== headScript;
    return {
      kind: "dependencies",
      stateId,
      baseStateId: this.deps.baseStateId,
      status: undeclared.length > 0 ? "fail" : "pass",
      result: { ...diff, undeclared, testScriptChanged },
      reason:
        undeclared.length > 0
          ? `candidate source uses undeclared packages: ${undeclared.join(", ")}`
          : diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0
            ? null
            : "declaration changes measured",
    };
  }

  /** API: the public roots' normalized declaration signatures (base vs head). */
  private async apiEvidence(cand: CandidateFacts, stateId: string): Promise<EvidenceRecord | null> {
    const basePkg = await this.deps.store.readBlob(this.deps.baseStateId, "package.json");
    if (!basePkg) return { kind: "api", stateId, baseStateId: this.deps.baseStateId, status: "unavailable", result: {}, reason: "the base has no package manifest" };
    const roots = publicRoots(basePkg.toString("utf8"));
    if (roots.length === 0) {
      return { kind: "api", stateId, baseStateId: this.deps.baseStateId, status: "unavailable", result: {}, reason: "the package declares no public exports or main" };
    }
    const manifest = async (sourceText: (rel: string) => Promise<string | null>): Promise<Record<string, string>> => {
      const out: Record<string, string> = {};
      for (const root of roots) {
        // Map .js to its sibling .d.ts when present; keep the raw file else.
        const candidates = root.endsWith(".d.ts") ? [root] : [root.replace(/\.(js|mjs|cjs)$/, ".d.ts"), root];
        for (const rel of candidates) {
          const text = await sourceText(rel);
          if (text !== null) {
            out[rel] = normalizeSignature(text);
            break;
          }
        }
      }
      return out;
    };
    const baseManifest = await manifest(async (rel) => {
      const buf = await this.deps.store.readBlob(this.deps.baseStateId, rel);
      return buf === null ? null : buf.toString("utf8");
    });
    const headManifest = await manifest(async (rel) => {
      const path = await candidatePath(cand.root, rel);
      return path ? readText(path) : null;
    });
    if (Object.keys(baseManifest).length === 0) {
      return { kind: "api", stateId, baseStateId: this.deps.baseStateId, status: "unavailable", result: {}, reason: "no public root resolves to a measurable file" };
    }
    const removed: string[] = [];
    const changed: string[] = [];
    for (const [rel, sig] of Object.entries(baseManifest)) {
      const headSig = headManifest[rel];
      if (headSig === undefined) removed.push(rel);
      else if (headSig !== sig) changed.push(rel);
    }
    return {
      kind: "api",
      stateId,
      baseStateId: this.deps.baseStateId,
      status: removed.length === 0 && changed.length === 0 ? "pass" : "fail",
      result: { roots, removed, changed },
      reason: removed.length > 0 || changed.length > 0 ? `measured signatures changed: ${[...removed, ...changed].join(", ")}` : null,
    };
  }

  /** Footprint: changed source files and changed executable lines. */
  private async footprintEvidence(_cand: CandidateFacts, stateId: string, depsResult?: Record<string, unknown>): Promise<EvidenceRecord | null> {
    const changed = await this.deps.store.diffTree(this.deps.baseStateId, stateId);
    let changedLines = 0;
    let changedFiles = 0;
    let bytes = 0;
    for (const c of changed) {
      if (c.status === "deleted") continue;
      changedFiles++;
      const buf = await this.deps.store.readBlob(stateId, c.relPath);
      if (buf) {
        bytes += buf.length;
        changedLines += buf.toString("utf8").split("\n").length;
      }
    }
    const added = Array.isArray(depsResult?.added) ? (depsResult.added as string[]).length : 0;
    return {
      kind: "footprint",
      stateId,
      baseStateId: this.deps.baseStateId,
      status: "pass",
      result: { changedFiles, changedLines, changedBytes: bytes, addedDeclarations: added },
      reason: null,
    };
  }

  /**
   * File-tool outcomes and sidecar signals from this candidate's event
   * log. A truncated or missing log is unavailable. A missing test
   * command in the sidecar is not a fail.
   */
  private async trajectoryEvidence(cand: CandidateFacts, stateId: string): Promise<EvidenceRecord | null> {
    const id = cand.terminalId?.trim() ?? "";
    if (!cand.eventsDir || !id || id.includes("/") || id.includes("\\") || id.includes("..")) {
      return {
        kind: "trajectory",
        stateId,
        baseStateId: this.deps.baseStateId,
        status: "unavailable",
        result: {},
        reason: "the candidate has no event log",
      };
    }
    const file = join(cand.eventsDir, `${id}.jsonl`);
    const rel = relative(resolve(cand.eventsDir), resolve(file));
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
      return {
        kind: "trajectory",
        stateId,
        baseStateId: this.deps.baseStateId,
        status: "unavailable",
        result: {},
        reason: "the candidate event log path is invalid",
      };
    }
    try {
      const info = await stat(file);
      if (!info.isFile()) {
        return {
          kind: "trajectory",
          stateId,
          baseStateId: this.deps.baseStateId,
          status: "unavailable",
          result: {},
          reason: "the candidate has no event log",
        };
      }
      if (info.size >= MAX_SIDECAR_BYTES) {
        return {
          kind: "trajectory",
          stateId,
          baseStateId: this.deps.baseStateId,
          status: "unavailable",
          result: {},
          reason: "the candidate event log was truncated",
        };
      }
      const buf = await readFile(file);
      if (buf.byteLength >= MAX_SIDECAR_BYTES) {
        return {
          kind: "trajectory",
          stateId,
          baseStateId: this.deps.baseStateId,
          status: "unavailable",
          result: {},
          reason: "the candidate event log was truncated",
        };
      }
      const text = buf.toString("utf8");
      const label = this.deps.baseTestCommand()?.label ?? null;
      const parsed = parseTrajectoryLog(text, label);
      return {
        kind: "trajectory",
        stateId,
        baseStateId: this.deps.baseStateId,
        status: "pass",
        result: { ...parsed },
        reason: trajectoryReason(parsed),
      };
    } catch {
      return {
        kind: "trajectory",
        stateId,
        baseStateId: this.deps.baseStateId,
        status: "unavailable",
        result: {},
        reason: "the candidate has no event log",
      };
    }
  }

  private benchmarkUnavailable(stateId: string, reason: string): EvidenceRecord {
    return { kind: "benchmark", stateId, baseStateId: this.deps.baseStateId, status: "unavailable", result: {}, reason };
  }

  private async warmBenchmark(cand: CandidateFacts, stateId: string, command: string[]): Promise<EvidenceRecord | null> {
    const warm = await this.deps.runSandboxed(cand, command, 120_000);
    if (warm.code !== 0) {
      return {
        kind: "benchmark",
        stateId,
        baseStateId: this.deps.baseStateId,
        status: "fail",
        result: {},
        reason: `the benchmark harness failed (code ${warm.code})`,
      };
    }
    return null;
  }

  private async scoredSample(
    cand: CandidateFacts,
    stateId: string,
    cfg: NonNullable<ReturnType<EvidenceDeps["benchmarkConfig"]>>,
    samples: number[],
    index: number,
  ): Promise<EvidenceRecord | null> {
    const r = await this.deps.runSandboxed(cand, cfg.command, 120_000);
    const value = parseBenchmarkValue(r.stdout, cfg.unit);
    if (value === null) {
      return {
        kind: "benchmark",
        stateId,
        baseStateId: this.deps.baseStateId,
        status: "fail",
        result: { samples: [...samples] },
        reason: `sample ${index + 1} produced no ${cfg.unit} measurement`,
      };
    }
    samples.push(value);
    return null;
  }

  private benchmarkPass(
    stateId: string,
    cfg: NonNullable<ReturnType<EvidenceDeps["benchmarkConfig"]>>,
    samples: number[],
  ): EvidenceRecord {
    const sorted = [...samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const p25 = sorted[Math.floor(sorted.length * 0.25)];
    const p75 = sorted[Math.floor(sorted.length * 0.75)];
    return {
      kind: "benchmark",
      stateId,
      baseStateId: this.deps.baseStateId,
      status: "pass",
      result: { unit: cfg.unit, direction: cfg.direction, samples: [...samples], median, p25, p75 },
      reason: null,
    };
  }
}

/** Counts from one candidate sidecar. Last file-tool outcome matches Plan Board. */
export interface TrajectorySignals {
  fileToolStarts: number;
  fileToolErrors: number;
  lastErrorCount: number;
  openFileTools: number;
  timedOut: number;
  cancelled: number;
  testLabelSeen: boolean;
}

/**
 * Parse one sidecar text. Counts the last agent_start run. Shell
 * commands are not logged; a missing test label is not a fail.
 */
export function parseTrajectoryLog(text: string, testLabel: string | null): TrajectorySignals {
  const lines = text.split("\n");
  let start = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.trim()) continue;
    const rec = parseSidecarRecord(line);
    if (rec && sidecarEventFromRecord(rec)?.t === "agent_start") {
      start = i;
      break;
    }
  }
  const pending = new Map<string, string>();
  const lastOutcome = new Map<string, "ok" | "error">();
  let fileToolStarts = 0;
  let fileToolErrors = 0;
  let timedOut = 0;
  let cancelled = 0;
  let testLabelSeen = false;
  const needle = testLabel && testLabel.trim() ? testLabel.trim() : "";
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const rec = parseSidecarRecord(line);
    if (!rec) continue;
    if (rec.timedOut === true) timedOut++;
    if (rec.cancelled === true) cancelled++;
    if (needle && typeof rec.command === "string" && rec.command.includes(needle)) testLabelSeen = true;
    const event = sidecarEventFromRecord(rec);
    if (event?.t === "tool") {
      const path = event.path ?? "";
      const toolCallId = event.toolCallId?.trim() ?? "";
      if (!path || !toolCallId) continue;
      fileToolStarts++;
      pending.set(toolCallId, path);
      continue;
    }
    if (event?.t === "tool_end") {
      const toolCallId = event.toolCallId?.trim() ?? "";
      if (!toolCallId) continue;
      const path = pending.get(toolCallId);
      pending.delete(toolCallId);
      if (path === undefined) continue;
      const err = event.isError === true;
      if (err) fileToolErrors++;
      lastOutcome.set(path, err ? "error" : "ok");
    }
  }
  let lastErrorCount = 0;
  for (const outcome of lastOutcome.values()) {
    if (outcome === "error") lastErrorCount++;
  }
  return { fileToolStarts, fileToolErrors, lastErrorCount, openFileTools: pending.size, timedOut, cancelled, testLabelSeen };
}

function trajectoryReason(parsed: TrajectorySignals): string {
  const parts = [`${parsed.fileToolErrors} file-tool errors`];
  if (parsed.lastErrorCount > 0) parts.push(`${parsed.lastErrorCount} paths ended in error`);
  if (parsed.openFileTools > 0) parts.push(`${parsed.openFileTools} file tools without an end`);
  if (parsed.timedOut > 0) parts.push(`${parsed.timedOut} timeouts`);
  if (parsed.cancelled > 0) parts.push(`${parsed.cancelled} cancelled`);
  if (!parsed.testLabelSeen) parts.push("test command not visible in the sidecar");
  return parts.join("; ");
}

/** Parse one "name value unit" line from a benchmark run. */
export function parseBenchmarkValue(stdout: string, unit: string): number | null {
  for (const line of stdout.split("\n")) {
    const m = /^\s*[\w./-]+\s+([0-9.]+)\s*([a-zA-Z]+)?\s*$/.exec(line);
    if (!m) continue;
    if (m[2] !== undefined && m[2] !== unit) continue;
    const v = Number(m[1]);
    if (Number.isFinite(v)) return v;
  }
  return null;
}

/**
 * The four fixed profile verdicts from measured evidence. Ranking uses
 * only current evidence: verify pass, no Mine-path change, state fresh.
 */
export function rankProfiles(
  summary: Record<"A" | "B", EvidenceRecord[]>,
  mineReason: Record<"A" | "B", string | null>,
  thresholdFraction = 0.05,
): ProfileVerdict[] {
  const rec = (label: "A" | "B", kind: EvidenceKind): EvidenceRecord | undefined => summary[label].find((r) => r.kind === kind);
  const verifyOk = (label: "A" | "B"): boolean => rec(label, "verify")?.status === "pass";
  const eligible = (label: "A" | "B", requireVerify: boolean): string => {
    if (mineReason[label]) return `ineligible: ${mineReason[label]}`;
    if (requireVerify && !verifyOk(label)) {
      const v = rec(label, "verify");
      return `ineligible: ${v?.reason ?? "verify evidence is missing"}`;
    }
    return "";
  };

  const verdicts: ProfileVerdict[] = [];

  // Fewer dependencies: fewer added declarations wins; zero beats one.
  {
    const el = { A: eligible("A", true), B: eligible("B", true) };
    // An undeclared external package in candidate source is ineligible
    // (WORLDLINES §6.9), even when it exists in the cloned runtime.
    for (const l of ["A", "B"] as const) {
      if (el[l]) continue;
      const d = rec(l, "dependencies");
      if (d?.status === "fail" && (d.result.undeclared as string[] | undefined)?.length) el[l] = `ineligible: ${d.reason}`;
    }
    const added = { A: Number((rec("A", "dependencies")?.result.added as string[] | undefined)?.length ?? 0), B: Number((rec("B", "dependencies")?.result.added as string[] | undefined)?.length ?? 0) };
    let winner: ProfileVerdict["winner"] = "tie";
    let reason = "both candidates add the same number of declarations";
    if (el.A || el.B) {
      winner = "unavailable";
      reason = el.A && el.B ? "both candidates are ineligible" : el.A ? `candidate A is ineligible: ${el.A}` : `candidate B is ineligible: ${el.B}`;
    } else if (added.B > added.A) {
      winner = "A";
      reason = `A adds ${added.A} declarations, B adds ${added.B}`;
    } else if (added.A > added.B) {
      winner = "B";
      reason = `B adds ${added.B} declarations, A adds ${added.A}`;
    }
    verdicts.push({ profile: "fewer-dependencies", winner, reason, eligibility: el });
  }

  // Preserve API: removed or changed measured signatures fail the challenger.
  {
    const el = { A: eligible("A", true), B: eligible("B", true) };
    const apiFail = { A: rec("A", "api")?.status === "fail" ? (rec("A", "api")?.reason ?? "api changed") : null, B: rec("B", "api")?.status === "fail" ? (rec("B", "api")?.reason ?? "api changed") : null };
    const unavailable = !rec("A", "api") || !rec("B", "api") || rec("A", "api")?.status === "unavailable" || rec("B", "api")?.status === "unavailable";
    let winner: ProfileVerdict["winner"] = "tie";
    let reason = "the measured public API is unchanged";
    if (el.A || el.B) {
      winner = "unavailable";
      reason = el.A && el.B ? "both candidates are ineligible" : el.A ? `candidate A is ineligible: ${el.A}` : `candidate B is ineligible: ${el.B}`;
    } else if (apiFail.B) {
      winner = "A";
      reason = `B fails the API gate: ${apiFail.B}`;
    } else if (apiFail.A) {
      winner = "B";
      reason = `A fails the API gate: ${apiFail.A}`;
    } else if (unavailable) {
      winner = "unavailable";
      reason = rec("A", "api")?.reason ?? rec("B", "api")?.reason ?? "the API surface is not measurable";
    }
    verdicts.push({ profile: "preserve-api", winner, reason, eligibility: el });
  }

  // Simpler implementation: added declarations, changed files, changed lines.
  {
    const el = { A: eligible("A", true), B: eligible("B", true) };
    const metric = (label: "A" | "B"): [number, number, number] => {
      const d = rec(label, "dependencies");
      const f = rec(label, "footprint");
      return [Number((d?.result.added as string[] | undefined)?.length ?? 0), Number(f?.result.changedFiles ?? 0), Number(f?.result.changedLines ?? 0)];
    };
    let winner: ProfileVerdict["winner"] = "tie";
    let reason = "equal verified footprint";
    if (el.A || el.B) {
      winner = "unavailable";
      reason = el.A && el.B ? "both candidates are ineligible" : el.A ? `candidate A is ineligible: ${el.A}` : `candidate B is ineligible: ${el.B}`;
    } else {
      const mA = metric("A");
      const mB = metric("B");
      const cmp = mA[0] - mB[0] || mA[1] - mB[1] || mA[2] - mB[2];
      if (cmp < 0) {
        winner = "A";
        reason = `A has the smallest verified footprint (${mA.join("/")} vs ${mB.join("/")})`;
      } else if (cmp > 0) {
        winner = "B";
        reason = `B has the smallest verified footprint (${mB.join("/")} vs ${mA.join("/")})`;
      }
    }
    verdicts.push({ profile: "simpler-implementation", winner, reason, eligibility: el });
  }

  // Performance-first: benchmark with threshold and variability bounds.
  {
    const el = { A: eligible("A", true), B: eligible("B", true) };
    const bm = { A: rec("A", "benchmark"), B: rec("B", "benchmark") };
    let winner: ProfileVerdict["winner"] = "unavailable";
    let reason = "the benchmark harness is unavailable";
    if (el.A || el.B) {
      reason = el.A && el.B ? "both candidates are ineligible" : el.A ? `candidate A is ineligible: ${el.A}` : `candidate B is ineligible: ${el.B}`;
    } else if (!bm.A || !bm.B || bm.A.status === "unavailable" || bm.B.status === "unavailable") {
      reason = bm.A?.reason ?? bm.B?.reason ?? "the benchmark harness is unavailable";
    } else {
      const medA = finiteNumber(bm.A.result.median);
      const medB = finiteNumber(bm.B.result.median);
      const varA = variability(bm.A);
      const varB = variability(bm.B);
      if (medA === null || medB === null) {
        reason = "the benchmark measurement is not a finite number";
      } else if (varA === null || varB === null || varA > 0.2 || varB > 0.2) {
        reason = `variability exceeds the allowed bound (A ${varA === null ? "?" : (varA * 100).toFixed(0)}%, B ${varB === null ? "?" : (varB * 100).toFixed(0)}%)`;
      } else {
        const med = { A: medA, B: medB };
        const direction = bm.A.result.direction === "higher" ? 1 : -1;
        const effect = (med.B - med.A) / Math.max(med.A, med.B, 1e-9) * direction;
        const threshold = thresholdFraction;
        if (Math.abs(effect) <= threshold) {
          winner = "tie";
          reason = `the effect (${(Math.abs(effect) * 100).toFixed(1)}%) does not exceed the ${threshold * 100}% threshold`;
        } else {
          winner = effect > 0 ? "B" : "A";
          reason = `${winner} wins (median ${med[winner]} vs ${med[winner === "A" ? "B" : "A"]} ${bm.A.result.unit})`;
        }
      }
      // Overlap is display only. It does not change the winner.
      const overlap = iqrOverlapClause(bm.A, bm.B);
      if (overlap) reason += overlap;
    }
    verdicts.push({ profile: "performance-first", winner, reason, eligibility: el });
  }

  return verdicts;
}

/** A finite number from an evidence field. Null and non-numbers are not zero. */
function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The interquartile spread of a benchmark record, or null. */
function variability(rec: EvidenceRecord | undefined): number | null {
  if (!rec) return null;
  const median = finiteNumber(rec.result.median);
  const p25 = finiteQuartile(rec, "p25");
  const p75 = finiteQuartile(rec, "p75");
  if (median === null || p25 === null || p75 === null || p25 > p75) return null;
  return (p75 - p25) / median;
}

function finiteQuartile(rec: EvidenceRecord, key: "p25" | "p75"): number | null {
  return finiteNumber(rec.result[key]);
}

/**
 * Whether the closed IQR intervals intersect. Returns null when either
 * side lacks a finite p25/p75 pair. Does not rank.
 */
function iqrOverlapClause(a: EvidenceRecord, b: EvidenceRecord): string | null {
  const a25 = finiteQuartile(a, "p25");
  const a75 = finiteQuartile(a, "p75");
  const b25 = finiteQuartile(b, "p25");
  const b75 = finiteQuartile(b, "p75");
  if (a25 === null || a75 === null || b25 === null || b75 === null) return null;
  if (a25 > a75 || b25 > b75) return null;
  const overlap = a25 <= b75 && b25 <= a75;
  return overlap ? "; IQR intervals overlap" : "; IQR intervals do not overlap";
}

/** The Mine-path reason of a candidate, or null. */
export async function mineChangeReason(
  store: SnapshotStore,
  baseStateId: string,
  headStateId: string,
  primaryRoot: string,
  mineFiles: Set<string>,
  realpath: (p: string) => Promise<string>,
): Promise<string | null> {
  const changed = await store.diffTree(baseStateId, headStateId);
  for (const c of changed) {
    const abs = join(primaryRoot, c.relPath);
    try {
      if (mineFiles.has(await realpath(abs))) return `the candidate changes a file you own: ${c.relPath}`;
    } catch {
      /* A deleted path cannot match a Mine path. */
    }
  }
  return null;
}
