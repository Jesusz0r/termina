import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acknowledgePendingImages, appendPendingImages, claimPendingImages, pendingImageState } from "../../../agent-core/host.ts";
import { createPromptImagePreparer } from "../../../agent-core/main/prompt-images.ts";

const roots: string[] = [];
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "termina-prompt-images-"));
  roots.push(root);
  const bytes = Buffer.from("image fixture bytes");
  const appended = await appendPendingImages(root, "term-1", [{ id: "first", mediaType: "image/png", bytes }]);
  if (!appended.ok) throw new Error(appended.error);
  return { root, bytes, pending: join(root, appended.names[0]!), sessionFile: join(root, "session", "current", "session.jsonl") };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("shared prompt image preparation", () => {
  it("retains the claim until the caller appends its user message and acknowledges", async () => {
    const { root, bytes, pending, sessionFile } = await fixture();
    const prepared = await createPromptImagePreparer(sessionFile, root, "term-1")();
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.images).toHaveLength(1);
    const image = join(root, "session", "current", prepared.images[0]!.name);
    expect(readFileSync(image)).toEqual(bytes);
    expect(existsSync(pending)).toBe(true);
    expect(await pendingImageState(root, "term-1")).toMatchObject({ count: 1 });
    writeFileSync(sessionFile, JSON.stringify({ role: "user", images: prepared.images }) + "\n");
    expect(await prepared.acknowledge()).toEqual({ ok: true });
    expect(existsSync(pending)).toBe(false);
    expect(readFileSync(image)).toEqual(bytes);
    expect(await pendingImageState(root, "term-1")).toMatchObject({ count: 0 });
  });

  it("keeps an unsuccessful copy recoverable for the next delivery", async () => {
    const { root, pending, sessionFile } = await fixture();
    const blocked = join(root, "blocked");
    writeFileSync(blocked, "not a directory");
    expect(await createPromptImagePreparer(join(blocked, "session.jsonl"), root, "term-1")()).toMatchObject({ ok: false });
    expect(existsSync(pending)).toBe(true);
    expect(await pendingImageState(root, "term-1")).toMatchObject({ count: 1 });
    const retry = await createPromptImagePreparer(sessionFile, root, "term-1")();
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.images).toHaveLength(1);
  });

  it("gives the pending batch priority over startup extras at the four-image cap", async () => {
    const { root, bytes, sessionFile } = await fixture();
    expect(await appendPendingImages(root, "term-1", ["second", "third", "fourth"].map(id => ({ id, mediaType: "image/png" as const, bytes }))))
      .toMatchObject({ ok: true });
    const extraName = "image-term-1-extra.png";
    writeFileSync(join(root, extraName), bytes);
    const prepared = await createPromptImagePreparer(sessionFile, root, "term-1")([{ name: extraName, mediaType: "image/png" }]);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.images).toHaveLength(4);
    expect(prepared.dropped).toBe(1);
    expect(await pendingImageState(root, "term-1")).toMatchObject({ count: 4 });
    expect(await prepared.acknowledge()).toEqual({ ok: true });
    expect(await pendingImageState(root, "term-1")).toMatchObject({ count: 0 });
    expect(existsSync(join(root, extraName))).toBe(true);
  });

  it("retries a committed claim's failed acknowledgement without delivering its images twice", async () => {
    const { root, pending, sessionFile } = await fixture();
    const prepare = createPromptImagePreparer(sessionFile, root, "term-1");
    const first = await prepare();
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    writeFileSync(sessionFile, JSON.stringify({ role: "user", content: "first", images: first.images }) + "\n");
    const lock = join(root, "images-term-1.lock");
    writeFileSync(lock, "invalid lock record");
    expect(await first.acknowledge()).toMatchObject({ ok: false });
    expect(await prepare()).toMatchObject({ ok: false });
    expect(existsSync(pending)).toBe(true);
    rmSync(lock);
    const next = await prepare();
    expect(next).toMatchObject({ ok: true, images: [] });
    expect(existsSync(pending)).toBe(false);
    expect(await pendingImageState(root, "term-1")).toMatchObject({ count: 0 });
    expect(readFileSync(sessionFile, "utf8").split("\n").filter(Boolean)).toHaveLength(1);
  });

  it("acknowledges an already removed claim idempotently", async () => {
    const { root } = await fixture();
    const claimed = await claimPendingImages(root, "term-1");
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    const { claimId, images } = claimed.claim;
    const names = images.map(image => image.name);
    expect(await acknowledgePendingImages(root, "term-1", claimId, names)).toEqual({ ok: true });
    expect(await acknowledgePendingImages(root, "term-1", claimId, names)).toEqual({ ok: true });
  });

  it("never removes the source when no session storage is available", async () => {
    const { root, pending } = await fixture();
    const prepare = createPromptImagePreparer(null, root, "term-1");
    expect(await prepare()).toMatchObject({ ok: false, error: "pending images require session storage" });
    expect(await prepare()).toMatchObject({ ok: false });
    expect(existsSync(pending)).toBe(true);
    expect(await pendingImageState(root, "term-1")).toMatchObject({ count: 1 });
  });
});
