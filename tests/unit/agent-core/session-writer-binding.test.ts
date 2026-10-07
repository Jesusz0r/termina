import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coreSessionFile, replaySessionBundle, SessionWriter } from "../../../agent-core/session.ts";

const record = (storageSeq: number, content: string) => ({ storageSeq, type: "message", message: { role: "user", content } });

it("rolls back its own descriptor if the session address is replaced at the fsync boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "termina-writer-postsync-"));
  const file = coreSessionFile(root, "binding-fixture");
  const moduleUrl = new URL("../../../agent-core/session.ts", import.meta.url).href;
  const script = `
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const { SessionWriter } = await import(${JSON.stringify(moduleUrl)});
const file = ${JSON.stringify(file)};
const opened = SessionWriter.open(file, 0);
assert.equal(opened.ok, true);
const writer = opened.writer;
assert.equal(writer.appendRecord(${JSON.stringify(record(1, "durable prefix"))}).ok, true);
const prefix = fs.readFileSync(file, "utf8");
const identity = fs.statSync(file);
const original = fs.fsyncSync;
let rebound = false;
fs.fsyncSync = (fd) => {
  original(fd);
  const info = fs.fstatSync(fd);
  if (!rebound && info.dev === identity.dev && info.ino === identity.ino) {
    rebound = true;
    fs.renameSync(file, file + ".held");
    fs.writeFileSync(file, "competitor content\\n");
  }
};
syncBuiltinESMExports();
const result = writer.appendRecord(${JSON.stringify(record(2, "must not be acknowledged"))});
assert.deepEqual(result, { ok: false, error: "session segment changed: session.jsonl" });
assert.equal(rebound, true);
assert.equal(fs.readFileSync(file + ".held", "utf8"), prefix);
assert.equal(fs.readFileSync(file, "utf8"), "competitor content\\n");
assert.equal(writer.appendRecord(${JSON.stringify(record(2, "must remain blocked"))}).ok, false);
writer.close();
`;
  try {
    const child = spawnSync(process.execPath, ["--input-type=module", "--experimental-strip-types", "--no-warnings", "-e", script], { cwd: root, encoding: "utf8", timeout: 5000 });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const replacement of ["file", "symlink"] as const) {
  describe(`session writer active ${replacement} replacement`, () => {
    it("does not acknowledge an append to an obsolete descriptor or mutate the replacement", async () => {
      const root = mkdtempSync(join(tmpdir(), "termina-writer-binding-"));
      const file = coreSessionFile(root, "binding-fixture");
      const opened = SessionWriter.open(file, 0);
      if (!opened.ok) throw new Error(opened.error);
      const writer = opened.writer;
      const held = `${file}.held`;
      const target = join(root, "replacement.txt");
      try {
        expect(writer.appendRecord(record(1, "durable prefix"))).toEqual({ ok: true, storageSeq: 1 });
        const prefix = readFileSync(file, "utf8");
        renameSync(file, held);
        writeFileSync(target, "competitor content\n");
        if (replacement === "symlink") symlinkSync(target, file);
        else writeFileSync(file, "competitor content\n");
        const result = writer.appendRecord(record(2, "must not be acknowledged"));
        expect(result).toEqual({ ok: false, error: "session segment changed: session.jsonl" });
        expect(readFileSync(held, "utf8")).toBe(prefix);
        expect(readFileSync(file, "utf8")).toBe("competitor content\n");
        expect(readFileSync(target, "utf8")).toBe("competitor content\n");
        expect(writer.appendRecord(record(2, "must remain blocked"))).toMatchObject({ ok: false, error: "session writer is poisoned after an append failure" });
        unlinkSync(file);
        renameSync(held, file);
        writer.close();
        const recovered = SessionWriter.open(file, 1);
        if (!recovered.ok) throw new Error(recovered.error);
        try {
          expect(recovered.writer.appendRecord(record(2, "explicit recovery"))).toEqual({ ok: true, storageSeq: 2 });
        } finally {
          recovered.writer.close();
        }
        const replay = await replaySessionBundle(file);
        expect(replay).toMatchObject({ ok: true, maxSeq: 2 });
        if (!replay.ok) throw new Error(replay.error);
        expect(replay.messages.map((message) => message.content)).toEqual(["durable prefix", "explicit recovery"]);
      } finally {
        writer.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
}
