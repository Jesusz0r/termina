/**
 * Evidence engine (WORLDLINES §6.8, §6.9).
 *
 * Computes deterministic, immutable evidence for one candidate against the
 * shared base: Verify (the base test command, in the candidate sandbox),
 * dependency declarations, the public API manifest, the source footprint,
 * and the benchmark harness. Ranking consumes only current evidence.
 */
import { readFile, realpath as fsRealpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { SnapshotStore } from "./worldline-git.js";

export type EvidenceKind = "verify" | "dependencies" | "api" | "footprint" | "benchmark";
export type ProfileName = "fewer-dependencies" | "preserve-api" | "simpler-implementation" | "performance-first";

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
  profile: ProfileName;
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
}

export interface EvidenceDeps {
  store: SnapshotStore;
  baseStateId: string;
  primaryRoot: string;
  mineFiles: Set<string>;
  /** Capture a candidate head off the main thread. */
  captureHead(root: string, gitDir: string, parent: string | null): Promise<{ commit: string; tree: string }>;
  /** Run a shell command inside the candidate sandbox; bounded output. */
  runSandboxed(cand: CandidateFacts, command: string[], timeoutMs: number): Promise<{ code: number; stdout: string; timedOut: boolean }>;
  /** The test command of the shared base (from its package manifest). */
  baseTestCommand(): { command: string; args: string[]; label: string } | null;
  /** The benchmark harness config of the shared base, or null. */
  benchmarkConfig(): { command: string[]; unit: string; direction: "lower" | "higher"; samples: number; thresholdPct: number } | null;
  /** The candidate's source files (tracked, bounded) for package checks. */
  sourceFilesOf(root: string): Promise<Array<{ relPath: string; content: string }>>;
}

/** The four fixed profiles (WORLDLINES §6.9). */
export const PROFILES: ProfileName[] = ["fewer-dependencies", "preserve-api", "simpler-implementation", "performance-first"];

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
  }
  return refs;
}

/**
 * The evidence engine. One run measures one candidate; the caller
 * serializes the A and B runs (WORLDLINES §6.8: run serially).
 */
export class EvidenceEngine {
  constructor(private deps: EvidenceDeps) {}

  /** The full evidence record set for one candidate. */
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
    const benchmark = await this.benchmarkEvidence(cand, stateId);
    if (benchmark) out.push(benchmark);
    return out;
  }

  /** Verify: the base test command in the candidate sandbox, state-checked. */
  private async verifyEvidence(cand: CandidateFacts, stateId: string): Promise<EvidenceRecord | null> {
    const tc = this.deps.baseTestCommand();
    if (!tc) {
      return { kind: "verify", stateId, baseStateId: this.deps.baseStateId, status: "unavailable", result: {}, reason: "the shared base has no test command" };
    }
    const stateTree = (await this.deps.captureHead(cand.root, join(cand.root, ".git"), this.deps.baseStateId)).tree;
    const run = await this.deps.runSandboxed(cand, [...tc.command.split(/\s+/), ...tc.args], 300_000);
    // A test that changed the source is not evidence: re-capture and compare
    // the trees (commit hashes differ by parent and timestamp).
    const after = await this.deps.captureHead(cand.root, join(cand.root, ".git"), null);
    const sourceUnchanged = after.tree === stateTree;
    const status = run.timedOut ? "fail" : run.code === 0 && sourceUnchanged ? "pass" : "fail";
    return {
      kind: "verify",
      stateId,
      baseStateId: this.deps.baseStateId,
      status,
      result: { command: tc.label, code: run.code, timedOut: run.timedOut, sourceUnchanged, output: run.stdout.slice(-2000) },
      reason:
        run.timedOut ? "the test command timed out" :
        run.code !== 0 ? `the test command exited with code ${run.code}` :
        !sourceUnchanged ? "the tests changed the source" : null,
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

  /** Benchmark: interleaved samples of the configured harness. */
  private async benchmarkEvidence(cand: CandidateFacts, stateId: string): Promise<EvidenceRecord | null> {
    const cfg = this.deps.benchmarkConfig();
    if (!cfg) {
      return { kind: "benchmark", stateId, baseStateId: this.deps.baseStateId, status: "unavailable", result: {}, reason: "the base declares no benchmark harness (termina.benchmark)" };
    }
    const samples: number[] = [];
    const warm = await this.deps.runSandboxed(cand, cfg.command, 120_000);
    if (warm.code !== 0) {
      return { kind: "benchmark", stateId, baseStateId: this.deps.baseStateId, status: "fail", result: {}, reason: `the benchmark harness failed (code ${warm.code})` };
    }
    for (let i = 0; i < cfg.samples; i++) {
      const r = await this.deps.runSandboxed(cand, cfg.command, 120_000);
      const value = parseBenchmarkValue(r.stdout, cfg.unit);
      if (value === null) {
        return { kind: "benchmark", stateId, baseStateId: this.deps.baseStateId, status: "fail", result: { samples }, reason: `sample ${i + 1} produced no ${cfg.unit} measurement` };
      }
      samples.push(value);
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const p25 = sorted[Math.floor(sorted.length * 0.25)];
    const p75 = sorted[Math.floor(sorted.length * 0.75)];
    return {
      kind: "benchmark",
      stateId,
      baseStateId: this.deps.baseStateId,
      status: "pass",
      result: { unit: cfg.unit, direction: cfg.direction, samples, median, p25, p75 },
      reason: null,
    };
  }
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
      const med = { A: Number(bm.A.result.median), B: Number(bm.B.result.median) };
      const varA = variability(bm.A);
      const varB = variability(bm.B);
      if (varA === null || varB === null || varA > 0.2 || varB > 0.2) {
        reason = `variability exceeds the allowed bound (A ${varA === null ? "?" : (varA * 100).toFixed(0)}%, B ${varB === null ? "?" : (varB * 100).toFixed(0)}%)`;
      } else {
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
    }
    verdicts.push({ profile: "performance-first", winner, reason, eligibility: el });
  }

  return verdicts;
}

/** The interquartile spread of a benchmark record, or null. */
function variability(rec: EvidenceRecord | undefined): number | null {
  if (!rec) return null;
  const median = Number(rec.result.median);
  const p25 = Number(rec.result.p25);
  const p75 = Number(rec.result.p75);
  if (!median) return null;
  return (p75 - p25) / median;
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
