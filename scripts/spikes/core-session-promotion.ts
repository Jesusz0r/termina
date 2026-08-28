import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SessionWriter, coreSessionFile, writeForkedSession } from "../../agent-core/session.js";
import { recoverPromotionJournals } from "../../electron/worldlines.js";

export default async function run(log: (message: string) => void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "termina-core-promotion-"));
  try {
    const source = coreSessionFile(join(root, "source"), "session");
    mkdirSync(dirname(source), { recursive: true, mode: 0o700 });
    const imageName = "session-img-1.png";
    writeFileSync(join(dirname(source), imageName), Buffer.from("image-bytes"), { mode: 0o600 });
    const opened = SessionWriter.open(source, 0);
    if (!opened.ok) throw new Error(opened.error);
    const appended = opened.writer.appendRecord({
      storageSeq: 1,
      type: "message",
      message: {
        role: "user",
        content: [{ type: "image", source: { type: "file", name: imageName, media_type: "image/png" } }],
      },
    });
    opened.writer.close();
    if (!appended.ok) throw new Error(appended.error);

    const installed = coreSessionFile(join(root, "installed"), "promoted");
    mkdirSync(dirname(dirname(dirname(installed))), { recursive: true, mode: 0o700 });
    const forked = await writeForkedSession(source, installed);
    if (!forked.ok) throw new Error(forked.error);
    const installedImage = join(dirname(installed), imageName);
    if (readFileSync(installedImage, "utf8") !== "image-bytes") throw new Error("promotion did not install the referenced image");
    log("PASS core promotion installs an image-bearing session bundle");

    const worlds = join(root, "worlds");
    const journal = join(worlds, "promotion-journal", "interrupted-core");
    mkdirSync(journal, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(journal, "journal.json"),
      JSON.stringify({
        phase: "applied",
        engine: "core",
        primaryRoot: root,
        installedSession: installed,
        paths: [],
        marker: createHash("sha256").update("recovery").digest("hex"),
      }),
      { mode: 0o600 },
    );
    await recoverPromotionJournals(worlds);
    if (existsSync(dirname(dirname(installed)))) throw new Error("recovery kept the installed core bundle");
    if (existsSync(journal)) throw new Error("recovery kept the resolved promotion journal");
    log("PASS core promotion recovery removes the complete installed bundle");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
