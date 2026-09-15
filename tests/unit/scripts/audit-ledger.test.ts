/**
 * Audit-ledger regressions (issue #241).
 *
 * Pins the checked-in fixture, the copy-paste command, and the two
 * fail-closed traps: unknown items need a named owner, and one batch
 * cannot close a class with more than one item.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatReport, reconcileLedger } from "../../../scripts/audit-ledger.ts";

const repo = resolve(__dirname, "..", "..", "..");
const FIXTURE = join(repo, "tests/fixtures/audit-ledger/inventory.json");
const DOC = join(repo, "docs/reference/AUDIT-LEDGER.md");
const COMMAND = "node --experimental-strip-types --no-warnings scripts/audit-ledger.ts tests/fixtures/audit-ledger/inventory.json";

const fixtures: string[] = [];
afterEach(() => {
  while (fixtures.length > 0) rmSync(fixtures.pop()!, { recursive: true, force: true });
});

interface TestEntry {
  readonly path: string;
  readonly status: "confirmed" | "refuted" | "unknown";
  readonly owner?: string;
}

interface TestClass {
  readonly id: string;
  readonly items: readonly string[];
  readonly status: "open" | "closed";
  readonly batchIds: readonly string[];
}

function writeLedger(options: {
  readonly files?: readonly string[];
  readonly entries?: readonly TestEntry[];
  readonly classes?: readonly TestClass[];
  readonly version?: unknown;
  readonly root?: string;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "termina-audit-ledger-"));
  fixtures.push(dir);
  const tree = join(dir, "tree");
  mkdirSync(join(tree, "nested"), { recursive: true });
  const files = options.files ?? ["alpha.txt", "nested/beta.txt", "nested/gamma.txt"];
  for (const path of files) {
    const abs = join(tree, path);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, `${path}\n`);
  }
  const inventory = {
    version: options.version ?? 1,
    root: options.root ?? "tree",
    entries: options.entries ?? [
      { path: "alpha.txt", status: "confirmed" },
      { path: "nested/beta.txt", status: "refuted" },
      { path: "nested/gamma.txt", status: "unknown", owner: "audit-ledger" },
    ],
    classes: options.classes ?? [
      { id: "future-multi-item", items: ["finding-a", "finding-b"], status: "open", batchIds: ["batch-example"] },
      { id: "future-single-item", items: ["finding-c"], status: "closed", batchIds: ["batch-example"] },
    ],
  };
  const inventoryPath = join(dir, "inventory.json");
  writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  return inventoryPath;
}

function runCommand(inventoryPath: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "scripts/audit-ledger.ts", inventoryPath], {
    cwd: repo,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

describe("audit ledger (#241)", () => {
  it("pins the recorded fixture inventory", () => {
    const report = reconcileLedger(FIXTURE);
    expect(report.ok).toBe(true);
    expect(report.counts).toEqual({ inventory: 3, matched: 3, walked: 3 });
    expect(report.statuses).toEqual({ confirmed: 1, refuted: 1, unknown: 1 });
    expect(report.classes).toEqual({ closed: 1, open: 1 });
    expect(report.paths).toEqual(["alpha.txt", "nested/beta.txt", "nested/gamma.txt"]);
    expect(report.errors).toEqual([]);
  });

  it("is deterministic over the fixture", () => {
    const first = reconcileLedger(FIXTURE);
    const second = reconcileLedger(FIXTURE);
    expect(second).toEqual(first);
    expect(formatReport(first)).toBe(formatReport(second));
    expect(formatReport(first)).toBe(`${JSON.stringify({
      classes: { closed: 1, open: 1 },
      counts: { inventory: 3, matched: 3, walked: 3 },
      errors: [],
      ok: true,
      paths: ["alpha.txt", "nested/beta.txt", "nested/gamma.txt"],
      statuses: { confirmed: 1, refuted: 1, unknown: 1 },
    }, null, 2)}\n`);
  });

  it("exposes the same report through the repeatable command", () => {
    const result = runCommand(FIXTURE);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(formatReport(reconcileLedger(FIXTURE)));
  });

  it("records the copy-paste command and future-audit trap rule in the doc", () => {
    const doc = readFileSync(DOC, "utf8");
    expect(doc).toContain(COMMAND);
    expect(doc).toContain("node --experimental-strip-types --no-warnings scripts/audit-ledger.ts <inventory.json>");
    expect(doc).toContain("The trap rules below apply to **future** audits.");
    expect(doc).toContain("#139 is closed");
    expect(doc).toContain("does not read `docs/audits/`");
    expect(doc).toContain("is not a source for this rule and must not be imported");
    expect(readFileSync(join(repo, "scripts/audit-ledger.ts"), "utf8")).not.toContain("docs/audits");
  });

  it("fails when an unknown item has no named owner", () => {
    const report = reconcileLedger(writeLedger({
      entries: [
        { path: "alpha.txt", status: "confirmed" },
        { path: "nested/beta.txt", status: "refuted" },
        { path: "nested/gamma.txt", status: "unknown" },
      ],
    }));
    expect(report.ok).toBe(false);
    expect(report.errors).toContain("unknown path missing owner: nested/gamma.txt");
  });

  it("fails when an unknown owner is blank", () => {
    const report = reconcileLedger(writeLedger({
      entries: [
        { path: "alpha.txt", status: "confirmed" },
        { path: "nested/beta.txt", status: "refuted" },
        { path: "nested/gamma.txt", status: "unknown", owner: "   " },
      ],
    }));
    expect(report.ok).toBe(false);
    expect(report.errors).toContain("unknown path missing owner: nested/gamma.txt");
    expect(report.errors).toContain("entry nested/gamma.txt has an invalid owner");
  });

  it("fails when a multi-item class closes from one batch id", () => {
    const report = reconcileLedger(writeLedger({
      classes: [
        { id: "future-multi-item", items: ["finding-a", "finding-b"], status: "closed", batchIds: ["batch-example"] },
      ],
    }));
    expect(report.ok).toBe(false);
    expect(report.errors).toContain("class closed by one batch: future-multi-item (2 items, 1 batch)");
  });

  it("fails when duplicate batch ids collapse to one close", () => {
    const report = reconcileLedger(writeLedger({
      classes: [
        { id: "future-multi-item", items: ["finding-a", "finding-b"], status: "closed", batchIds: ["batch-example", "batch-example"] },
      ],
    }));
    expect(report.ok).toBe(false);
    expect(report.errors).toContain("class closed by one batch: future-multi-item (2 items, 1 batch)");
  });

  it("allows a multi-item class to close with two distinct batch ids", () => {
    const report = reconcileLedger(writeLedger({
      classes: [
        { id: "future-multi-item", items: ["finding-a", "finding-b"], status: "closed", batchIds: ["batch-a", "batch-b"] },
      ],
    }));
    expect(report.ok).toBe(true);
    expect(report.classes).toEqual({ closed: 1, open: 0 });
  });

  it("allows a one-item class to close with one batch id", () => {
    const report = reconcileLedger(writeLedger({
      classes: [
        { id: "future-single-item", items: ["finding-c"], status: "closed", batchIds: ["batch-example"] },
      ],
    }));
    expect(report.ok).toBe(true);
  });

  it("fails when the walk and inventory disagree", () => {
    const missing = reconcileLedger(writeLedger({
      files: ["alpha.txt", "nested/beta.txt"],
    }));
    expect(missing.ok).toBe(false);
    expect(missing.errors).toContain("extra path: nested/gamma.txt");
    expect(missing.errors).toContain("count mismatch: walked 2 inventory 3 matched 2");

    const extra = reconcileLedger(writeLedger({
      entries: [
        { path: "alpha.txt", status: "confirmed" },
        { path: "nested/beta.txt", status: "refuted" },
      ],
    }));
    expect(extra.ok).toBe(false);
    expect(extra.errors).toContain("missing path: nested/gamma.txt");
  });

  it("fails on a duplicate inventory path", () => {
    const report = reconcileLedger(writeLedger({
      entries: [
        { path: "alpha.txt", status: "confirmed" },
        { path: "alpha.txt", status: "refuted" },
        { path: "nested/beta.txt", status: "refuted" },
        { path: "nested/gamma.txt", status: "unknown", owner: "audit-ledger" },
      ],
    }));
    expect(report.ok).toBe(false);
    expect(report.errors).toContain("duplicate path: alpha.txt");
    expect(report.errors).toContain("count mismatch: walked 3 inventory 4 matched 3");
  });

  it("rejects an unreadable inventory and exits non-zero", () => {
    const report = reconcileLedger(join(tmpdir(), "termina-no-such-audit-ledger.json"));
    expect(report.ok).toBe(false);
    expect(report.errors).toEqual(["cannot read inventory"]);
    const result = runCommand(join(tmpdir(), "termina-no-such-audit-ledger.json"));
    expect(result.status).toBe(1);
    expect(result.stdout).toBe(formatReport(report));
  });
});
