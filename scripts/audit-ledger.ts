/**
 * Audit ledger reconcile (issue #241).
 *
 * Walk one inventory root with node:fs. Compare the walk to the ledger.
 * Every in-scope path must appear exactly once. Counts must match.
 *
 * An unknown item must name an owner. A class with more than one item
 * cannot close from a single batch id. The checker fails closed.
 *
 *   node --experimental-strip-types --no-warnings scripts/audit-ledger.ts <inventory.json>
 */
import { lstatSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isRecord } from "../shared/guards.ts";

export const LEDGER_VERSION = 1;

export type LedgerStatus = "confirmed" | "refuted" | "unknown";
export type ClassStatus = "open" | "closed";

export interface LedgerEntry {
  readonly path: string;
  readonly status: LedgerStatus;
  readonly owner: string | null;
}

export interface LedgerClass {
  readonly id: string;
  readonly items: readonly string[];
  readonly status: ClassStatus;
  readonly batchIds: readonly string[];
}

export interface AuditLedger {
  readonly version: number;
  readonly root: string;
  readonly entries: readonly LedgerEntry[];
  readonly classes: readonly LedgerClass[];
}

export interface ReconcileCounts {
  readonly walked: number;
  readonly inventory: number;
  readonly matched: number;
}

export interface ReconcileReport {
  readonly ok: boolean;
  readonly counts: ReconcileCounts;
  readonly statuses: { readonly confirmed: number; readonly refuted: number; readonly unknown: number };
  readonly classes: { readonly open: number; readonly closed: number };
  readonly paths: readonly string[];
  readonly errors: readonly string[];
}

