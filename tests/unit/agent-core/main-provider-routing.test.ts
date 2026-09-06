import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

it.each([
  ["github-copilot", "gpt-5.6-terra", "/responses", "input"],
  ["github-copilot", "claude-sonnet-5", "/chat/completions", "messages"],
  ["github-copilot", "claude-sonnet-5", "/v1/messages", "messages"],
  ["github-copilot", "claude-opus-4.7", "/v1/messages", "messages"],
  ["xai", "grok-4.20-0309-non-reasoning", "/v1/responses", "input"],
])("routes a real %s request for %s to %s", (provider, model, endpoint, inputField) => {
  const root = mkdtempSync(join(tmpdir(), "termina-copilot-routing-"));
  const auth = join(root, "auth.json");
  const capture = join(root, "request.json");
  writeFileSync(auth, JSON.stringify({ [provider]: { type: "api_key", key: "fixture-key" } }));
  const main = new URL("../../../agent-core/main.ts", import.meta.url).href;
  const script = `
    import { writeFileSync } from 'node:fs';
    globalThis.fetch = async (url, options) => {
      if (String(url) === 'http://127.0.0.1:12345/models') {
        return Response.json({ data: [{ id: ${JSON.stringify(model)}, supported_endpoints: [${JSON.stringify(endpoint)}] }] });
      }
      if (!options?.body) return Response.json({});
      writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ url: String(url), body: JSON.parse(options.body), headers: options.headers }));
      return new Response('fixture: stop after request capture', { status: 400 });
    };
    process.argv = [process.execPath, new URL(${JSON.stringify(main)}).pathname, '-p', 'Reply OK'];
    await import(${JSON.stringify(main)});
  `;
  try {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
      cwd: root, encoding: "utf8", timeout: 15000,
      env: { ...process.env, HOME: root, TERMINA_AUTH_PATH: auth, TERMINA_CORE_TEST: "1",
        TERMINA_TEST_MODELS_URL: "http://127.0.0.1:12345/models", TERMINA_CORE_PROVIDER: provider,
        TERMINA_CORE_MODEL: model, TERMINA_TERMINAL_ID: "", TERMINA_EVENTS_DIR: "",
        TERMINA_CORE_SESSION_FILE: "", TERMINA_CORE_SESSION_ID: "", TERMINA_CORE_RESUME: "",
      },
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const request = JSON.parse(readFileSync(capture, "utf8"));
    expect(new URL(request.url).pathname).toBe(endpoint);
    expect(request.body[inputField]).toBeInstanceOf(Array);
    expect(request.body.model).toBe(model);
    if (model.endsWith("-non-reasoning")) expect(request.body).not.toHaveProperty("reasoning");
    if (endpoint === "/v1/messages") {
      expect(request.headers["anthropic-version"]).toBe("2023-06-01");
      expect(request.body.thinking).toEqual({ type: "adaptive", display: "summarized" });
    }
    if (endpoint === "/chat/completions") expect(request.body).not.toHaveProperty("thinking");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
