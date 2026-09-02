import { describe, it, expect } from "vitest";
/** End-to-end cancellation contract for provider auth and user catalog work. */
process.env.TERMINA_CORE_TEST = "1";

import assert from "node:assert/strict";
import { spawn } from "@lydell/node-pty";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

describe("Agent Core Catalog Cancellation Contract", () => {
  it("passes catalog cancellation contract", async () => {
    const root = mkdtempSync(join(tmpdir(), "termina-main-catalog-cancel-"));
    const mainPath = new URL("../../../agent-core/main.ts", import.meta.url).pathname;
    const mainUrl = new URL("../../../agent-core/main.ts", import.meta.url).href;
    const scenarios = new Map();
    
    const server = createServer((req, res) => {
      const match = new URL(req.url || "/", "http://127.0.0.1").pathname.match(/^\/([^/]+)\/(models|token|v1\/messages)$/);
      if (!match) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      const [, id, kind] = match;
      const state = scenarios.get(id);
      if (!state) {
        res.statusCode = 404;
        res.end("unknown scenario");
        return;
      }
      res.setHeader("content-type", "application/json");
      if (kind === "models") {
        state.modelRequests += 1;
        const mode = state.modelModes[state.modelRequests - 1] ?? state.modelModes.at(-1) ?? "normal";
        if (mode === "hang") {
          state.catalogHangs += 1;
          res.flushHeaders();
          res.write('{"data":[');
          return;
        }
        res.end(JSON.stringify({
          data: [
            { id: "claude-sonnet-5", display_name: "Claude Sonnet 5" },
            { id: "gpt-5.6-sol", name: "GPT 5.6 Sol" },
          ],
          has_more: false,
        }));
        return;
      }
      if (kind === "token") {
        state.tokenRequests += 1;
        if (state.tokenMode === "hang") {
          state.tokenHangs += 1;
          res.flushHeaders();
          res.write('{"access_token":"pending');
          return;
        }
        res.end(JSON.stringify({
          access_token: "sk-ant-oat-login-access",
          refresh_token: "refresh-after-login",
          expires_in: 3_600,
        }));
        return;
      }
      state.providerRequests += 1;
      res.setHeader("content-type", "text/event-stream");
      res.end([
        `data: ${JSON.stringify({ type: "message_start", message: { usage: {} } })}`,
        "",
        `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
        "",
        `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } })}`,
        "",
        `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
        "",
        `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} })}`,
        "",
        `data: ${JSON.stringify({ type: "message_stop" })}`,
        "",
      ].join("\n"));
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    
    const validAnthropic = () => ({
      type: "oauth",
      access: "sk-ant-oat-valid-access",
      refresh: "refresh-valid",
      expires: Date.now() + 60 * 60 * 1_000,
    });
    const expiredOauth = () => ({
      type: "oauth",
      access: "expired-access",
      refresh: "refresh-expired",
      expires: Date.now() - 1,
    });
    
    function readJsonLines(path) {
      if (!existsSync(path)) return [];
      return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    }
    
    function clean(text) {
      return text
        .replace(/\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
        .replace(/\r/g, "");
    }
    
    async function waitFor(predicate, timeoutMs, detail) {
      const deadline = Date.now() + timeoutMs;
      while (!predicate()) {
        if (Date.now() >= deadline) {
          const rendered = typeof detail === "function" ? detail() : detail;
          throw new Error(`timed out waiting for ${rendered}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    
    function replaceAuth(path, data) {
      const next = `${path}.next`;
      writeFileSync(next, `${JSON.stringify(data)}\n`, { mode: 0o600 });
      renameSync(next, path);
      const future = new Date(Date.now() + 2_000);
      utimesSync(path, future, future);
    }
    
    async function startScenario(name, options = {}) {
      const dir = join(root, name);
      const eventsDir = join(dir, "events");
      const terminalId = `term-${name}`;
      const sessionId = `${terminalId}-session`;
      const sessionFile = join(eventsDir, sessionId, "current", "session.jsonl");
      const authPath = join(dir, "auth.json");
      mkdirSync(eventsDir, { recursive: true, mode: 0o700 });
      writeFileSync(authPath, `${JSON.stringify(options.auth ?? { anthropic: validAnthropic() })}\n`, { mode: 0o600 });
      const state = {
        modelModes: options.modelModes ?? ["normal"],
        tokenMode: options.tokenMode ?? "normal",
        modelRequests: 0,
        tokenRequests: 0,
        providerRequests: 0,
        catalogHangs: 0,
        tokenHangs: 0,
      };
      scenarios.set(name, state);
      const childScript = `
        const realFetch = globalThis.fetch;
        globalThis.fetch = (input, init) => {
          if (String(input) === "https://models.dev/api.json") {
            return Promise.resolve(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
          }
          return realFetch(input, init);
        };
        process.argv = [process.execPath, ${JSON.stringify(mainPath)}];
        await import(${JSON.stringify(mainUrl)});
      `;
      const pty = spawn(
        process.execPath,
        ["--input-type=module", "--experimental-strip-types", "--no-warnings", "-e", childScript],
        {
          name: "xterm-256color",
          cols: 120,
          rows: 40,
          cwd: process.cwd(),
          env: {
            ...process.env,
            TERMINA_AUTH_PATH: authPath,
            TERMINA_CORE_APPROVE: "all",
            TERMINA_CORE_MODEL: "claude-sonnet-5",
            TERMINA_CORE_PROVIDER: "anthropic",
            TERMINA_CORE_SESSION_FILE: sessionFile,
            TERMINA_CORE_SESSION_ID: sessionId,
            TERMINA_CORE_TEST: "1",
            TERMINA_EVENTS_DIR: eventsDir,
            TERMINA_TERMINAL_ID: terminalId,
            TERMINA_TEST_AUTHORIZE_URL: `${origin}/${name}/authorize`,
            TERMINA_TEST_MODELS_URL: `${origin}/${name}/models`,
            TERMINA_TEST_TOKEN_URL: `${origin}/${name}/token`,
            ANTHROPIC_BASE_URL: `${origin}/${name}`,
          },
        },
      );
      let output = "";
      let exited = false;
      let resolveExit;
      const exitPromise = new Promise((resolve) => { resolveExit = resolve; });
      pty.onData((chunk) => { output += chunk; });
      pty.onExit(() => {
        exited = true;
        resolveExit();
      });
      const ackTimer = setInterval(() => {
        try {
          const requests = readJsonLines(join(eventsDir, `${terminalId}.jsonl`)).filter(
            (row) => row.t === "preflight_request" || row.t === "checkpoint_request",
          );
          for (const request of requests) {
            if (!request.requestId) continue;
            const ack = join(eventsDir, `ack-${terminalId}-${request.requestId}.json`);
            if (!existsSync(ack)) writeFileSync(ack, JSON.stringify({ ok: true }), { mode: 0o600 });
          }
        } catch {
          /* Wait for the request. */
        }
      }, 10);
      await waitFor(() => clean(output).includes("Type a task") && state.modelRequests >= 1, 8_000, `${name} startup; output=${clean(output)}`);
      return {
        authPath,
        eventsDir,
        terminalId,
        sessionFile,
        state,
        get output() { return output; },
        tail(mark) { return clean(output.slice(mark)); },
        mark() { return output.length; },
        write(text) { pty.write(text); },
        replaceAuth(data) { replaceAuth(authPath, data); },
        async stop() {
          clearInterval(ackTimer);
          if (!exited) {
            try { pty.kill(); } catch { /* already exited */ }
          }
          const waitForExit = (timeoutMs) => new Promise((resolve) => {
            if (exited) {
              resolve(true);
              return;
            }
            const timer = setTimeout(() => resolve(false), timeoutMs);
            exitPromise.then(() => {
              clearTimeout(timer);
              resolve(true);
            });
          });
          let closed = await waitForExit(2_000);
          if (!closed) {
            try { pty.kill("SIGKILL"); } catch { /* already exited */ }
            closed = await waitForExit(2_000);
          }
          if (!closed) throw new Error(`${name} PTY did not exit during cleanup`);
          scenarios.delete(name);
        },
      };
    }
    
    async function expectCancelled(app, expected) {
      const mark = app.mark();
      const started = performance.now();
      app.write("\x03");
      await waitFor(
        () => app.tail(mark).includes(expected),
        2_000,
        `${expected}; tail=${app.tail(mark)}`,
      );
      assert.ok(performance.now() - started < 3_000, `${expected} did not restore the prompt promptly`);
      const probe = app.mark();
      app.write("/model\r");
      await waitFor(
        () => app.tail(probe).includes("anthropic/claude-sonnet-5"),
        2_000,
        () => `post-cancel prompt probe; tail=${app.tail(probe)}`,
      );
      return app.tail(mark);
    }
    
    test("main auth and catalog operations retain caller cancellation", async (t) => {
      t.after(async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        rmSync(root, { recursive: true, force: true });
      });
    
      await t.test("provider turn detaches from a hanging expired-token refresh", async () => {
        const app = await startScenario("provider-turn", { tokenMode: "hang" });
        try {
          app.replaceAuth({ anthropic: expiredOauth() });
          app.write("provider cancellation probe\r");
          await waitFor(() => app.state.tokenHangs === 1, 2_000, "provider refresh to hang");
          await expectCancelled(app, "(interrupted)");
          const session = readJsonLines(app.sessionFile);
          const sidecar = readJsonLines(join(app.eventsDir, `${app.terminalId}.jsonl`));
          assert.equal(session.some((row) => row.message?.role === "assistant"), false);
          assert.equal(sidecar.some((row) => row.t === "tool"), false);
          assert.equal(app.state.providerRequests, 0);
        } finally {
          await app.stop();
        }
      });
    
      await t.test("/models refresh cancels while auth refresh is hanging", async () => {
        const app = await startScenario("models-auth", { tokenMode: "hang" });
        try {
          app.replaceAuth({ anthropic: expiredOauth() });
          app.write("/models refresh\r");
          await waitFor(() => app.state.tokenHangs === 1, 2_000, "catalog auth refresh to hang");
          await expectCancelled(app, "models request cancelled");
        } finally {
          await app.stop();
        }
      });
    
      await t.test("/models refresh cancels a hanging catalog body", async () => {
        const app = await startScenario("models-body", { modelModes: ["normal", "hang"] });
        try {
          app.write("/models refresh\r");
          await waitFor(() => app.state.catalogHangs === 1, 2_000, "catalog response body to hang");
          await expectCancelled(app, "models request cancelled");
        } finally {
          await app.stop();
        }
      });
    
      await t.test("/model cross-provider auth cancellation does not switch the route", async () => {
        const app = await startScenario("model-auth", {
          tokenMode: "hang",
          auth: { anthropic: validAnthropic(), "openai-codex": expiredOauth() },
        });
        try {
          app.write("/model openai-codex/gpt-5.6-sol\r");
          await waitFor(() => app.state.tokenHangs === 1, 2_000, "cross-provider auth refresh to hang");
          const tail = await expectCancelled(app, "models request cancelled");
          assert.ok(/termina\s+·\s+anthropic\/claude-sonnet-5/.test(tail) || tail.includes("anthropic/claude-sonnet-5"));
        } finally {
          await app.stop();
        }
      });
    
      await t.test("/model cross-provider catalog cancellation does not switch the route", async () => {
        const app = await startScenario("model-body", {
          modelModes: ["normal", "hang"],
          auth: { anthropic: validAnthropic(), openai: { type: "api_key", key: "openai-key" } },
        });
        try {
          app.write("/model openai/gpt-5.6-sol\r");
          await waitFor(() => app.state.catalogHangs === 1, 2_000, "cross-provider catalog body to hang");
          const tail = await expectCancelled(app, "models request cancelled");
          assert.ok(/termina\s+·\s+anthropic\/claude-sonnet-5/.test(tail) || tail.includes("anthropic/claude-sonnet-5"));
        } finally {
          await app.stop();
        }
      });
    
      await t.test("post-login catalog keeps the login cancellation signal", async () => {
        const app = await startScenario("post-login", { modelModes: ["normal", "hang"], tokenMode: "normal" });
        try {
          app.write("/login anthropic code\r");
          await waitFor(() => clean(app.output).includes("paste the authorization code"), 2_000, "login code prompt");
          app.write("fixture-code\r");
          await waitFor(() => app.state.tokenRequests === 1 && app.state.catalogHangs === 1, 2_000, "post-login catalog body to hang");
          await expectCancelled(app, "models request cancelled");
        } finally {
          await app.stop();
        }
      });
    
      await t.test("normal catalog switch and login still complete", async () => {
        const app = await startScenario("normal");
        try {
          let mark = app.mark();
          app.write("/models refresh\r");
          await waitFor(
            () => app.tail(mark).includes("Claude Sonnet 5"),
            2_000,
            () => `normal model list; tail=${app.tail(mark)}`,
          );
          mark = app.mark();
          app.write("/model anthropic/claude-sonnet-5\r");
          await waitFor(
            () => app.tail(mark).includes("model anthropic/claude-sonnet-5"),
            2_000,
            () => `normal model switch; tail=${app.tail(mark)}`,
          );
          mark = app.mark();
          app.write("/login anthropic code\r");
          await waitFor(() => app.tail(mark).includes("paste the authorization code"), 2_000, "normal login code prompt");
          app.write("fixture-code\r");
          await waitFor(
            () => app.state.tokenRequests >= 1 && app.state.modelRequests >= 3 && app.tail(mark).includes("auth: oauth"),
            2_000,
            "normal login completion",
          );
        } finally {
          await app.stop();
        }
      });
    });
  }, 60_000);
});
