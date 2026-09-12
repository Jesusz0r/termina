import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const review = readFileSync(new URL("../../../src/review.ts", import.meta.url), "utf8");
const worldlines = readFileSync(new URL("../../../src/worldlines.ts", import.meta.url), "utf8");
const main = readFileSync(new URL("../../../src/main.ts", import.meta.url), "utf8");

/** Body of a class method, including nested blocks. */
function methodBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `missing ${signature}`).toBeGreaterThanOrEqual(0);
  const brace = source.indexOf("{", start);
  expect(brace, `unopened ${signature}`).toBeGreaterThan(start);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(brace, i + 1);
    }
  }
  throw new Error(`unclosed ${signature}`);
}

function toastCalls(body: string): string[] {
  const calls: string[] = [];
  const needle = "toast(";
  let from = 0;
  while (from < body.length) {
    const start = body.indexOf(needle, from);
    if (start < 0) break;
    let depth = 0;
    let end = start + needle.length - 1;
    for (; end < body.length; end++) {
      const ch = body[end];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    calls.push(body.slice(start + needle.length, end).replace(/\s+/g, " ").trim());
    from = end + 1;
  }
  return calls;
}

function hasInfoToast(body: string): boolean {
  return toastCalls(body).some((args) => /, *["']info["']$/.test(args) || !/, *["'](?:warning|error)["']$/.test(args));
}

describe("review accept/revert toasts", () => {
  it("does not flash accepted/reverted info toasts after the list mark updates", () => {
    const revert = methodBody(review, "async revert(): Promise<void>");
    const accept = methodBody(review, "accept(): void");
    expect(revert).toContain("this.onReverted(this.path)");
    expect(accept).toContain("this.onAccepted(this.path)");
    expect(revert).not.toContain('toast("reverted"');
    expect(accept).not.toContain('toast("accepted"');
    expect(hasInfoToast(revert)).toBe(false);
    expect(hasInfoToast(accept)).toBe(false);
  });

  it("still toasts revert and load failures", () => {
    const revert = methodBody(review, "async revert(): Promise<void>");
    expect(revert).toContain('toast(res.error ?? "revert failed", "error")');
    expect(review).toContain('toast(`could not load review: ${(err as Error).message}`, "error")');
    expect(review).toContain('toast(`could not refresh review: ${(err as Error).message}`, "error")');
  });
});

describe("worldline success toasts", () => {
  it("does not flash challenge/promote/export/reopen info toasts after the card updates", () => {
    const challenge = methodBody(worldlines, "private async challenge(");
    const runPromote = methodBody(worldlines, "private async runPromote(");
    const exportFn = methodBody(worldlines, "private async export(");
    const reopen = methodBody(worldlines, "private async reopen(");
    expect(hasInfoToast(challenge)).toBe(false);
    expect(hasInfoToast(runPromote)).toBe(false);
    expect(hasInfoToast(exportFn)).toBe(false);
    expect(hasInfoToast(reopen)).toBe(false);
    expect(challenge).not.toContain("challenger launched");
    expect(runPromote).not.toContain("promoted —");
    expect(exportFn).not.toContain("exported —");
    expect(exportFn).toContain("this.recordExportPath(comparisonId, label, res.path)");
    expect(reopen).not.toContain("reopened`, \"info\"");
    expect(runPromote).toContain("this.handlers.onOpenTerminal(res.terminalId)");
    expect(reopen).toContain("this.handlers.onOpenTerminal(res.terminalId)");
  });

  it("still toasts worldline action failures", () => {
    expect(methodBody(worldlines, "private async challenge(")).toContain(
      'toast(`challenge failed: ${res.error ?? "unknown error"}`, "warning")',
    );
    expect(methodBody(worldlines, "private async runPromote(")).toContain(
      'toast(`promotion failed: ${res.error ?? "unknown error"}`, "warning")',
    );
    expect(methodBody(worldlines, "private async export(")).toContain(
      'toast(res.error ?? "export failed", "warning")',
    );
    expect(methodBody(worldlines, "private async reopen(")).toContain(
      'toast(res.error ?? "could not reopen the candidate", "warning")',
    );
    expect(methodBody(worldlines, "private async evidence(")).toContain(
      'toast(`evidence failed: ${res.error ?? "unknown error"}`, "warning")',
    );
    expect(methodBody(worldlines, "private async verify(")).toContain(
      'toast(res.error ?? "verify failed to start", "warning")',
    );
  });
});

describe("dispatch success toasts", () => {
  it("does not flash dispatched info toasts after the plan row shows the worker", () => {
    const rowDispatch = methodBody(main, 'li.addEventListener("click", (e) => {');
    const bulkDispatch = methodBody(main, 'btnDispatch.addEventListener("click", () => {');
    const plan = methodBody(main, "function renderPlan(pane: Pane, announce = true): void {");
    // The durable surface: the row renders the worker and claimed files.
    expect(plan).toContain("plan-meta");
    expect(plan).toContain("task.workerId");
    expect(rowDispatch).toContain("dispatchRun(pane.instanceId, task.text)");
    expect(bulkDispatch).toContain("dispatchRun(id)");
    expect(hasInfoToast(rowDispatch)).toBe(false);
    expect(hasInfoToast(bulkDispatch)).toBe(false);
    expect(main).not.toContain("dispatched 1 task to a parallel agent");
    expect(main).not.toContain("task(s) to parallel agents");
  });

  it("still toasts dispatch failures", () => {
    const rowDispatch = methodBody(main, 'li.addEventListener("click", (e) => {');
    const bulkDispatch = methodBody(main, 'btnDispatch.addEventListener("click", () => {');
    expect(rowDispatch).toContain('toast(res.error ?? "dispatch failed", "warning")');
    expect(bulkDispatch).toContain('toast(res.error ?? "dispatch failed", "warning")');
  });
});

describe("accept-all success toast", () => {
  it("does not flash an accepted info toast after the row marks update", () => {
    const acceptAll = methodBody(main, 'btnAcceptAll.addEventListener("click", (e) => {');
    expect(acceptAll).toContain("pane.accepted.set(f.path, reviewedAt)");
    expect(acceptAll).toContain("renderModified(pane)");
    expect(hasInfoToast(acceptAll)).toBe(false);
    expect(main).not.toContain("file(s) accepted");
  });
});

describe("verify badge toast", () => {
  it("does not flash the summary the badge already shows; a click only cancels a run", () => {
    const badgeClick = methodBody(main, 'verifyBadge.addEventListener("click", () => {');
    const badge = methodBody(main, "function renderVerify(pane: Pane): void {");
    expect(badge).toContain("verifyBadge.textContent");
    expect(badgeClick).toContain("cancelVerify");
    expect(hasInfoToast(badgeClick)).toBe(false);
    expect(main).not.toContain('toast(pane.verify.summary ?? "", "info")');
  });

  it("still toasts verify start and cancel failures", () => {
    expect(main).toContain('toast(res.error ?? "verify failed to start", "warning")');
    expect(methodBody(main, 'verifyBadge.addEventListener("click", () => {')).toContain(
      'toast(res.error ?? "verify could not be cancelled", "warning")',
    );
  });
});

describe("fork success toasts", () => {
  it("does not flash starting info toasts after the candidate cards arrive", () => {
    const forkRun = methodBody(main, 'btnForkRun.addEventListener("click", () => {');
    const challengeRun = methodBody(main, 'button.addEventListener("click", () => {');
    const forkPoint = methodBody(main, "onFork: (ev) => {");
    // The durable surface: worldline pushes render cards and badge the tab.
    expect(main).toContain("worldlinesView.upsert(summary)");
    expect(forkRun).toContain("forkRun(run.id)");
    expect(challengeRun).toContain("challengeRun(run.id, profile)");
    expect(forkPoint).toContain("forkPoint(pane.instanceId, ev.seq)");
    expect(hasInfoToast(forkRun)).toBe(false);
    expect(hasInfoToast(challengeRun)).toBe(false);
    expect(hasInfoToast(forkPoint)).toBe(false);
    expect(main).not.toContain("are starting");
    expect(main).not.toContain("is starting");
  });

  it("still toasts fork failures", () => {
    expect(methodBody(main, 'btnForkRun.addEventListener("click", () => {')).toContain(
      "toast(`Fork Run failed: ${res.error ?? \"unknown error\"}`, \"warning\")",
    );
    expect(methodBody(main, 'button.addEventListener("click", () => {')).toContain(
      "toast(`Challenge failed: ${res.error ?? \"unknown error\"}`, \"warning\")",
    );
    expect(methodBody(main, "onFork: (ev) => {")).toContain(
      "toast(`fork at this moment failed: ${res.error ?? \"unknown error\"}`, \"warning\")",
    );
  });
});
