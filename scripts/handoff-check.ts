/**
 * Handoff contract checker (issue #240).
 *
 * Rejects a note that is missing a required field. Does not fill defaults.
 * Policy: docs/reference/CALIBRATION.md
 *
 *   node --experimental-strip-types --no-warnings scripts/handoff-check.ts <file>
 */
import { readFileSync } from "node:fs";
import { isRecord } from "../shared/guards.ts";

export const HANDOFF_FIELDS = [
  "as-is",
  "should-be",
  "checks-observed",
  "open-risks",
  "evidence",
  "confidence",
  "change-condition",
] as const;

export type HandoffField = (typeof HANDOFF_FIELDS)[number];

export type HandoffCheckOk = {
  readonly ok: true;
  readonly fields: Record<HandoffField, string>;
};

export type HandoffCheckFail = {
  readonly ok: false;
  readonly missing: readonly HandoffField[];
};

export type HandoffCheck = HandoffCheckOk | HandoffCheckFail;

const FIELD_SET = new Set<string>(HANDOFF_FIELDS);

const ALIASES: Record<string, HandoffField> = {
  "as-is": "as-is",
  "as is": "as-is",
  "should-be": "should-be",
  "should be": "should-be",
  "checks-observed": "checks-observed",
  "checks observed": "checks-observed",
  "observed-checks": "checks-observed",
  "observed checks": "checks-observed",
  "open-risks": "open-risks",
  "open risks": "open-risks",
  "evidence": "evidence",
  "confidence": "confidence",
  "change-condition": "change-condition",
  "change condition": "change-condition",
  "what-would-change": "change-condition",
  "what would change": "change-condition",
  "what would change the claim": "change-condition",
};

const HEADING = /^(#{1,6})\s+(.+?)\s*$/;
const LABEL = /^(?:\*\*)?([A-Za-z][A-Za-z0-9 _-]*?)(?:\*\*)?:\s*(.*)$/;

/** Fold a heading or key to a compare form. */
function normalizeLabel(raw: string): string {
  return raw
    .trim()
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .replace(/:+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalField(raw: string): HandoffField | null {
  const normalized = normalizeLabel(raw);
  const aliased = ALIASES[normalized];
  if (aliased) return aliased;
  if (FIELD_SET.has(normalized)) return normalized as HandoffField;
  return null;
}

function nonEmpty(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function missingOf(found: Partial<Record<HandoffField, string>>): HandoffField[] {
  return HANDOFF_FIELDS.filter((field) => nonEmpty(found[field]) === null);
}

function fail(found: Partial<Record<HandoffField, string>>): HandoffCheckFail {
  return { ok: false, missing: missingOf(found) };
}

function succeed(found: Partial<Record<HandoffField, string>>): HandoffCheck {
  const missing = missingOf(found);
  if (missing.length > 0) return { ok: false, missing };
  const fields = {} as Record<HandoffField, string>;
  for (const field of HANDOFF_FIELDS) {
    const value = nonEmpty(found[field]);
    if (value === null) return { ok: false, missing: [field] };
    fields[field] = value;
  }
  return { ok: true, fields };
}

function checkJson(text: string): HandoffCheck {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail({});
  }
  if (!isRecord(parsed)) return fail({});
  const found: Partial<Record<HandoffField, string>> = {};
  for (const [key, value] of Object.entries(parsed)) {
    const field = canonicalField(key);
    if (!field) continue;
    if (typeof value !== "string") continue;
    if (nonEmpty(value) === null) continue;
    found[field] = value.trim();
  }
  return succeed(found);
}

type FieldLine =
  | { readonly kind: "field"; readonly field: HandoffField; readonly rest: string }
  | { readonly kind: "break" };

function matchFieldLine(line: string): FieldLine | null {
  const heading = line.match(HEADING);
  if (heading) {
    const title = (heading[2] ?? "").replace(/:$/, "").trim();
    const field = canonicalField(title);
    if (!field) return { kind: "break" };
    return { kind: "field", field, rest: "" };
  }
  const label = line.match(LABEL);
  if (!label) return null;
  const field = canonicalField(label[1] ?? "");
  if (!field) return null;
  return { kind: "field", field, rest: label[2] ?? "" };
}

function checkMarkup(text: string): HandoffCheck {
  const found: Partial<Record<HandoffField, string[]>> = {};
  let current: HandoffField | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const matched = matchFieldLine(rawLine);
    if (matched?.kind === "break") {
      current = null;
      continue;
    }
    if (matched?.kind === "field") {
      current = matched.field;
      const chunks = found[current] ?? [];
      found[current] = chunks;
      const rest = nonEmpty(matched.rest);
      if (rest !== null) chunks.push(rest);
      continue;
    }
    if (current === null) continue;
    found[current]?.push(rawLine);
  }
  const joined: Partial<Record<HandoffField, string>> = {};
  for (const field of HANDOFF_FIELDS) {
    const chunks = found[field];
    if (!chunks) continue;
    const value = chunks.join("\n").trim();
    if (value.length > 0) joined[field] = value;
  }
  return succeed(joined);
}

/** Check one handoff body. Missing or empty fields fail. No defaults. */
export function checkHandoff(text: string): HandoffCheck {
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (trimmed.length === 0) return fail({});
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return checkJson(trimmed);
  return checkMarkup(text);
}

export class HandoffError extends Error {
  readonly missing: readonly HandoffField[];

  constructor(missing: readonly HandoffField[]) {
    super(`handoff rejected: missing ${missing.join(", ")}`);
    this.name = "HandoffError";
    this.missing = missing;
  }
}

/** Throw when the handoff does not meet the contract. */
export function assertHandoff(text: string): Record<HandoffField, string> {
  const result = checkHandoff(text);
  if (!result.ok) throw new HandoffError(result.missing);
  return result.fields;
}

export function checkHandoffFile(path: string): HandoffCheck {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`handoff-check: cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return checkHandoff(text);
}

function isMain(): boolean {
  const entry = process.argv[1] ?? "";
  return entry.endsWith("handoff-check.ts");
}

if (isMain()) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: handoff-check.ts <handoff-file>");
    process.exit(1);
  }
  try {
    const result = checkHandoffFile(file);
    if (!result.ok) {
      console.error(`handoff rejected: missing ${result.missing.join(", ")}`);
      process.exit(1);
    }
    console.log("ok");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
