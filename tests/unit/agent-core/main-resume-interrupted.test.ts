import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionWriter, replaySessionBundle } from "../../../agent-core/session.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("resume after an interrupted local tool", () => {
  for (const entry of ["primary", "subagent"] as const) {
    it(`${entry} appends an unknown error outcome once without rerunning or changing stored calls`, async () => {
      const root = mkdtempSync(join(tmpdir(), "termina-resume-interrupted-"));
      roots.push(root);
      const file = join(root, "core-1", "current", "session.jsonl");
      const opened = SessionWriter.open(file, 0);
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      for (const [index, message] of [
        { role: "user", content: "inspect" },
        { role: "assistant", content: [
          { type: "tool_use", id: "call-1", name: "bash", input: { command: "touch must-not-run" } },
          { type: "tool_use", id: "call-2", name: "read_file", input: { path: "x" } },
        ] },
      ].entries()) expect(opened.writer.appendRecord({ type: "message", storageSeq: index + 1, message }).ok).toBe(true);
      opened.writer.close();
      const original = readFileSync(file);
      const mainUrl = new URL("../../../agent-core/main.ts", import.meta.url).href;
      const sessionUrl = new URL("../../../agent-core/session.ts", import.meta.url).href;
      const script = `
        const core = await import(${JSON.stringify(mainUrl)});
        if (${JSON.stringify(entry)} === "primary") {
          const result = await core.testOnlyResumeSessionBody();
          if (!result.ok) throw new Error(result.error);
        } else {
          const { replaySessionBundle } = await import(${JSON.stringify(sessionUrl)});
          const replay = await replaySessionBundle(${JSON.stringify(file)});
          if (!replay.ok) throw new Error(replay.error);
          core.installResumedSubagentHistory(replay);
        }
        await core.shutdownAgentCore();
      `;
      const run = async () => {
        const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
          cwd: root, stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, HOME: root, TERMINA_CORE_TEST: "1", TERMINA_CORE_SESSION_ID: "core-1", TERMINA_CORE_SESSION_FILE: file, TERMINA_EVENTS_DIR: "", TERMINA_TERMINAL_ID: "" },
        });
        let output = "";
        child.stdout.on("data", chunk => { output += chunk; });
        child.stderr.on("data", chunk => { output += chunk; });
        const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
        expect(code, output).toBe(0);
      };
      await run();
      const once = readFileSync(file);
      expect(once.subarray(0, original.length)).toEqual(original);
      const replay = await replaySessionBundle(file);
      expect(replay.ok).toBe(true);
      if (!replay.ok) return;
      expect(replay.messages).toHaveLength(3);
      const results = replay.messages[2]!.content;
      expect(Array.isArray(results)).toBe(true);
      if (!Array.isArray(results)) return;
      expect(results.map(result => result.tool_use_id)).toEqual(["call-1", "call-2"]);
      for (const result of results) {
        expect(result.is_error).toBe(true);
        expect(result.content).toContain("outcome is unknown");
      }
      await run();
      expect(readFileSync(file)).toEqual(once);
      expect(existsSync(join(root, "must-not-run"))).toBe(false);
      expect(readFileSync(file, "utf8")).not.toContain('"exitCode":0');
    });
  }
});
