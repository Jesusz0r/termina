import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SessionWriter, coreSessionFile, writeForkedSession } from "../../agent-core/session.js";
import { recoverPromotionJournals } from "../../electron/worldlines.js";

function artifactManifest(path: string) {
  const entries: Array<{ rel: string; dev: number; ino: number; state: Record<string, unknown> }> = [];
  const walk = (abs: string, rel: string) => {
    const info = lstatSync(abs);
    let state;
    if (info.isDirectory()) state = { type: "directory", mode: info.mode & 0o777 };
    else if (info.isSymbolicLink()) state = { type: "symlink", target: readlinkSync(abs) };
    else state = { type: "file", mode: info.mode & 0o777, hash: createHash("sha256").update(readFileSync(abs)).digest("hex") };
    entries.push({ rel, dev: info.dev, ino: info.ino, state });
    if (info.isDirectory()) for (const name of readdirSync(abs).sort()) walk(join(abs, name), rel === "." ? name : join(rel, name));
  };
  walk(path, ".");
  return { status: "created", path, entries };
}

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

    const installedRoot = join(root, "installed");
    mkdirSync(installedRoot, { recursive: true, mode: 0o700 });
    const installed = coreSessionFile(realpathSync(installedRoot), "core-00000000-0000-4000-8000-000000000001");
    const forked = await writeForkedSession(source, installed);
    if (!forked.ok) throw new Error(forked.error);
    const installedImage = join(dirname(installed), imageName);
    if (readFileSync(installedImage, "utf8") !== "image-bytes") throw new Error("promotion did not install the referenced image");
    log("PASS core promotion installs an image-bearing session bundle");

    const worlds = join(root, "worlds");
    const primaryRoot = join(root, "primary");
    const piRoot = join(root, "pi-sessions");
    mkdirSync(piRoot, { recursive: true });
    // Establish the worlds/primary root provenance records through the
    // canonical recovery binder before seeding a journal. Existing leaves
    // without persisted identities are intentionally not adopted.
    await recoverPromotionJournals(worlds, { primaryRoot, piSessionRoot: realpathSync(piRoot), coreSessionRoot: realpathSync(installedRoot) });
    const primaryPath = realpathSync(primaryRoot);
    const bundleDir = dirname(dirname(installed));
    const journal = join(worlds, "promotion-journal", "interrupted-core");
    mkdirSync(journal, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(journal, "journal.json"),
      JSON.stringify({
        phase: "applied",
        engine: "core",
        primaryRoot: primaryPath,
        installedSession: installed,
        installedSessionManifest: artifactManifest(bundleDir),
        paths: [],
        marker: createHash("sha256").update("recovery").digest("hex"),
      }),
      { mode: 0o600 },
    );
    await recoverPromotionJournals(worlds, { primaryRoot: primaryPath, piSessionRoot: realpathSync(piRoot), coreSessionRoot: realpathSync(join(root, "installed")) });
    if (!existsSync(dirname(dirname(installed))) || !existsSync(journal)) {
      throw new Error("recovery deleted a journal-described core session artifact");
    }
    log("PASS core promotion recovery retains the complete installed bundle and journal evidence");

    const outsideRoot = join(root, "outside-core");
    mkdirSync(outsideRoot, { recursive: true });
    const outsideInstalled = coreSessionFile(realpathSync(outsideRoot), "core-00000000-0000-4000-8000-000000000002");
    const outsideFork = await writeForkedSession(source, outsideInstalled);
    if (!outsideFork.ok) throw new Error(outsideFork.error);
    const outsideBundle = dirname(dirname(outsideInstalled));
    const outsideJournal = join(worlds, "promotion-journal", "outside-core");
    mkdirSync(outsideJournal, { recursive: true });
    writeFileSync(join(outsideJournal, "journal.json"), JSON.stringify({
      phase: "applied",
      engine: "core",
      primaryRoot: primaryPath,
      installedSession: outsideInstalled,
      installedSessionManifest: artifactManifest(outsideBundle),
      paths: [],
    }));
    await recoverPromotionJournals(worlds, { primaryRoot: primaryPath, piSessionRoot: realpathSync(piRoot), coreSessionRoot: realpathSync(installedRoot) });
    if (!existsSync(outsideBundle) || !existsSync(outsideJournal)) throw new Error("recovery removed a core bundle outside its trusted root");
    log("PASS core promotion recovery retains a valid-shaped bundle under the wrong root");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
