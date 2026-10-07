import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunForkFeedback } from "../../../src/main/run-fork-feedback.ts";

vi.mock("../../../src/components/modals", () => ({ toast: vi.fn() }));
import { toast } from "../../../src/components/modals";

type ForkResult = { ok: boolean; error?: string; comparisonId?: string };
function deferred() {
  let resolve!: (result: ForkResult) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ForkResult>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function harness() {
  const panes = new Map(["term-a", "term-b"].map((instanceId) => [instanceId, { instanceId, generation: 1 }]));
  let active = panes.get("term-a")!;
  const project = { id: "project-a", generation: 1 };
  const requests: ReturnType<typeof deferred>[] = [];
  const enqueue = () => {
    const request = deferred();
    requests.push(request);
    return request.promise;
  };
  const forkRun = vi.fn((_runId: string) => enqueue());
  const challengeRun = vi.fn((_runId: string, _profile: string) => enqueue());
  vi.stubGlobal("window", { termina: { forkRun, challengeRun } });
  const pendingRenders: boolean[] = [];
  const feedback = createRunForkFeedback({
    getActivePane: () => active,
    getPaneById: (id) => panes.get(id),
    getActiveProject: () => project,
    onChange: () => pendingRenders.push(feedback.isPending(active)),
  });
  return {
    panes, project, requests, forkRun, challengeRun, feedback, pendingRenders,
    getActive: () => active,
    select: (id: string) => { active = panes.get(id)!; },
    request: () => feedback.request(active, `run-${active.instanceId}`),
  };
}

afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe("Fork Run preparation feedback", () => {
  it("shows pending immediately, suppresses duplicate requests and clears after success without a toast", async () => {
    const h = harness();
    const operation = h.request();
    expect(h.forkRun).toHaveBeenCalledExactlyOnceWith("run-term-a");
    expect(h.pendingRenders).toEqual([true]);
    expect(h.feedback.isPending(h.getActive())).toBe(true);
    await h.request();
    expect(h.forkRun).toHaveBeenCalledTimes(1);
    h.requests[0].resolve({ ok: true, comparisonId: "cmp" });
    await operation;
    expect(h.pendingRenders).toEqual([true, false]);
    expect(h.feedback.isPending(h.getActive())).toBe(false);
    expect(toast).not.toHaveBeenCalled();
  });

  it.each(["reply", "throw"])("shows a current %s failure and permits an explicit retry", async (failure) => {
    const h = harness();
    const operation = h.request();
    if (failure === "reply") h.requests[0].resolve({ ok: false, error: "startup rejected" });
    else h.requests[0].reject(new Error("startup rejected"));
    await operation;
    expect(toast).toHaveBeenCalledExactlyOnceWith("Fork Run failed: startup rejected", "warning");
    expect(h.feedback.isPending(h.getActive())).toBe(false);
    const retry = h.request();
    expect(h.forkRun).toHaveBeenCalledTimes(2);
    h.requests[1].resolve({ ok: true });
    await retry;
    expect(h.feedback.isPending(h.getActive())).toBe(false);
  });

  it("shares pending with Challenge, forwards its profile and avoids success toasts", async () => {
    const h = harness();
    const operation = h.feedback.request(h.getActive(), "run-term-a", "preserve-api");
    expect(h.challengeRun).toHaveBeenCalledExactlyOnceWith("run-term-a", "preserve-api");
    expect(h.feedback.isPending(h.getActive())).toBe(true);
    await h.request();
    expect(h.forkRun).not.toHaveBeenCalled();
    h.requests[0].resolve({ ok: true });
    await operation;
    expect(h.feedback.isPending(h.getActive())).toBe(false);
    expect(toast).not.toHaveBeenCalled();
  });

  it.each(["reply", "throw"])("preserves Challenge's current %s warning and permits retry", async (failure) => {
    const h = harness();
    const operation = h.feedback.request(h.getActive(), "run-term-a", "preserve-api");
    if (failure === "reply") h.requests[0].resolve({ ok: false, error: "challenge rejected" });
    else h.requests[0].reject(new Error("challenge rejected"));
    await operation;
    expect(toast).toHaveBeenCalledExactlyOnceWith("Challenge failed: challenge rejected", "warning");
    const retry = h.feedback.request(h.getActive(), "run-term-a", "preserve-api");
    expect(h.challengeRun).toHaveBeenCalledTimes(2);
    h.requests[1].resolve({ ok: true });
    await retry;
  });

  it("keeps pending when leaving and returning to the same source pane", async () => {
    const h = harness();
    const operation = h.request();
    h.select("term-b");
    expect(h.feedback.isPending(h.getActive())).toBe(false);
    h.select("term-a");
    expect(h.feedback.isPending(h.getActive())).toBe(true);
    await h.request();
    expect(h.forkRun).toHaveBeenCalledTimes(1);
    h.requests[0].resolve({ ok: true });
    await operation;
  });

  it.each(["reply", "throw"])("does not warn on a late %s failure against another pane or clear its request", async (failure) => {
    const h = harness();
    const old = h.request();
    h.select("term-b");
    const current = h.request();
    if (failure === "reply") h.requests[0].resolve({ ok: false, error: "old source failed" });
    else h.requests[0].reject(new Error("old source failed"));
    await old;
    expect(toast).not.toHaveBeenCalled();
    expect(h.feedback.isPending(h.getActive())).toBe(true);
    h.requests[1].resolve({ ok: true });
    await current;
    expect(h.feedback.isPending(h.getActive())).toBe(false);
  });

  it.each(["project identity", "project generation", "terminal generation", "pane replacement"])(
    "isolates pending and stale failures across %s",
    async (change) => {
      const h = harness();
      const old = h.request();
      if (change === "project identity") h.project.id = "project-b";
      else if (change === "project generation") h.project.generation++;
      else if (change === "terminal generation") h.getActive().generation++;
      else {
        h.panes.set("term-a", { instanceId: "term-a", generation: 1 });
        h.select("term-a");
      }
      expect(h.feedback.isPending(h.getActive())).toBe(false);
      const current = h.request();
      expect(h.forkRun).toHaveBeenCalledTimes(2);
      h.requests[0].reject(new Error("retired source"));
      await old;
      expect(toast).not.toHaveBeenCalled();
      expect(h.feedback.isPending(h.getActive())).toBe(true);
      h.requests[1].resolve({ ok: true });
      await current;
      expect(h.feedback.isPending(h.getActive())).toBe(false);
    },
  );

  it("does not warn after the initiating pane is removed", async () => {
    const h = harness();
    const operation = h.request();
    h.panes.delete("term-a");
    h.requests[0].resolve({ ok: false, error: "removed pane" });
    await operation;
    expect(h.feedback.isPending(h.getActive())).toBe(false);
    expect(toast).not.toHaveBeenCalled();
  });
});
