import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../../../shared/guards.ts";
import {
  DesktopSession,
  desktopArgv,
  desktopRequestLabel,
  desktopRequestNeedsActionApproval,
  desktopToolDefinition,
  parseComputerCommand,
  parseDesktopRequest,
} from "../../../agent-core/main/desktop.ts";

const FAKE_DESKTOP = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
try {
  if (process.env.HOME) fs.appendFileSync(path.join(process.env.HOME, "desktop-args.log"), JSON.stringify(args) + "\\n");
} catch {}
if (args[0] === "get") {
  process.stdout.write(JSON.stringify({ ok: false, error: { code: "PERM_DENIED", message: "no access" } }) + "\\n");
  process.exit(1);
}
if (args[0] === "snapshot") {
  process.stdout.write(JSON.stringify({ ok: true, data: { app: "Finder", snapshot_id: "s1", window: { title: "Finder" }, complete: true } }) + "\\n");
} else {
  process.stdout.write(JSON.stringify({ ok: true, data: { done: true } }) + "\\n");
}
`;

describe("desktop tool", () => {
  let root: string;
  let cwd: string;
  let home: string;
  let stateRoot: string;
  let fakeBin: string;
  const saved: Map<string, string | undefined> = new Map();

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "termina-desktop-test-"));
    cwd = join(root, "project");
    home = join(root, "home");
    stateRoot = join(root, "state");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    chmodSync(stateRoot, 0o700);
    fakeBin = join(root, "agent-desktop");
    writeFileSync(fakeBin, FAKE_DESKTOP, { mode: 0o755 });
    chmodSync(fakeBin, 0o755);
    for (const name of ["HOME", "TERMINA_AGENT_DESKTOP_BIN"]) saved.set(name, process.env[name]);
    process.env.HOME = home;
  });

  beforeEach(() => {
    process.env.HOME = home;
    const log = join(home, "desktop-args.log");
    if (existsSync(log)) rmSync(log, { force: true });
  });

  afterAll(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  function request(input: Record<string, unknown>) {
    const parsed = parseDesktopRequest(input);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.request;
  }

  function session() {
    const s = new DesktopSession({ binaryPath: fakeBin, stateRoot, cwd });
    s.enable();
    return s;
  }

  function loggedArgs(): string[][] {
    const log = join(home, "desktop-args.log");
    if (!existsSync(log)) return [];
    return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => {
      const parsed: unknown = JSON.parse(line);
      if (!Array.isArray(parsed)) throw new Error("fake desktop log is not an array");
      return parsed.map((item) => {
        if (typeof item !== "string") throw new Error("fake desktop argument is not a string");
        return item;
      });
    });
  }

  it("validates desktop requests and builds exact argv", () => {
    expect(parseDesktopRequest({ action: "snapshot" }).ok).toBe(false);
    expect(parseDesktopRequest({ action: "snapshot", app: "Finder" }).ok).toBe(true);
    expect(parseDesktopRequest({ action: "click" }).ok).toBe(false);
    expect(parseDesktopRequest({ action: "type", ref: "@s1:e1", text: "" }).ok).toBe(false);
    expect(parseDesktopRequest({ action: "set_value", ref: "@s1:e1", text: "" }).ok).toBe(true);
    expect(parseDesktopRequest({ action: "scroll", ref: "@s1:e1", direction: "down", amount: 2 }).ok).toBe(true);
    expect(parseDesktopRequest({ action: "wait", ms: 50 }).ok).toBe(true);
    expect(parseDesktopRequest({ action: "wait", ref: "@s1:e1", predicate: "value" }).ok).toBe(false);

    expect(desktopArgv(request({ action: "snapshot", app: "Finder" }))).toEqual([
      "snapshot", "--app", "Finder", "-i", "--compact",
    ]);
    expect(desktopArgv(request({ action: "click", ref: "@s1:e1" }))).toEqual(["click", "@s1:e1"]);
    expect(desktopArgv(request({ action: "type", ref: "@s1:e1", text: "hello" }))).toEqual(["type", "@s1:e1", "hello"]);
    expect(desktopArgv(request({ action: "press", key: "cmd+s", app: "Finder" }))).toEqual(["press", "cmd+s", "--app", "Finder"]);
    expect(desktopArgv(request({ action: "wait", ms: 100 }))).toEqual(["wait", "100"]);
  });

  it("parses /computer and labels the tool/actions", () => {
    expect(parseComputerCommand("/computer")).toEqual({ action: "show" });
    expect(parseComputerCommand("/computer on")).toEqual({ action: "on" });
    expect(parseComputerCommand("/computer off")).toEqual({ action: "off" });
    expect(parseComputerCommand("/computer nope")).toEqual({ error: "use /computer, /computer on, or /computer off" });
    expect(parseComputerCommand("/other")).toBeNull();
    expect(desktopRequestLabel(request({ action: "click", ref: "@s1:e1" }))).toBe("click @s1:e1");
    expect(desktopRequestNeedsActionApproval(request({ action: "snapshot", app: "Finder" }))).toBe(false);
    expect(desktopRequestNeedsActionApproval(request({ action: "click", ref: "@s1:e1" }))).toBe(true);
    const def = desktopToolDefinition();
    expect(def.name).toBe("desktop");
    if (!isRecord(def.input_schema)) throw new Error("desktop schema is not an object");
    expect(def.input_schema.required).toEqual(["action"]);
  });

  it("runs a snapshot and records its app/ref", async () => {
    const s = session();
    const result = await s.run(request({ action: "snapshot", app: "Finder" }));
    expect(result.output.isError).toBe(false);
    expect(result.output.content).toContain("desktop output");
    expect(result.data).toMatchObject({ app: "Finder", snapshot_id: "s1" });
    expect(s.appForSnapshot("s1")).toBe("Finder");
    expect(s.appForRef("@s1:e1")).toBe("Finder");
    expect(loggedArgs().at(-1)).toEqual(["snapshot", "--app", "Finder", "-i", "--compact"]);
    s.disable();
    expect(s.isEnabled).toBe(false);
    expect((await s.run(request({ action: "snapshot", app: "Finder" }))).output.isError).toBe(true);
  });

  it("formats permission errors and does not manufacture a snapshot", async () => {
    const s = session();
    const failed = await s.run(request({ action: "get", ref: "@s1:e1", property: "text" }));
    expect(failed.output.isError).toBe(true);
    expect(failed.errorCode).toBe("PERM_DENIED");
    expect(failed.output.content).toContain("Grant Accessibility");
    expect(s.appForSnapshot("s1")).toBeNull();
  });
});
