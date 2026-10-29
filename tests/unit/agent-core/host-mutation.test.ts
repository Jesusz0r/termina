import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitHostMutation } from "../../../agent-core/host/mutation.ts";
import { ackPath } from "../../../agent-core/host.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(acknowledge: (attempt: number) => Record<string, unknown> | null) {
  const eventsDir = mkdtempSync(join(tmpdir(), "termina-mutation-"));
  roots.push(eventsDir);
  const events: Array<{ t: string; requestId: string }> = [];
  let attempts = 0;
  const confirmDetached = vi.fn(async () => true);
  return { events, confirmDetached, options: {
    eventsDir, terminalId: "term-1", bridgeId: "core-test", shouldStop: () => false, confirmDetached,
    logEvent(event: { t: "mutation_request" | "mutation_finished"; requestId: string }) {
      events.push(event);
      if (event.t !== "mutation_request") return;
      const ack = acknowledge(++attempts);
      if (ack) writeFileSync(ackPath(eventsDir, "term-1", event.requestId), JSON.stringify(ack));
    },
  } };
}

describe("host mutation admission", () => {
  it("pairs an admitted action with the same lease request without an extra approval", async () => {
    const { options, events, confirmDetached } = fixture(() => ({ ok: true }));
    const admission = await admitHostMutation(options);
    expect(admission.ok).toBe(true);
    expect(confirmDetached).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    if (admission.ok) admission.finish();
    expect(events[1]).toEqual({ ...events[0], t: "mutation_finished" });
  });

  it("waits for explicit approval, then reacquires instead of reusing a detached grant", async () => {
    const { options, events } = fixture(attempt => attempt === 1 ? { ok: false, needsApproval: true } : { ok: true });
    let approve!: (value: boolean) => void;
    options.confirmDetached = vi.fn(() => new Promise(resolve => { approve = resolve; }));
    const pending = admitHostMutation(options);
    await vi.waitFor(() => expect(options.confirmDetached).toHaveBeenCalledOnce());
    expect(events.map(event => event.t)).toEqual(["mutation_request", "mutation_finished"]);
    approve(true);
    const admission = await pending;
    expect(admission.ok).toBe(true);
    expect(events[2]!.requestId).not.toBe(events[0]!.requestId);
    if (admission.ok) admission.finish();
    expect(events[3]).toEqual({ ...events[2], t: "mutation_finished" });
  });

  it("denies cancellation and a lease conflict after approval without another retry", async () => {
    const denied = fixture(() => ({ ok: false, needsApproval: true, error: "detached" }));
    denied.options.confirmDetached = vi.fn(async () => false);
    expect(await admitHostMutation(denied.options)).toEqual({ ok: false, error: "detached" });
    expect(denied.events).toHaveLength(2);
    const busy = fixture(attempt => attempt === 1 ? { ok: false, needsApproval: true } : { ok: false, error: "busy" });
    expect(await admitHostMutation(busy.options)).toEqual({ ok: false, error: "busy" });
    expect(busy.events.map(event => event.t)).toEqual(["mutation_request", "mutation_finished", "mutation_request", "mutation_finished"]);
    expect(busy.confirmDetached).toHaveBeenCalledOnce();
  });

  it("cancels an unacknowledged request so a late lease cannot remain held", async () => {
    const { options, events } = fixture(() => null);
    options.shouldStop = () => true;
    expect((await admitHostMutation(options)).ok).toBe(false);
    expect(events[1]).toEqual({ ...events[0], t: "mutation_finished" });
  });
});
