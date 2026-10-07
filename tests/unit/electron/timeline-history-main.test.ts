import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import type { RecorderState, TimelineEvent } from "../../../shared/types.ts";

const source = ts.createSourceFile("main.ts", readFileSync(new URL("../../../electron/main.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const names = new Set(["evictForkPoints", "setRecorderState", "trimTimelineContent", "MAX_FORK_POINTS"]);
const members: string[] = [];
function visit(node: ts.Node): void {
  if ((ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node)) && names.has(node.name.getText(source))) members.push(node.getText(source));
  ts.forEachChild(node, visit);
}
visit(source);
if (members.length !== names.size) throw new Error("timeline history methods missing");
const compiled = ts.transpile(`class TerminaApp { ${members.join("\n")} } return new TerminaApp();`, { target: ts.ScriptTarget.ES2022 });

function fixture() {
  const main = new Function("MAX_TIMELINE_CONTENT_BYTES", compiled)(4 * 1024 * 1024) as {
    send: ReturnType<typeof vi.fn>;
    releaseStateIfUnused: ReturnType<typeof vi.fn>;
    projectOfTerminal: () => null;
    evictForkPoints(terminal: typeof inst): void;
    setRecorderState(terminal: typeof inst, state: RecorderState, expected?: unknown, detail?: string): void;
    trimTimelineContent(terminal: typeof inst): void;
  };
  const inst = { id: "term-1", timeline: [] as TimelineEvent[], recorderState: "ready" as RecorderState, recorderDetail: null as string | null, lastSentRecorderDetail: null as string | null };
  Object.assign(main, { send: vi.fn(), releaseStateIfUnused: vi.fn(), projectOfTerminal: () => null });
  return { main, inst };
}

function moment(seq: number): TimelineEvent {
  return { seq, ts: seq, t: "tool", toolName: "read", relPath: `${seq}.txt`, entryId: String(seq), stateId: `state-${seq}` };
}

describe("bounded timeline history", () => {
  it("does not erase the history limitation when capture becomes ready", () => {
    const { main, inst } = fixture();
    inst.timeline = Array.from({ length: 106 }, (_, i) => moment(i + 1));
    main.evictForkPoints(inst);
    expect(inst.timeline.filter((event) => event.evicted)).toHaveLength(6);
    expect(inst.recorderState).toBe("budget");
    // This is the actual capture sequence: attachMomentState evicts, then ready.
    main.setRecorderState(inst, "ready");
    expect(inst.recorderState).toBe("budget");
    expect(main.send.mock.calls.filter(([channel]) => channel === "timeline:recorder-state")).toHaveLength(1);
  });

  it("keeps capture failure visible and restores the limitation after recovery", () => {
    const { main, inst } = fixture();
    inst.timeline = [{ ...moment(1), stateId: null, evicted: true }, moment(2)];
    main.setRecorderState(inst, "degraded", undefined, "capture unavailable");
    expect(inst.recorderState).toBe("degraded");
    expect(inst.recorderDetail).toBe("capture unavailable");
    main.setRecorderState(inst, "ready");
    expect(inst.recorderState).toBe("budget");
    expect(inst.recorderDetail).toBeNull();
  });

  it("does not invent omitted history, and clearing the session removes its limitation", () => {
    const { main, inst } = fixture();
    inst.timeline = [moment(1)];
    main.setRecorderState(inst, "ready");
    expect(inst.recorderState).toBe("ready");
    inst.timeline = [];
    inst.recorderState = "budget";
    main.setRecorderState(inst, "ready");
    expect(inst.recorderState).toBe("ready");
  });

  it("drops the oldest file snapshots without replacing them with current content", () => {
    const { main, inst } = fixture();
    inst.timeline = Array.from({ length: 50 }, (_, i) => ({ ...moment(i + 1), content: String(i).padEnd(90_000, "x") }));
    main.trimTimelineContent(inst);
    expect(inst.timeline.slice(0, 4).every((event) => event.content === undefined)).toBe(true);
    expect(inst.timeline.slice(4).every((event) => event.content !== undefined && event.stateId !== null)).toBe(true);
    expect(inst.timeline).toHaveLength(50);
  });
});