const STATUSES = new Set<LedgerStatus>(["confirmed", "refuted", "unknown"]);
const CLASS_STATUSES = new Set<ClassStatus>(["open", "closed"]);

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function namedText(value: unknown): string | null {
  const text = asString(value);
  if (text === null) return null;
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function emptyReport(errors: readonly string[]): ReconcileReport {
  return {
    classes: { closed: 0, open: 0 },
    counts: { inventory: 0, matched: 0, walked: 0 },
    errors: [...errors].sort(compareText),
    ok: false,
    paths: [],
    statuses: { confirmed: 0, refuted: 0, unknown: 0 },
  };
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

/** Reject absolute paths, parent hops, and empty segments. */
export function isLedgerPath(value: string): boolean {
  if (value.length === 0 || isAbsolute(value) || value.includes("\\")) return false;
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

function parseStringList(value: unknown, label: string, errors: string[]): string[] {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`);
    return [];
  }
  const items: string[] = [];
  for (const item of value) {
    const text = namedText(item);
    if (text === null) {
      errors.push(`${label} entries must be non-empty strings`);
      continue;
    }
    items.push(text);
  }
  return items;
}

function parseEntry(value: unknown, index: number, errors: string[]): LedgerEntry | null {
  if (!isRecord(value)) {
    errors.push(`entry ${index} is not an object`);
    return null;
  }
  const path = asString(value["path"]);
  if (path === null || !isLedgerPath(path)) {
    errors.push(`entry ${index} has an invalid path`);
    return null;
  }
  const status = asString(value["status"]);
  if (status === null || !STATUSES.has(status as LedgerStatus)) {
    errors.push(`entry ${path} has an invalid status`);
    return null;
  }
  const ownerField = value["owner"];
  const owner = ownerField === undefined ? null : namedText(ownerField);
  if (ownerField !== undefined && owner === null) {
    errors.push(`entry ${path} has an invalid owner`);
  }
  if (status === "unknown" && owner === null) {
    errors.push(`unknown path missing owner: ${path}`);
  }
  return { owner, path, status: status as LedgerStatus };
}

function parseClass(value: unknown, index: number, errors: string[]): LedgerClass | null {
  if (!isRecord(value)) {
    errors.push(`class ${index} is not an object`);
    return null;
  }
  const id = namedText(value["id"]);
  if (id === null) {
    errors.push(`class ${index} is missing id`);
    return null;
  }
  const items = parseStringList(value["items"], `class ${id} items`, errors);
  const batchIds = parseStringList(value["batchIds"], `class ${id} batchIds`, errors);
  const status = asString(value["status"]);
  if (status === null || !CLASS_STATUSES.has(status as ClassStatus)) {
    errors.push(`class ${id} has an invalid status`);
    return null;
  }
  if (status === "closed" && items.length > 1) {
    const distinct = uniqueSorted(batchIds);
    if (distinct.length < 2) {
      errors.push(`class closed by one batch: ${id} (${items.length} items, ${distinct.length} batch)`);
    }
  }
  return { batchIds, id, items, status: status as ClassStatus };
}

export function parseLedger(value: unknown): { ledger: AuditLedger | null; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { errors: ["inventory is not an object"], ledger: null };
  }
  if (value["version"] !== LEDGER_VERSION) {
    errors.push(`unsupported ledger version: ${String(value["version"])}`);
  }
  const root = asString(value["root"]);
  if (root === null || !isLedgerPath(root)) {
    errors.push("inventory root is invalid");
  }
  if (!Array.isArray(value["entries"])) {
    errors.push("inventory entries must be an array");
  }
  if (!Array.isArray(value["classes"])) {
    errors.push("inventory classes must be an array");
  }
  const entries: LedgerEntry[] = [];
  if (Array.isArray(value["entries"])) {
    value["entries"].forEach((entry, index) => {
      const parsed = parseEntry(entry, index, errors);
      if (parsed) entries.push(parsed);
    });
  }
  const classes: LedgerClass[] = [];
  if (Array.isArray(value["classes"])) {
    value["classes"].forEach((item, index) => {
      const parsed = parseClass(item, index, errors);
      if (parsed) classes.push(parsed);
    });
  }
  const seenPaths = new Set<string>();
  for (const entry of entries) {
    if (seenPaths.has(entry.path)) errors.push(`duplicate path: ${entry.path}`);
    seenPaths.add(entry.path);
  }
  const seenClasses = new Set<string>();
  for (const item of classes) {
    if (seenClasses.has(item.id)) errors.push(`duplicate class id: ${item.id}`);
    seenClasses.add(item.id);
    const seenItems = new Set<string>();
    for (const id of item.items) {
      if (seenItems.has(id)) errors.push(`duplicate class item: ${item.id}/${id}`);
      seenItems.add(id);
    }
  }
  if (root === null || !isLedgerPath(root)) {
    return { errors: uniqueSorted(errors), ledger: null };
  }
  return {
    errors: uniqueSorted(errors),
    ledger: { classes, entries, root, version: LEDGER_VERSION },
  };
}

/** Walk regular files only. Do not follow symbolic links. */
export function walkLedgerRoot(root: string): string[] {
  const paths: string[] = [];
  const visit = (abs: string, rel: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      throw new Error(`cannot read ledger root: ${rel || "."}`);
    }
    entries.sort((a, b) => compareText(a.name, b.name));
    for (const entry of entries) {
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      const childAbs = join(abs, entry.name);
      let isLink = entry.isSymbolicLink();
      if (!isLink) {
        try {
          isLink = lstatSync(childAbs).isSymbolicLink();
        } catch {
          throw new Error(`cannot stat ledger path: ${childRel}`);
        }
      }
      if (isLink) continue;
      if (entry.isDirectory()) {
        visit(childAbs, childRel);
        continue;
      }
      if (entry.isFile()) paths.push(childRel);
    }
  };
  visit(root, "");
  return paths.sort(compareText);
}

function loadInventory(inventoryPath: string): { ledger: AuditLedger | null; errors: string[] } {
  let raw: string;
  try {
    raw = readFileSync(inventoryPath, "utf8");
  } catch {
    return { errors: ["cannot read inventory"], ledger: null };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { errors: ["inventory is not valid JSON"], ledger: null };
  }
  return parseLedger(value);
}

export function reconcileLedger(inventoryPath: string): ReconcileReport {
  const loaded = loadInventory(inventoryPath);
  if (loaded.ledger === null) return emptyReport(loaded.errors);

  const inventoryDir = dirname(resolve(inventoryPath));
  const rootAbs = resolve(inventoryDir, loaded.ledger.root);
  let walked: string[];
  try {
    walked = walkLedgerRoot(rootAbs);
  } catch (error) {
    return emptyReport([...loaded.errors, error instanceof Error ? error.message : String(error)]);
  }

  const inventoryPaths = loaded.ledger.entries.map((entry) => entry.path).sort(compareText);
  const walkedSet = new Set(walked);
  const inventorySet = new Set(inventoryPaths);
  const errors = [...loaded.errors];

  for (const path of walked) {
    if (!inventorySet.has(path)) errors.push(`missing path: ${path}`);
  }
  for (const path of inventoryPaths) {
    if (!walkedSet.has(path)) errors.push(`extra path: ${path}`);
  }

  const matched = walked.filter((path) => inventorySet.has(path)).length;
  if (walked.length !== inventoryPaths.length || walked.length !== matched) {
    errors.push(`count mismatch: walked ${walked.length} inventory ${inventoryPaths.length} matched ${matched}`);
  }

  const statuses = { confirmed: 0, refuted: 0, unknown: 0 };
  for (const entry of loaded.ledger.entries) {
    statuses[entry.status] += 1;
  }
  const classes = { closed: 0, open: 0 };
  for (const item of loaded.ledger.classes) {
    classes[item.status] += 1;
  }

  const uniqueErrors = uniqueSorted(errors);
  return {
    classes,
    counts: { inventory: inventoryPaths.length, matched, walked: walked.length },
    errors: uniqueErrors,
    ok: uniqueErrors.length === 0,
    paths: walked,
    statuses,
  };
}

/** Stable JSON: sorted keys, trailing newline, no timestamps. */
export function formatReport(report: ReconcileReport): string {
  return `${JSON.stringify(sortValue(report), null, 2)}\n`;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort(compareText)) {
    out[key] = sortValue(value[key]);
  }
  return out;
}

function isMain(): boolean {
  const entry = process.argv[1] ?? "";
  return entry.endsWith("audit-ledger.ts");
}

if (isMain()) {
  const inventoryPath = process.argv[2];
  if (!inventoryPath) {
    console.error("usage: audit-ledger.ts <inventory.json>");
    process.exit(1);
  }
  const report = reconcileLedger(inventoryPath);
  process.stdout.write(formatReport(report));
  process.exit(report.ok ? 0 : 1);
}
