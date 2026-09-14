/**
 * Settle-gate pure helpers (#123).
 *
 * Trust-but-verify for `agent_settled`: when a run changed files through the
 * engine's file tools, success requires an observed check command covering
 * the edits. Claims in the final report are confronted with the tool log.
 * Bash-applied patches (git apply, sed -i, redirects) are not tracked as
 * edits; only successful `edit`/`write_file` calls count. Heuristic gaps
 * fail toward a grace nudge, never toward an immediate failure.
 */
import type { ToolOutcome, ToolUse } from "./tools.ts";

export interface GateToolObservation {
  readonly name: string;
  readonly command?: string;
  readonly path?: string;
  /** The tool actually executed (not denied, invalid, or skipped). */
  readonly executed: boolean;
  readonly ok: boolean;
  readonly exitCode?: number | null;
  /** Bounded edit snippets for the critic change summary (#124). */
  readonly oldText?: string;
  readonly newText?: string;
  readonly contentChars?: number;
}

const MAX_OBSERVATION_TEXT = 4 * 1024;
const MAX_CRITIC_SNIPPET = 300;

function boundedText(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.length > MAX_OBSERVATION_TEXT ? value.slice(0, MAX_OBSERVATION_TEXT) : value;
}

/**
 * Record one executed tool call for the settle gate. Callers skip
 * structurally non-executed calls (invalid arguments, duplicate reuse,
 * interruption placeholders); this only translates the outcome.
 */
export function recordGateObservation(
  observations: GateToolObservation[],
  use: ToolUse,
  outcome: ToolOutcome,
): void {
  const executed = outcome.executed !== false;
  const entry: GateToolObservation = {
    name: use.name,
    executed,
    ok: executed && outcome.isError !== true,
  };
  const command = use.name === "bash" ? boundedText(use.input.command) : undefined;
  const path = use.name === "edit" || use.name === "write_file" || use.name === "read_file"
    ? boundedText(use.input.path)
    : undefined;
  const oldText = use.name === "edit" && typeof use.input.old_text === "string"
    ? use.input.old_text.slice(0, MAX_CRITIC_SNIPPET)
    : undefined;
  const newText = use.name === "edit" && typeof use.input.new_text === "string"
    ? use.input.new_text.slice(0, MAX_CRITIC_SNIPPET)
    : undefined;
  const contentChars = use.name === "write_file" && typeof use.input.content === "string"
    ? use.input.content.length
    : undefined;
  observations.push({
    ...entry,
    ...(command !== undefined ? { command } : {}),
    ...(path !== undefined ? { path } : {}),
    ...(use.name === "bash" ? { exitCode: outcome.exitCode ?? null } : {}),
    ...(oldText !== undefined ? { oldText } : {}),
    ...(newText !== undefined ? { newText } : {}),
    ...(contentChars !== undefined ? { contentChars } : {}),
  });
  if (observations.length > 512) observations.splice(0, observations.length - 512);
}

export function gateEditCount(observations: readonly GateToolObservation[]): number {
  return observations.filter((o) => o.executed && o.ok && (o.name === "edit" || o.name === "write_file")).length;
}

export function gateEditedPaths(observations: readonly GateToolObservation[]): string[] {
  const paths: string[] = [];
  for (const o of observations) {
    if (o.executed && o.ok && (o.name === "edit" || o.name === "write_file") && o.path && !paths.includes(o.path)) {
      paths.push(o.path);
    }
  }
  return paths;
}

const TEST_COMMAND = /\b(tests?|testing|vitest|jest|mocha|pytest|playwright|cypress|e2e|rspec)\b|node\s+--test\b|(deno|bun)\s+test\b|\bcargo\s+test\b|\bgo\s+test\b|\bctest\b|\b(gradle|gradlew|mvnw?)\s+(test|verify|check)\b|\bdotnet\s+test\b|\bmake\s+(test|tests|check|e2e)\b/i;
const TYPECHECK_COMMAND = /\btypecheck\b|\btype-check\b|\btsc\b|\bmypy\b|\bpyright\b|\bpyre\b|\btsgo\b|\bgo\s+vet\b|\bcargo\s+(check|clippy)\b/i;
const LINT_COMMAND = /\blint\b|\beslint\b|\bbiome\b|\bruff\b|\bpylint\b|\bflake8\b/i;
const BUILD_COMMAND = /\bbuild\b|\btsc\b(?![\s\S]{0,80}--noEmit)|\bvite\s+build\b|\bnext\s+build\b|\bwebpack\b|\besbuild\b|\btsup\b|\brollup\b|\bcargo\s+build\b|\bgo\s+build\b|\bmake\s+build\b|\bgradle\s+build\b|\bmvn\s+package\b|\bdotnet\s+build\b/i;
const GENERIC_CHECK_COMMAND = /\b(pnpm|npm|yarn|bun)\s+(run\s+)?(check|verify|ci|validate|qa)\b|\bmake\s+(check|verify|ci)\b|\b(gradle|gradlew|mvnw?)\s+(check|verify)\b/i;

