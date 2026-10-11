import { describe, expect, it } from "vitest";
import { reviewBaseline } from "../../../electron/main/change-review.ts";
import type { ModifiedFile } from "../../../shared/types.ts";

function fixture(status: ModifiedFile["status"] = "modified", baseline?: string | null) {
  const path = "/project/file";
  const inst = {
    modified: new Map<string, ModifiedFile>([[path, { path, relPath: "file", status }]]),
    baselines: new Map<string, string | null>(),
    baselineFills: new Map<string, Promise<void>>(),
  };
  if (baseline !== undefined) inst.baselines.set(path, baseline);
  return { inst, path };
}

describe("Change Review baseline", () => {
  it.each(["modified", "deleted"] as const)("preserves a captured %s baseline", async (status) => {
    const { inst, path } = fixture(status, "before");
    expect(await reviewBaseline(inst, path, () => true)).toEqual({ status, baseline: "before" });
  });

  it("distinguishes a created file from a captured empty file", async () => {
    const { inst, path } = fixture("modified", null);
    expect(await reviewBaseline(inst, path, () => true)).toEqual({ status: "created", baseline: null });
    inst.baselines.set(path, "");
    expect(await reviewBaseline(inst, path, () => true)).toEqual({ status: "modified", baseline: "" });
  });

  it.each(["created", "modified", "deleted"] as const)("never invents an unavailable %s baseline", async (status) => {
    const { inst, path } = fixture(status);
    expect(await reviewBaseline(inst, path, () => true)).toEqual({
      status: status === "deleted" ? "deleted" : "modified", baseline: undefined,
    });
  });

  it("waits for a pending baseline fill", async () => {
    const { inst, path } = fixture("deleted");
    let finish!: () => void;
    inst.baselineFills.set(path, new Promise<void>((resolve) => { finish = resolve; }));
    const pending = reviewBaseline(inst, path, () => true);
    inst.baselines.set(path, "before");
    finish();
    expect(await pending).toEqual({ status: "deleted", baseline: "before" });
  });

  it("discards a baseline when its target becomes stale during the fill", async () => {
    const { inst, path } = fixture("deleted");
    let live = true;
    let finish!: () => void;
    inst.baselineFills.set(path, new Promise<void>((resolve) => { finish = resolve; }));
    const pending = reviewBaseline(inst, path, () => live);
    inst.baselines.set(path, "before");
    live = false;
    finish();
    expect(await pending).toEqual({ status: "modified", baseline: undefined });
  });

  it("reads an existing baseline without waiting for a redundant fill", async () => {
    const { inst, path } = fixture("modified", "before");
    inst.baselineFills.set(path, new Promise<void>(() => {}));
    expect(await reviewBaseline(inst, path, () => true)).toEqual({ status: "modified", baseline: "before" });
    expect(await reviewBaseline(inst, path, () => false)).toEqual({ status: "modified", baseline: undefined });
  });
});
