import { describe, it } from "vitest";
/** Shutdown must resolve an in-flight approval before tearing down the TUI. */
process.env.TERMINA_CORE_TEST = "1";

import assert from "node:assert/strict";
import { spawn } from "@lydell/node-pty";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("Agent Core Shutdown Approval Contract", () => {
  it("passes shutdown-with-pending-approval contract", async () => {
    const root = mkdtempSync(join(tmpdir(), "termina-shutdown-approval-"));
    const cwd = join(root, "project");
    const home = join(root, "home");
    mkdirSync(cwd);
    mkdirSync(home);
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith("TERMINA_") || key.startsWith("PI_")) delete env[key];
    }
    const mainPath = new URL("../../../agent-core/main.ts", import.meta.url).pathname;
    const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
    const functionCall = {
      type: "function_call",
      id: "item-1",
      call_id: "call-1",
      name: "bash",
      arguments: JSON.stringify({ command: "echo approval-shutdown" }),
    };
    const body = [
      event({ type: "response.output_item.added", item: functionCall }),
      event({
        type: "response.completed",
        response: { status: "completed", output: [functionCall], usage: { input_tokens: 1, output_tokens: 1 } },
      }),
    ].join("");
    const childScript = `
      globalThis.fetch = async () => new Response(${JSON.stringify(body)}, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
      process.argv = [process.execPath, ${JSON.stringify(mainPath)}];
      await import(${JSON.stringify(new URL("../../../agent-core/main.ts", import.meta.url).href)});
    `;
    
    const pty = spawn(
      process.execPath,
      ["--input-type=module", "--experimental-strip-types", "--no-warnings", "-e", childScript],
      {
        name: "xterm-256color",
        cols: 120,
        rows: 40,
        cwd,
        env: {
          ...env,
          HOME: home,
          TERMINA_AUTH_PATH: join(home, "auth.json"),
          TERMINA_CORE_SESSION_FILE: join(root, "sessions", "core-shutdown", "current", "session.jsonl"),
          TERMINA_CORE_TEST: "1",
          TERMINA_CORE_PROVIDER: "openai",
          TERMINA_CORE_MODEL: "gpt-5.6-sol",
          TERMINA_CORE_APPROVE: "ask",
          OPENAI_API_KEY: "shutdown-approval-test-key",
        },
      },
    );
    
    let exited = false;
    const closed = new Promise<{ exitCode: number; signal?: number }>((resolve) => {
      pty.onExit((result) => { exited = true; resolve(result); });
    });
    let output = "";
    pty.onData((chunk) => { output += chunk; });
    const waitFor = async (predicate: () => boolean, timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      while (!predicate()) {
        if (Date.now() >= deadline) throw new Error(`timed out; output=${output}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };
    try {
      // The placeholder is painted before MCP startup finishes. Wait for the
      // idle status (no spinner) so this test actually reaches an approval.
      await waitFor(() => /termina\s+·\s+openai\//.test(output), 8_000);
      pty.write("please run the command\r");
      await waitFor(() => /Approve bash\?/.test(output), 8_000);
      // Ctrl-D invokes the same shutdown path as an explicit TUI exit while the
      // choice prompt is still live. A stuck approval promise would keep this
      // pty open or dereference the torn-down surface.
      pty.write("\x04");
      await waitFor(() => exited, 8_000);
      const exit = await closed;
      assert.equal(exit.exitCode, 0, output);
      assert.match(output, /approval-shutdown|interrupted|denied|quits/i);
      console.log("agent-core shutdown-with-pending-approval contract passed");
    } finally {
      if (!exited) {
        try { pty.kill("SIGKILL"); } catch { /* already exited */ }
      }
      await closed;
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
