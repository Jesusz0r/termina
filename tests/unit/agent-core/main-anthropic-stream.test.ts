import { describe, it, expect } from "vitest";
/** Focused Anthropic stream bound contract. */
process.env.TERMINA_CORE_TEST = "1";

import assert from "node:assert/strict";
import { spawn } from "node:child_process";

describe("Agent Core Anthropic Stream-Bound Contract", () => {
  it("passes Anthropic stream-bound contract", async () => {
    const mainUrl = new URL("../../../agent-core/main.ts", import.meta.url).href;
    const childScript = `
      const huge = "x".repeat(300_000);
      globalThis.fetch = async (input) => {
        if (String(input) === "https://models.dev/api.json") {
          return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response([
          "data: " + JSON.stringify({ type: "message_start", message: { usage: {} } }),
          "",
          "data: " + JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
          "",
          "data: " + JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: huge } }),
          "",
          "data: " + JSON.stringify({ type: "content_block_stop", index: 0 }),
          "",
          "data: " + JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} }),
          "",
          "data: " + JSON.stringify({ type: "message_stop" }),
          "",
        ].join("\\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
      };
      process.argv = [process.execPath, new URL(${JSON.stringify(mainUrl)}).pathname, "-p", "anthropic stream bound probe"];
      await import(${JSON.stringify(mainUrl)});
    `;
    const child = spawn(
      process.execPath,
      ["--input-type=module", "--experimental-strip-types", "--no-warnings", "-e", childScript],
      {
        cwd: process.cwd(),
        env: { ...process.env, ANTHROPIC_API_KEY: "stream-bound-test-key", TERMINA_CORE_PROVIDER: "anthropic", TERMINA_CORE_MODEL: "claude-sonnet-4-5" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    let error = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { error += chunk; });
    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({ code: -1, signal: "SIGKILL" });
      }, 40_000);
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
    assert.equal(result.code, 0, error);
    assert.match(`${output}\n${error}`, /incomplete|bounded|limit/i);
    assert.ok(Buffer.byteLength(output, "utf8") < 100_000, "provider output must stop at the bound");
    console.log("agent-core Anthropic stream-bound contract passed");
  }, 60_000);
});
