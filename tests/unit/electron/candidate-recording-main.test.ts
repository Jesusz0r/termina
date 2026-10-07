import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import type { RunRecord } from "../../../electron/worldlines/types.ts";

// Execute main's real producer without importing Electron or starting a PTY.
const source = ts.createSourceFile("main.ts", readFileSync(join(process.cwd(), "electron/main.ts"), "utf8"), ts.ScriptTarget.ES2022, true);
const members = source.statements.filter(ts.isClassDeclaration).flatMap((node) => [...node.members]);
const member = members.find((node) => ts.isMethodDeclaration(node) && node.name.getText(source) === "coupleRunStart");
if (!member) throw new Error("missing main coupleRunStart");
const body = ts.transpileModule(`return new (class { ${member.getText(source)} })();`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

interface Actor {
  id: string;
  workspaceId: string;
  pendingPrompt: null;
  currentRun: RunRecord | null;
  persist: boolean;
}
interface Producer {
  coupleRunStart(actor: Actor, event: { preflightToken?: string; entryId: string; parentEntryId?: string | null; sessionFile: string }): Promise<void>;
  pendingPreflights: Map<string, unknown>;
  workspaceOfTerminal: () => { generation: number };
  projectOfTerminal: () => { worldlines: object };
  initWorldlines: () => Promise<void>;
  releaseWriteLease: () => void;
  overlapInWorkspace: () => boolean;
  markOverlappingAgents: () => void;
  pushRun: (actor: Actor, record: RunRecord) => void;
}

for (const preflight of [true, false]) {
  describe(`recorded prompt parents ${preflight ? "with" : "without"} preflight`, () => {
    it.each([
      { parent: null, expected: "0" },
      { parent: undefined, expected: null },
      { parent: "12", expected: "12" },
      { parent: "invalid", expected: "invalid" },
    ])("preserves the declared parent $parent as $expected", async ({ parent, expected }) => {
      const producer = new Function("randomUUID", body)(() => "recording-test") as Producer;
      producer.pendingPreflights = new Map(preflight ? [["token", {
        terminalId: "term-1", workspaceId: "workspace-1", startState: { commit: "base" },
        generation: 1, leaseRequester: "preflight", trustHashes: {},
      }]] : []);
      producer.workspaceOfTerminal = () => ({ generation: 1 });
      producer.projectOfTerminal = () => ({ worldlines: {} });
      producer.initWorldlines = async () => {};
      producer.releaseWriteLease = vi.fn();
      producer.overlapInWorkspace = () => false;
      producer.markOverlappingAgents = vi.fn();
      producer.pushRun = (actor, record) => { actor.currentRun = record; };
      const actor: Actor = { id: "term-1", workspaceId: "workspace-1", pendingPrompt: null, currentRun: null, persist: false };
      await producer.coupleRunStart(actor, {
        ...(preflight ? { preflightToken: "token" } : {}),
        entryId: "13", parentEntryId: parent, sessionFile: "/sessions/source/current/active.jsonl",
      });
      expect(actor.currentRun?.promptParentEntryId).toBe(expected);
      expect(actor.currentRun?.replayable).toBe(preflight);
    });
  });
}