export type CheckKind = "test" | "typecheck" | "build" | "lint";

/** True when a bash command line invokes a known check runner. */
export function isCheckCommand(command: string): boolean {
  return TEST_COMMAND.test(command) ||
    TYPECHECK_COMMAND.test(command) ||
    LINT_COMMAND.test(command) ||
    BUILD_COMMAND.test(command) ||
    GENERIC_CHECK_COMMAND.test(command);
}

/** Check kinds a command line covers (empty for generic `check`/`verify`). */
export function checkKindsForCommand(command: string): CheckKind[] {
  const kinds: CheckKind[] = [];
  if (TEST_COMMAND.test(command)) kinds.push("test");
  if (TYPECHECK_COMMAND.test(command)) kinds.push("typecheck");
  if (BUILD_COMMAND.test(command)) kinds.push("build");
  if (LINT_COMMAND.test(command)) kinds.push("lint");
  return kinds;
}

const OUTCOME_WORD = "pass|passing|passed|green|clean|succeed|succeeded|successful";
// "clean up the tests" is not a claim; outcome-first matches exclude "clean".
const OUTCOME_WORD_FIRST = "pass|passing|passed|green|succeed|succeeded|successful";
const NEGATED_BEFORE = /(did\s+not|didn'?t|do\s+not|don'?t|does\s+not|doesn'?t|not|never|failed?\s+to|couldn'?t|can'?t|won'?t|wouldn'?t|no)\s*$/i;
const NEGATED_WITHIN = /\b(did\s+not|didn'?t|do\s+not|don'?t|does\s+not|doesn'?t|not|never|failed?\s+to|couldn'?t|can'?t|won'?t|wouldn'?t|without)\b/i;

function claimedSnippet(text: string, kindSource: string): string | null {
  const pattern = new RegExp(
    `\\b(${kindSource})\\b[^\\n]{0,60}\\b(${OUTCOME_WORD})\\b|\\b(${OUTCOME_WORD_FIRST})\\b[^\\n]{0,30}\\b(${kindSource})\\b`,
    "i",
  );
  const match = pattern.exec(text);
  if (!match || match.index === undefined) return null;
  // Negation can sit before the kind ("no tests passed") or between the
  // kind and the outcome ("tests did not pass").
  const before = text.slice(Math.max(0, match.index - 18), match.index);
  if (NEGATED_BEFORE.test(before) || NEGATED_WITHIN.test(match[0])) return null;
  return match[0].slice(0, 160);
}

export interface ClaimedChecks {
  readonly kinds: readonly CheckKind[];
  readonly generic: string | null;
  readonly snippet: string | null;
}

/** Explicit passing-check claims in report text (negated claims excluded). */
export function claimedCheckKinds(text: string): ClaimedChecks {
  const kinds: CheckKind[] = [];
  const snippets: string[] = [];
  const test = claimedSnippet(text, "tests?|e2e|unit tests?|integration tests?");
  if (test) {
    kinds.push("test");
    snippets.push(test);
  }
  const typecheck = claimedSnippet(text, "typecheck|type-check|type checking|tsc|mypy");
  if (typecheck) {
    kinds.push("typecheck");
    snippets.push(typecheck);
  }
  const build = claimedSnippet(text, "build");
  if (build) {
    kinds.push("build");
    snippets.push(build);
  }
  const lint = claimedSnippet(text, "lint|eslint");
  if (lint) {
    kinds.push("lint");
    snippets.push(lint);
  }
  const generic = claimedSnippet(text, "checks?|verification|test suite") ??
    (/\ball green\b/i.exec(text)?.[0] ?? null) ??
    (/\b(everything|all)\s+(passes|passed|passing|green)\b/i.exec(text)?.[0] ?? null) ??
    (/\bno\s+(tests?|checks?|errors?|failures?)\s+failed\b/i.exec(text)?.[0] ?? null);
  if (generic) snippets.push(generic.slice(0, 160));
  return { kinds, generic, snippet: snippets[0] ?? null };
}

const CHECKS_SECTION_HEADER = /^#{0,6}\s*(checks?(\s*(\/|and|&|\+)\s*outcomes?)?|verification|test results?|validation)\s*:?\s*$/im;

export type ChecksSectionState = "absent" | "empty" | "present";

/** Parse the mandated final-report checks section (what changed / checks+outcomes / remaining). */
export function checksSectionState(text: string): ChecksSectionState {
  const match = CHECKS_SECTION_HEADER.exec(text);
  if (!match || match.index === undefined) return "absent";
  const rest = text.slice(match.index + match[0].length).split("\n", 9);
  const body: string[] = [];
  for (const line of rest) {
    if (/^#{1,6}\s+\S/.test(line)) break;
    body.push(line);
  }
  const cleaned = body.join("\n").replace(/^[\s>*\-–—]+/gm, "").trim();
  if (!cleaned || /^(n\/a|none|tbd)\.?$/i.test(cleaned)) return "empty";
  return "present";
}

export interface RanCheck {
  readonly command: string;
  readonly passed: boolean;
}

export function ranChecks(observations: readonly GateToolObservation[]): RanCheck[] {
  const checks: RanCheck[] = [];
  for (const o of observations) {
    if (o.name !== "bash" || !o.executed || !o.command || !isCheckCommand(o.command)) continue;
    checks.push({ command: o.command, passed: o.exitCode === 0 });
  }
  return checks;
}

export type SettleGateReason = "no-checks" | "false-claim" | "failing-checks";

export type SettleGateVerdict =
  | { readonly decision: "pass" }
  | {
    readonly decision: "nudge";
    readonly reason: SettleGateReason;
    readonly detail: string;
    readonly nudge: string;
  }
  | { readonly decision: "fail"; readonly reason: SettleGateReason; readonly detail: string };

const SETTLE_GATE_FAILURE_SUFFIX = "Without observed verification, this run will settle as failure.";

function trip(reason: SettleGateReason, detail: string, nudge: string, alreadyNudged: boolean): SettleGateVerdict {
  if (alreadyNudged) return { decision: "fail", reason, detail };
  return { decision: "nudge", reason, detail, nudge };
}

/**
 * Settle-gate verdict for a would-be-success run. Read-only runs pass.
 * A tripped gate yields one grace nudge, then failure (never a loop).
 */
export function settleGateVerdict(
  input: { readonly observations: readonly GateToolObservation[]; readonly finalText: string },
  alreadyNudged: boolean,
): SettleGateVerdict {
  const edits = gateEditCount(input.observations);
  if (edits === 0) return { decision: "pass" };
  const files = gateEditedPaths(input.observations);
  const checks = ranChecks(input.observations);
  const passed = checks.filter((c) => c.passed);
  const observedKinds = new Set<CheckKind>();
  for (const check of passed) {
    for (const kind of checkKindsForCommand(check.command)) observedKinds.add(kind);
  }
  const claims = claimedCheckKinds(input.finalText);
  const missingKinds = claims.kinds.filter((kind) => !observedKinds.has(kind));
  const genericClaimUnverified = claims.generic !== null && passed.length === 0 && claims.kinds.length === 0;
  if (missingKinds.length > 0 || genericClaimUnverified) {
    const missing = missingKinds.length > 0 ? missingKinds.join("/") : "checks";
    const detail = `final report claims ${missing} pass but no matching check invocation was observed`;
    return trip(
      "false-claim",
      detail,
      `Settle gate: the final report claims "${claims.snippet ?? missing}" but no matching check invocation was observed in this run. ` +
        `Run the claimed checks or correct the report. ${SETTLE_GATE_FAILURE_SUFFIX}`,
      alreadyNudged,
    );
  }
  if (checks.length > 0 && passed.length === 0) {
    const detail = `observed check commands all failed (${checks.length} run, none passed)`;
    return trip(
      "failing-checks",
      detail,
      `Settle gate: ${detail}. Fix the failures and re-run the checks. ${SETTLE_GATE_FAILURE_SUFFIX}`,
      alreadyNudged,
    );
  }
  if (checks.length === 0) {
    const section = checksSectionState(input.finalText);
    const fileNote = files.length > 0 ? ` Changed files: ${files.slice(0, 8).join(", ")}${files.length > 8 ? "…" : ""}.` : "";
    const detail = section === "present"
      ? `no checks observed — ${edits} file(s) changed (checks section present, but no check ran)`
      : `no checks observed — ${edits} file(s) changed (${section} checks section)`;
    return trip(
      "no-checks",
      detail,
      `Settle gate: no checks observed — run them or explain why none apply.${fileNote} ${SETTLE_GATE_FAILURE_SUFFIX}`,
      alreadyNudged,
    );
  }
  return { decision: "pass" };
}

// ---- critic pass (#124) ----

/**
 * Non-trivial runs get a critic review: at least one file edit plus either
 * 2+ mutations or 4+ model turns. Read-only, single-edit, and short runs
 * skip with no extra calls.
 */
export function needsCriticReview(input: { readonly editCount: number; readonly modelTurns: number }): boolean {
  if (input.editCount < 1) return false;
  return input.editCount >= 2 || input.modelTurns >= 4;
}

const MAX_CRITIC_FILES = 10;

/**
 * Tool-observed change summary for the critic. agent-core cannot shell out
 * to git (core/ owns snapshots), so the critic sees the edits the engine
 * executed, not a working-tree diff.
 */
export function summarizeChangesForCritic(observations: readonly GateToolObservation[]): string {
  const lines: string[] = [];
  let shown = 0;
  for (const o of observations) {
    if (!o.executed || !o.ok) continue;
    if (o.name !== "edit" && o.name !== "write_file") continue;
    if (shown >= MAX_CRITIC_FILES) {
      lines.push("…(more files changed)");
      break;
    }
    shown += 1;
    if (o.name === "write_file") {
      lines.push(`write ${o.path ?? "(unknown path)"} (${o.contentChars ?? 0} chars)`);
    } else {
      lines.push(`edit ${o.path ?? "(unknown path)"}:\n- ${o.oldText ?? ""}\n+ ${o.newText ?? ""}`);
    }
  }
  return lines.join("\n").slice(0, 4 * 1024) || "(no file changes observed)";
}

/** One line per observed check command with its outcome. */
export function summarizeCheckOutcomes(observations: readonly GateToolObservation[]): string {
  const lines: string[] = [];
  for (const o of observations) {
    if (o.name !== "bash" || !o.executed || !o.command || !isCheckCommand(o.command)) continue;
    lines.push(`${o.command} → ${o.exitCode === null || o.exitCode === undefined ? "not completed" : `exit ${o.exitCode}`}`);
    if (lines.length >= MAX_CRITIC_FILES) {
      lines.push("…(more checks ran)");
      break;
    }
  }
  return lines.join("\n").slice(0, 1024) || "(no checks observed)";
}

/** Tiny frozen critic instruction. The call carries no tools. */
export const CRITIC_SYSTEM_PROMPT =
  "You are a code-review critic. Judge only whether the change does what was asked, no more and no less. " +
  'Reply with exactly one JSON object and nothing else: {"verdict":"pass"|"fail","rationale":"..."}. ' +
  'Fail for scope-downs, symptom patches, gold-plating, or misread requirements. Pass small correct changes.';

export function buildCriticPrompt(input: {
  readonly request: string;
  readonly changes: string;
  readonly report: string;
  readonly checks: string;
}): string {
  const section = (label: string, text: string, cap: number): string =>
    `## ${label}\n${text.slice(0, cap) || "(empty)"}`;
  return [
    "Review this coding-agent run before it settles. Does the change do what was asked, no more and no less?",
    "",
    section("Original request", input.request, 1500),
    "",
    section("Observed file changes", input.changes, 4000),
    "",
    section("Final report", input.report, 2000),
    "",
    section("Check outcomes", input.checks, 1000),
  ].join("\n");
}

export interface ParsedCriticVerdict {
  readonly verdict: "pass" | "fail";
  readonly rationale: string | null;
  readonly parsed: boolean;
}

/**
 * Parse the critic reply. Unparseable output fails open to pass with a
 * recorded note: the critic is advisory quality review, not a safety gate,
 * and a malformed verdict must not burn a work round.
 */
export function parseCriticVerdict(text: string): ParsedCriticVerdict {
  const match = /\{[\s\S]{1,2000}?\}/.exec(text);
  if (match) {
    try {
      const value = JSON.parse(match[0]) as { verdict?: unknown; rationale?: unknown };
      const verdict = typeof value.verdict === "string" ? value.verdict.toLowerCase() : "";
      if (verdict === "pass" || verdict === "fail") {
        const rationale = typeof value.rationale === "string" && value.rationale.trim()
          ? value.rationale.trim().replace(/\s+/g, " ").slice(0, 1000)
          : null;
        return { verdict, rationale, parsed: true };
      }
    } catch {
      /* fall through to the unparseable default */
    }
  }
  return { verdict: "pass", rationale: "critic output was not parseable as a verdict", parsed: false };
}
