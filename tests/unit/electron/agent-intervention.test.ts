import { describe, expect, it } from "vitest";
import { activityFor, activityKey, activityView, applyActivityEvent, emptyActivityInput, hasLiveAgentWork, type ActivitySignal } from "../../../electron/agent-activity.ts";
import { sidecarEventFromRecord } from "../../../electron/sidecar.ts";
import { projectWorkSummary, workOverview, type WorkSummaryTerminalFacts } from "../../../electron/main/work-summary.ts";

const pending = { requestId: "approval-1", kind: "permission" as const, since: 1000 };
const request = (overrides = {}): ActivitySignal => ({ t: "intervention_requested", seq: 2, at: 9000, ...pending, ...overrides });
const view = (events: ActivitySignal[]) => activityView(activityFor(events.reduce(applyActivityEvent, emptyActivityInput())));

function terminal(id: string, events: ActivitySignal[] = []): WorkSummaryTerminalFacts {
  return { id, generation: 3, type: "agent", model: null, activity: view(events),
    workspace: { id: "ws-1", root: "/project", primary: true },
    verify: { state: "untested", command: null, summary: null }, trackedChanges: 0, plan: [],
    dispatchAssignment: null };
}

describe("canonical human intervention", () => {
  it("publishes the producer's request identity and start time, not receipt time", () => {
    const input = applyActivityEvent(emptyActivityInput(), request());
    expect(activityView(activityFor(input))).toEqual({ state: "blocked", reason: "permission-required", intervention: pending });
    expect(hasLiveAgentWork(input)).toBe(true);
  });

  it("preserves age through duplicate requests, unrelated activity, holds and parent settlement", () => {
    const events: ActivitySignal[] = [request(), request({ seq: 3, since: 5000 }),
      { t: "tool", seq: 4, at: 10_000, target: "read" },
      { t: "tool_end", seq: 5, at: 11_000, target: "read", isError: false },
      { t: "sidecar_hold", seq: 6, at: 12_000, held: true },
      { t: "agent_settled", seq: 7, at: 13_000, error: null }];
    expect(view(events)).toMatchObject({ reason: "sidecar-paused", intervention: pending });
    expect(view([...events, { t: "sidecar_hold", seq: 8, at: 14_000, held: false }])).toEqual({
      state: "blocked", reason: "permission-required", intervention: pending,
    });
  });

  it("resolves only the exact current picker and never substitutes a new request", () => {
    const next = { ...pending, requestId: "approval-2", since: 6000 };
    const events: ActivitySignal[] = [request(), request({ ...next, seq: 3 }),
      { t: "intervention_resolved", seq: 4, at: 12_000, requestId: pending.requestId }];
    expect(view(events).intervention).toEqual(next);
    expect(view([...events, { t: "intervention_resolved", seq: 5, at: 13_000, requestId: next.requestId }])).toEqual({
      state: "idle", reason: null, intervention: null,
    });
    expect(activityKey(view([request()]))).not.toBe(activityKey(view([request(next)])));
  });

  it("clears intervention when the terminal exits and resumes working after an answer", () => {
    const start: ActivitySignal = { t: "agent_start", seq: 1, at: 500 };
    expect(view([start, request(), { t: "pty_exit", seq: 3, at: 10_000 }])).toEqual({
      state: "blocked", reason: "exited-mid-run", intervention: null,
    });
    expect(view([start, request(), { t: "intervention_resolved", seq: 3, at: 10_000, requestId: pending.requestId }])).toEqual({
      state: "working", reason: null, intervention: null,
    });
  });

  it("never turns idle, stalled, internal waits or failed checks into human input", () => {
    expect(view([]).intervention).toBeNull();
    expect(view([{ t: "agent_settled", seq: 1, at: 1000, error: "stalled" }]).intervention).toBeNull();
    expect(view([{ t: "preflight_request", seq: 1, at: 1000 }, { t: "preflight_timeout", seq: 2, at: 2000 }]).intervention).toBeNull();
    const facts = terminal("verify-failed");
    facts.verify = { state: "fail", command: "test", summary: "failed" };
    expect(projectWorkSummary({ id: "project", cwd: "/project" }, [facts]).terminals[0]!.activity!.intervention).toBeNull();
  });
});

describe("intervention sidecar validation", () => {
  const record = { bridgeId: "bridge", generation: "producer-1", seq: 1, t: "intervention_requested", ...pending };
  it("decodes only bounded, explicit permission signals without prompt content", () => {
    expect(sidecarEventFromRecord({ ...record, text: "secret command" })).toEqual(record);
    expect(sidecarEventFromRecord({ ...record, t: "intervention_resolved" })).toEqual({
      bridgeId: record.bridgeId, generation: record.generation, seq: 1, t: "intervention_resolved", requestId: pending.requestId,
    });
  });
  it.each([{}, { requestId: "" }, { requestId: "x".repeat(129) }, { requestId: "../bad" },
    { kind: "working" }, { since: undefined }, { since: 0 }, { since: -1 }, { since: 1.5 }, { since: "1000" }, { since: Infinity }])(
    "rejects incomplete or malformed requests %j", (bad) => {
      const value = Object.keys(bad).length ? { ...record, ...bad } : { bridgeId: "bridge", seq: 1, t: record.t };
      expect(sidecarEventFromRecord(value)).toBeNull();
    },
  );
  it("rejects a resolution without an exact bounded identity", () => {
    expect(sidecarEventFromRecord({ bridgeId: "bridge", seq: 1, t: "intervention_resolved" })).toBeNull();
  });
});

describe("intervention in canonical work overview", () => {
  const project = { id: "project", cwd: "/project" };
  it("projects pending metadata and sorts real interventions oldest first without consuming them", () => {
    const summary = projectWorkSummary(project, [terminal("new", [request({ since: 3000 })]),
      terminal("wait", [{ t: "preflight_request", seq: 1, at: 10 }, { t: "preflight_timeout", seq: 2, at: 20 }]),
      terminal("old", [request({ requestId: "old", since: 500 })]), terminal("tie", [request({ requestId: "tie", since: 500 })])]);
    const before = structuredClone(summary);
    const overview = workOverview([summary]);
    expect(overview.items.map((item) => item.terminalId)).toEqual(["old", "tie", "new", "wait"]);
    expect(overview.projects[0]!.terminals[0]!.activity!.intervention).toEqual({ ...pending, since: 3000 });
    expect(overview.items[0]!.action).toEqual({ kind: "terminal", terminalId: "old", generation: 3 });
    expect(workOverview([summary])).toEqual(overview);
    expect(summary).toEqual(before);
  });

  it("invalidates an attention target when its picker is replaced or resolved", () => {
    const items = (events: ActivitySignal[]) => workOverview([projectWorkSummary(project, [terminal("term", events)])]).items;
    const first = items([request()]);
    expect(items([request({ requestId: "new-request" })])[0]!.id).not.toBe(first[0]!.id);
    expect(items([request(), { t: "intervention_resolved", seq: 3, at: 10_000, requestId: pending.requestId }])).toEqual([]);
  });
});
