import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import ts from "typescript";

const source = ts.createSourceFile("main.ts", readFileSync(new URL("../../../electron/main.ts", import.meta.url), "utf8"), ts.ScriptTarget.ES2022, true);
const method = source.statements.filter(ts.isClassDeclaration).flatMap((node) => [...node.members])
  .find((node) => ts.isMethodDeclaration(node) && node.name.getText(source) === "recoverWorldlineComparisons");
if (!method) throw new Error("missing main recovery coordinator");
const compiled = ts.transpileModule(`return ({ ${method.getText(source).replace(/^private /, "")} }).recoverWorldlineComparisons;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

type Sweep = () => Promise<void>;
function fixture(): (sweep: Sweep) => Promise<void> {
  const recover = new Function(compiled)() as (this: { worldlineRecovery: Promise<void> | null }, sweep: Sweep) => Promise<void>;
  return recover.bind({ worldlineRecovery: null });
}

describe("app-owned Worldlines startup recovery", () => {
  it("shares one in-flight startup sweep and does not sweep again when another project opens", async () => {
    const recover = fixture();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const firstSweep = vi.fn(() => gate);
    const laterSweep = vi.fn(async () => {});
    const first = recover(firstSweep);
    const second = recover(laterSweep);
    expect(second).toBe(first);
    await Promise.resolve();
    expect(firstSweep).toHaveBeenCalledTimes(1);
    expect(laterSweep).not.toHaveBeenCalled();
    finish();
    await Promise.all([first, second]);
    expect(recover(laterSweep)).toBe(first);
    expect(laterSweep).not.toHaveBeenCalled();
  });

  it("keeps a failed recovery barrier rejected rather than admitting another project's candidates", async () => {
    const recover = fixture();
    const failure = new Error("startup cleanup failed");
    const first = recover(() => { throw failure; });
    await expect(first).rejects.toBe(failure);
    const later = vi.fn(async () => {});
    await expect(recover(later)).rejects.toBe(failure);
    expect(later).not.toHaveBeenCalled();
  });
});
