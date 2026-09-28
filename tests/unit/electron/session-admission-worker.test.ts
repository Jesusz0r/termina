import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { coreSessionFile, SessionWriter } from "../../../agent-core/session.ts";
import { acquireSessionRetentionLock, releaseSessionRetentionLock } from "../../../shared/session-retention-lock.ts";
import type { SessionForkClient } from "../../../electron/session-fork.ts";

describe("session admission worker", () => {
  let work: string;
  let client: SessionForkClient;

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), "termina-session-admission-worker-"));
    await Promise.all([
      build({
        entryPoints: ["electron/session-fork.ts"], bundle: true, platform: "node", format: "esm",
        target: "node22", outfile: join(work, "session-fork.mjs"), logLevel: "silent",
      }),
      build({
        entryPoints: ["electron/session-worker.ts"], bundle: true, platform: "node", format: "esm",
        target: "node22", outfile: join(work, "session-worker.mjs"), logLevel: "silent",
        banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
      }),
    ]);
    const module = await import(pathToFileURL(join(work, "session-fork.mjs")).href);
    client = new module.SessionForkClient();
  });

  afterAll(async () => {
    await client?.dispose();
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it("creates the admission parent and publishes an empty bundle in the worker", async () => {
    const path = coreSessionFile(join(work, "new-root", "project"), "admitted");
    expect(await client.admitCoreSession(path)).toMatchObject({ ok: true });
    expect(readFileSync(path, "utf8")).toBe("");
    expect(await client.admitCoreSession(path)).toMatchObject({ ok: true });
  });

  it("rejects invalid paths before creating their parents", async () => {
    const parent = join(work, "invalid-parent");
    for (const path of ["", "relative/project/session/current/session.jsonl", join(parent, "not-a-bundle.jsonl"), `${parent}/session/current/session.jsonl\0`, null, 42]) {
      expect(await client.admitCoreSession(path as string)).toMatchObject({ ok: false, error: expect.any(String) });
    }
    expect(existsSync(parent)).toBe(false);
  });

  it("never publishes or creates directories for a pre-aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    const parent = join(work, "pre-aborted-root");
    await expect(client.admitCoreSession(coreSessionFile(join(parent, "project"), "aborted"), { signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(existsSync(parent)).toBe(false);
  });

  it("retains cancellation before worker dispatch and while another admission waits", async () => {
    const root = join(work, "queued-cancellation");
    mkdirSync(root);
    const lease = acquireSessionRetentionLock(root);
    const firstController = new AbortController();
    const secondController = new AbortController();
    const firstPath = coreSessionFile(join(root, "project"), "first");
    const secondPath = coreSessionFile(join(root, "project"), "second");
    const first = client.admitCoreSession(firstPath, { signal: firstController.signal });
    const second = client.admitCoreSession(secondPath, { signal: secondController.signal });
    const firstRejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
    const secondRejected = expect(second).rejects.toMatchObject({ name: "AbortError" });
    secondController.abort();
    try {
      await secondRejected;
      expect(existsSync(secondPath)).toBe(false);
      firstController.abort();
      await firstRejected;
    } finally {
      firstController.abort();
      releaseSessionRetentionLock(lease);
    }
    expect(existsSync(firstPath)).toBe(false);
    expect(existsSync(secondPath)).toBe(false);
  });

  it("keeps the main loop responsive and cancels admission while the retention lease is held", async () => {
    const root = join(work, "contention");
    mkdirSync(root);
    const lease = acquireSessionRetentionLock(root);
    const path = coreSessionFile(join(root, "project"), "cancelled");
    const controller = new AbortController();
    const admission = client.admitCoreSession(path, { signal: controller.signal });
    const rejected = expect(admission).rejects.toMatchObject({ name: "AbortError" });
    try {
      await delay(100);
      expect(existsSync(path)).toBe(false);
      controller.abort();
      await rejected;
      expect(existsSync(path)).toBe(false);
    } finally {
      controller.abort();
      releaseSessionRetentionLock(lease);
    }
    expect(await client.admitCoreSession(path)).toMatchObject({ ok: true });
  });

  it("allows a lease-backed fork to finish while admission waits for that lease", async () => {
    const root = join(work, "fork-contention");
    mkdirSync(root);
    const source = coreSessionFile(join(root, "source-project"), "source");
    const opened = SessionWriter.open(source, 0);
    if (!opened.ok) throw new Error(opened.error);
    opened.writer.close();
    const destination = coreSessionFile(root, "fork");
    const admissionPath = coreSessionFile(join(root, "admission-project"), "waiting");
    const lease = acquireSessionRetentionLock(root);
    const controller = new AbortController();
    const admission = client.admitCoreSession(admissionPath, { signal: controller.signal });
    // Attach a rejection handler before cleanup can cancel this request.
    const settledAdmission = admission.then((result) => result, (error: unknown) => { throw error; });
    void settledAdmission.catch(() => undefined);
    try {
      await delay(100);
      expect(existsSync(admissionPath)).toBe(false);
      const fork = await client.forkCore({ sourceSessionFile: source, destinationSessionFile: destination, retentionLease: lease });
      expect(fork.ok).toBe(true);
      expect(existsSync(admissionPath)).toBe(false);
    } catch (error) {
      controller.abort();
      throw error;
    } finally {
      releaseSessionRetentionLock(lease);
    }
    expect(await settledAdmission).toMatchObject({ ok: true });
  });
});
