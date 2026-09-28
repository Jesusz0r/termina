import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { admitSessionBundle, coreSessionFile, SessionWriter, replaySessionBundle, MAX_RETAINED_EMPTY_SESSION_BUNDLES } from "../../../agent-core/session.ts";
import { acquireSessionRetentionLock, releaseSessionRetentionLock, acquireSessionRetentionLockAsync } from "../../../shared/session-retention-lock.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "session-admission-"));
  roots.push(root);
  const project = join(root, "project");
  mkdirSync(project);
  return { root, project };
}

it("admits concurrent new sessions after a live owner releases the shared lock", async () => {
  const { root, project } = fixture();
  const lock = acquireSessionRetentionLock(root);
  const paths = Array.from({ length: 3 }, () => coreSessionFile(project, `core-${randomUUID()}`));
  const pending = paths.map((path) => admitSessionBundle(path));
  expect(paths.every((path) => !existsSync(path))).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 60));
  releaseSessionRetentionLock(lock);
  expect(await Promise.all(pending)).toEqual(paths.map(() => expect.objectContaining({ ok: true })));
  for (const path of paths) {
    const writer = SessionWriter.open(path, 0);
    expect(writer.ok).toBe(true);
    if (writer.ok) writer.writer.close();
    expect((await replaySessionBundle(path)).ok).toBe(true);
  }
});

it("admits only the last available slot and preserves existing session bytes", async () => {
  const { project } = fixture();
  for (let i = 0; i < MAX_RETAINED_EMPTY_SESSION_BUNDLES - 1; i++) {
    const path = coreSessionFile(project, `core-empty-${i}`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
  }
  const existing = coreSessionFile(project, "core-existing");
  mkdirSync(dirname(existing), { recursive: true });
  const record = JSON.stringify({ storageSeq: 1, type: "message", message: { role: "user", content: "keep me" } }) + "\n";
  writeFileSync(existing, record);
  const paths = Array.from({ length: 3 }, () => coreSessionFile(project, `core-${randomUUID()}`));
  const results = await Promise.all(paths.map((path) => admitSessionBundle(path)));
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  for (const result of results.filter((result) => !result.ok)) {
    expect(result.error).toContain("retained empty session");
  }
  expect(paths.filter((path) => existsSync(path))).toHaveLength(1);
  expect(readFileSync(existing, "utf8")).toBe(record);
  expect((await replaySessionBundle(existing)).ok).toBe(true);
});

it("can cancel a waiter without releasing another owner's lock or creating a session", async () => {
  const { root, project } = fixture();
  const lock = acquireSessionRetentionLock(root);
  const abort = new AbortController();
  const path = coreSessionFile(project, `core-${randomUUID()}`);
  const waiting = admitSessionBundle(path, abort.signal);
  abort.abort();
  expect((await waiting).ok).toBe(false);
  expect(existsSync(dirname(path))).toBe(false);
  expect(() => acquireSessionRetentionLock(root)).toThrow("busy");
  releaseSessionRetentionLock(lock);
  expect((await admitSessionBundle(path)).ok).toBe(true);
});

it("cancels after immediate acquisition without publishing an empty bundle", async () => {
  const { root, project } = fixture();
  const abort = new AbortController();
  const path = coreSessionFile(project, `core-${randomUUID()}`);
  const pending = admitSessionBundle(path, abort.signal);
  // Async acquisition has acquired the lock but has not resumed publication.
  abort.abort();
  expect((await pending).ok).toBe(false);
  expect(existsSync(dirname(path))).toBe(false);
  const lock = acquireSessionRetentionLock(root);
  releaseSessionRetentionLock(lock);
});

it("does not acquire a free lock when already aborted", async () => {
  const { root } = fixture();
  const abort = new AbortController();
  abort.abort();
  await expect(acquireSessionRetentionLockAsync(root, abort.signal)).rejects.toThrow();
  const lock = acquireSessionRetentionLock(root);
  releaseSessionRetentionLock(lock);
});

it("recovers a proven dead owner through the async waiter", async () => {
  const { root } = fixture();
  const stale = acquireSessionRetentionLock(root);
  const pid = 2_147_483_647;
  writeFileSync(stale.ownerPath, JSON.stringify({ ...stale.owner, pid }));
  const kill = vi.spyOn(process, "kill").mockImplementation((ownerPid) => {
    expect(ownerPid).toBe(pid);
    throw Object.assign(new Error("no such process"), { code: "ESRCH" });
  });
  try {
    const acquired = await acquireSessionRetentionLockAsync(root);
    expect(acquired.owner.token).not.toBe(stale.owner.token);
    expect(existsSync(stale.ownerPath)).toBe(false);
    releaseSessionRetentionLock(stale);
    expect(existsSync(acquired.ownerPath)).toBe(true);
    releaseSessionRetentionLock(acquired);
  } finally {
    kill.mockRestore();
  }
});

it("preserves an owner whose liveness check is denied while waiting for cancellation", async () => {
  const { root } = fixture();
  const lock = acquireSessionRetentionLock(root);
  writeFileSync(lock.ownerPath, JSON.stringify({ ...lock.owner, pid: 2_147_483_647 }));
  const ownerBytes = readFileSync(lock.ownerPath);
  const kill = vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("permission denied"), { code: "EPERM" });
  });
  const abort = new AbortController();
  try {
    const waiting = acquireSessionRetentionLockAsync(root, abort.signal);
    const rejected = expect(waiting).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 60));
    abort.abort();
    await rejected;
    expect(kill).toHaveBeenCalled();
    expect(readFileSync(lock.ownerPath)).toEqual(ownerBytes);
    expect(existsSync(lock.guardPath)).toBe(true);
  } finally {
    abort.abort();
    kill.mockRestore();
  }
});

