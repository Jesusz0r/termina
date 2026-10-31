import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isRecord } from "../../../shared/guards.ts";
import {
  BrowserSession,
  browserApprovalPrompt,
  browserRequestLabel,
  browserRequestNeedsApproval,
  browserToolDefinition,
  parseBrowserRequest,
} from "../../../agent-core/main/browser.ts";

// Stands in for agent-browser: one page URL and an optional popup, kept beside
// the script so the test can read every invocation.
const FAKE_BROWSER = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const dir = __dirname;
const statePath = path.join(dir, "state.json");
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { url: "about:blank", popup: false };
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "args.log"), JSON.stringify({ args, cwd: process.cwd(), home: process.env.HOME }) + "\\n");
const cmd = args.slice(9);
const ok = (data) => process.stdout.write(JSON.stringify({ success: true, data, error: null }) + "\\n");
if (cmd[0] === "open") {
  state.url = cmd[1].includes("redirect") ? "http://other.test/" : cmd[1];
  ok({ url: state.url, title: "Fixture" });
} else if (cmd[0] === "tab" && cmd[1] === "list") {
  ok({ tabs: state.popup ? [{ tabId: "t1" }, { tabId: "t2" }] : [{ tabId: "t1" }] });
} else if (cmd[0] === "tab" && cmd[1] === "close") {
  state.popup = false;
  ok({ closed: true });
} else if (cmd[0] === "get" && cmd[1] === "url") {
  ok({ url: state.url });
} else if (cmd[0] === "snapshot") {
  ok({ snapshot: '- button "Go" [ref=e1]', refs: { e1: { role: "button", name: "Go" } } });
} else if (cmd[0] === "click" && cmd[1] === "#leave") {
  state.url = "http://other.test/landing";
  ok({ clicked: cmd[1] });
} else if (cmd[0] === "dialog") {
  ok(cmd[1] === "status" ? { hasDialog: Boolean(state.dialog) } : { handled: true, accepted: false });
  if (cmd[1] === "dismiss") state.dialog = false;
} else if (cmd[0] === "click" && cmd[1] === "#confirm") {
  state.dialog = true;
  ok({ clicked: cmd[1], dialogOpened: true });
} else if (cmd[0] === "click" && cmd[1] === "#alert") {
  ok({ clicked: cmd[1], dialogOpened: true });
} else if (cmd[0] === "click" && cmd[1] === "#popup") {
  state.popup = true;
  ok({ clicked: cmd[1] });
} else {
  ok({ done: cmd[0] });
}
fs.writeFileSync(statePath, JSON.stringify(state));
`;

describe("browser tool", () => {
  let root: string;
  let cwd: string;
  let fakeBin: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "termina-browser-test-"));
    cwd = join(root, "project");
    fakeBin = join(root, "bin", "agent-browser");
    for (const dir of [cwd, dirname(fakeBin)]) mkdirSync(dir, { recursive: true });
    writeFileSync(fakeBin, FAKE_BROWSER, { mode: 0o755 });
    chmodSync(fakeBin, 0o755);
  });

  beforeEach(() => {
    for (const name of ["state.json", "args.log"]) rmSync(join(dirname(fakeBin), name), { force: true });
  });

  const sessions: BrowserSession[] = [];
  function browser(): BrowserSession {
    const session = new BrowserSession({ binaryPath: fakeBin, cwd });
    sessions.push(session);
    return session;
  }

  afterEach(() => {
    for (const session of sessions.splice(0)) session.closeSync();
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function request(input: Record<string, unknown>) {
    const parsed = parseBrowserRequest(input);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.request;
  }

  function calls(): Array<{ args: string[]; cwd: string; home: string }> {
    const log = join(dirname(fakeBin), "args.log");
    if (!existsSync(log)) return [];
    return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }

  function commands(): string[] {
    return calls().map((call) => call.args.slice(9).join(" "));
  }

  it("validates URLs, actions, and arguments", () => {
    expect(parseBrowserRequest({ action: "open", url: "http://localhost:3000" })).toEqual({
      ok: true,
      request: { action: "open", url: "http://localhost:3000/" },
    });
    for (const url of ["file:///etc/passwd", "https://user:pass@example.com", "javascript:alert(1)", "about:blank"]) {
      expect(parseBrowserRequest({ action: "open", url }).ok).toBe(false);
    }
    expect(parseBrowserRequest({ action: "click" }).ok).toBe(false);
    expect(parseBrowserRequest({ action: "fill", selector: "#name", text: "" }).ok).toBe(true);
    expect(parseBrowserRequest({ action: "type", selector: "#name", text: "" }).ok).toBe(false);
    expect(parseBrowserRequest({ action: "wait", ms: 10, selector: "body" }).ok).toBe(false);
    expect(parseBrowserRequest({ action: "get", property: "text" }).ok).toBe(false);
    expect(parseBrowserRequest({ action: "screenshot" }).ok).toBe(false);
    expect(parseBrowserRequest({ action: "close", all: true }).ok).toBe(false);
    for (const key of ["Meta+v", "Control+V", "ctrl+shift+v", "Shift+Insert"]) {
      expect(parseBrowserRequest({ action: "press", key }).ok).toBe(false);
    }
    expect(parseBrowserRequest({ action: "press", key: "Control+a" }).ok).toBe(true);
    expect(parseBrowserRequest({ action: "open", url: "http://localhost", extra: true }).ok).toBe(false);
  });

  it("asks for navigation and input, shows the full origin, and caps only path and text", () => {
    expect(browserRequestNeedsApproval(request({ action: "open", url: "https://a.test" }))).toBe(true);
    expect(browserRequestNeedsApproval(request({ action: "press", key: "Enter" }))).toBe(true);
    expect(browserRequestNeedsApproval(request({ action: "snapshot" }))).toBe(false);
    expect(browserRequestNeedsApproval(request({ action: "get", property: "title" }))).toBe(false);
    const host = `${"sub.".repeat(60)}example.test:8443`;
    const open = browserApprovalPrompt(request({ action: "open", url: `https://${host}/${"p".repeat(500)}` }), null, null);
    expect(open).toContain(`https://${host}`);
    expect(open.length).toBeLessThan(host.length + 200);
    expect(open.startsWith(`[https://${host}] open`)).toBe(true);
    const fill = browserApprovalPrompt(request({ action: "fill", selector: "@e1", text: "x".repeat(500) }), "http://localhost:3000", "textbox Email");
    expect(fill.startsWith("[http://localhost:3000] fill")).toBe(true);
    expect(fill).toContain('"textbox Email"');
    expect(fill.length).toBeLessThan(260);
    // A page-controlled label or a huge selector cannot push the origin away or fake another one.
    const hostile = browserApprovalPrompt(
      request({ action: "click", selector: `#${"a".repeat(1999)}` }),
      "http://localhost:3000",
      'Go) [https://bank.example] click "ok',
    );
    expect(hostile.startsWith("[http://localhost:3000] click ")).toBe(true);
    expect(hostile.length).toBeLessThan(220);
    expect(hostile).toContain('\\"ok');
    const def = browserToolDefinition();
    if (!isRecord(def.input_schema) || !isRecord(def.input_schema.properties)) throw new Error("bad schema");
    expect(Object.keys(def.input_schema.properties)).not.toContain("path");
    expect(browserRequestLabel(request({ action: "click", selector: "@e2" }))).toBe("click @e2");
  });

  it("refuses page reads before an approved open without starting the browser", async () => {
    const session = browser();
    expect(session.admit(request({ action: "snapshot" }))).toContain("no page is open");
    const result = await session.run(request({ action: "get", property: "title" }));
    expect(result.output.isError).toBe(true);
    expect(calls()).toHaveLength(0);
  });

  it("runs from private state with its own config, profile, and downloads, and deletes them on close", async () => {
    const session = browser();
    const opened = await session.run(request({ action: "open", url: "http://localhost:3000" }));
    expect(opened.output.content).toContain("opened http://localhost:3000/");
    expect(session.pageOrigin).toBe("http://localhost:3000");
    const [call] = calls();
    const stateRoot = dirname(call!.args[2]!);
    expect(call!.cwd).toBe(realpathSync(stateRoot));
    expect(stateRoot).not.toBe(cwd);
    expect(call!.home).toBe(join(stateRoot, "home"));
    expect(call!.args.slice(0, 9)).toEqual([
      "--json",
      "--config", join(stateRoot, "config.json"),
      "--session", "termina",
      "--profile", join(stateRoot, "profile"),
      "--download-path", join(stateRoot, "downloads"),
    ]);
    expect(readFileSync(join(stateRoot, "config.json"), "utf8").trim()).toBe("{}");
    await session.run(request({ action: "close" }));
    expect(existsSync(stateRoot)).toBe(false);
    expect(session.isClosed).toBe(true);
    expect(session.admit(request({ action: "open", url: "http://localhost:3000" }))).toContain("closed");
  });

  it("fails a redirect to an origin the user did not approve and leaves a blank page", async () => {
    const session = browser();
    const result = await session.run(request({ action: "open", url: "http://localhost:3000/redirect" }));
    expect(result.output.isError).toBe(true);
    expect(result.output.content).toContain("http://other.test");
    expect(commands().at(-1)).toBe("open about:blank");
    expect(session.pageOrigin).toBeNull();
  });

  it("accepts refs only from the latest snapshot", async () => {
    const session = browser();
    await session.run(request({ action: "open", url: "http://localhost:3000" }));
    expect(session.admit(request({ action: "click", selector: "@e1" }))).toContain("not in the latest snapshot");
    const snap = await session.run(request({ action: "snapshot" }));
    expect(snap.output.content).toContain("untrusted page data");
    expect(session.refLabel("@e1")).toBe("button Go");
    expect(session.admit(request({ action: "click", selector: "@e1" }))).toBeNull();
    const clicked = await session.run(request({ action: "click", selector: "@e1" }));
    expect(clicked.output.isError).toBe(false);
    expect(session.admit(request({ action: "click", selector: "@e1" }))).toContain("not in the latest snapshot");
    expect(session.admit(request({ action: "click", selector: "#css" }))).toBeNull();
  });

  it("returns to the approved page when an action navigates to another origin", async () => {
    const session = browser();
    await session.run(request({ action: "open", url: "http://localhost:3000/app" }));
    const result = await session.run(request({ action: "click", selector: "#leave" }));
    expect(result.output.isError).toBe(true);
    expect(result.output.content).toContain("http://other.test");
    expect(commands().at(-1)).toBe("open http://localhost:3000/app");
  });

  it("reports a dismissed JavaScript dialog as an error", async () => {
    const session = browser();
    await session.run(request({ action: "open", url: "http://localhost:3000" }));
    const result = await session.run(request({ action: "click", selector: "#alert" }));
    expect(result.output.isError).toBe(true);
    expect(result.output.content).toContain("dialog");
  });

  it("dismisses a blocking confirm dialog instead of accepting it", async () => {
    const session = browser();
    await session.run(request({ action: "open", url: "http://localhost:3000" }));
    const result = await session.run(request({ action: "click", selector: "#confirm" }));
    expect(result.output.isError).toBe(true);
    expect(result.output.content).toContain("dismissed");
    expect(commands()).toContain("dialog dismiss");
    expect(commands()).not.toContain("dialog accept");
  });

  it("closes popups and reports them as denied", async () => {
    const session = browser();
    await session.run(request({ action: "open", url: "http://localhost:3000" }));
    const result = await session.run(request({ action: "click", selector: "#popup" }));
    expect(result.output.isError).toBe(true);
    expect(result.output.content).toContain("popups are denied");
    expect(commands()).toContain("tab close t2");
  });
});
