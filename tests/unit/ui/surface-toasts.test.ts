import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const review = readFileSync(new URL("../../../src/review.ts", import.meta.url), "utf8");
const worldlines = readFileSync(new URL("../../../src/worldlines.ts", import.meta.url), "utf8");

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