it.each([
  { reason: "live-owner", message: "retained session root is busy" },
  { reason: "unreadable", message: "retained session admission lock is unreadable" },
])("reports the $reason wait reason separately from its diagnostic", ({ reason, message }) => {
  const { root } = fixture();
  const lock = acquireSessionRetentionLock(root);
  if (reason === "unreadable") rmSync(lock.ownerPath);
  expect(() => acquireSessionRetentionLock(root)).toThrowError(expect.objectContaining({ reason, message }));
  expect(existsSync(lock.path)).toBe(true);
  expect(existsSync(lock.guardPath)).toBe(true);
});

it("waits out a live owner instead of failing at five seconds", async () => {
  const { root } = fixture();
  const lock = acquireSessionRetentionLock(root);
  const pending = acquireSessionRetentionLockAsync(root);
  await new Promise((resolve) => setTimeout(resolve, 6_000));
  releaseSessionRetentionLock(lock);
  const acquired = await pending;
  releaseSessionRetentionLock(acquired);
}, 15_000);

it("bounds waiting for corrupt locks and never deletes them", async () => {
  const { root } = fixture();
  const lock = acquireSessionRetentionLock(root);
  rmSync(lock.ownerPath);
  await expect(acquireSessionRetentionLockAsync(root)).rejects.toThrow("unreadable");
  expect(existsSync(lock.path)).toBe(true);
}, 10_000);

it.each([
  { unreadable: false, deadline: 12_000, message: "busy" },
  { unreadable: true, deadline: 5_000, message: "unreadable" },
])("does not acquire after the $deadline ms deadline when a delayed retry finds the lock free", async ({ unreadable, deadline, message }) => {
  const { root } = fixture();
  const lock = acquireSessionRetentionLock(root);
  const ownerBytes = readFileSync(lock.ownerPath);
  if (unreadable) rmSync(lock.ownerPath);
  let now = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  try {
    const pending = acquireSessionRetentionLockAsync(root);
    const rejected = expect(pending).rejects.toThrow(message);
    now = deadline + 1;
    if (unreadable) writeFileSync(lock.ownerPath, ownerBytes);
    releaseSessionRetentionLock(lock);
    await rejected;
    expect(existsSync(lock.path)).toBe(false);
  } finally {
    clock.mockRestore();
  }
});

it("coordinates independent child processes against the same admission root", async () => {
  const { root, project } = fixture();
  const lock = acquireSessionRetentionLock(root);
  const moduleUrl = new URL("../../../agent-core/session.ts", import.meta.url).href;
  const children: ChildProcess[] = [];
  const exits: Promise<unknown>[] = [];
  try {
    const paths = Array.from({ length: 3 }, () => coreSessionFile(project, `core-${randomUUID()}`));
    const ready = paths.map((path) => {
      const code = `import { admitSessionBundle } from ${JSON.stringify(moduleUrl)};\nprocess.stdout.write('ready\\n');\nconst result = await admitSessionBundle(${JSON.stringify(path)});\nif (!result.ok) { console.error(result.error); process.exitCode = 1; }`;
      const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
      children.push(child);
      let stderr = "";
      child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
      exits.push(once(child, "exit").then(([code]) => expect({ code, stderr }).toEqual({ code: 0, stderr: "" })));
      return once(child.stdout!, "data");
    });
    await Promise.all(ready);
    releaseSessionRetentionLock(lock);
    await Promise.all(exits);
    expect(paths.every((path) => existsSync(path))).toBe(true);
  } finally {
    releaseSessionRetentionLock(lock);
    await Promise.all(children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = once(child, "exit");
      child.kill();
      await closed;
    }));
  }
}, 15_000);
