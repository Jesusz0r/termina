import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as worldlines from "../../electron/worldlines.js";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

function fileManifest(path: string) {
  const info = statSync(path);
  return {
    status: "created",
    path,
    entries: [{ rel: ".", dev: info.dev, ino: info.ino, state: { type: "file", mode: info.mode & 0o777, hash: hash(readFileSync(path, "utf8")) } }],
  };
}

function seed(worlds: string, primaryRoot: string, name: string, rel: string): string {
  const dir = join(worlds, "promotion-journal", name);
  const before = "before\n";
  const applied = "applied\n";
  mkdirSync(join(dir, "before"), { recursive: true, mode: 0o700 });
  writeFileSync(join(primaryRoot, rel), applied);
  writeFileSync(join(dir, "before", rel), before);
  writeFileSync(join(dir, "journal.json"), JSON.stringify({
    phase: "applying",
    primaryRoot,
    paths: [{ rel, kind: "write", beforeExists: true, beforeHash: hash(before), afterHash: hash(applied) }],
  }));
  return dir;
}

export default async function run(log: (message: string) => void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "termina-promotion-lock-"));
  try {
    const worlds = join(root, "worlds");
    const primary = join(root, "primary");
    const piSessionRoot = join(root, "pi-sessions");
    const coreSessionRoot = join(root, "core-sessions");
    mkdirSync(piSessionRoot, { recursive: true });
    mkdirSync(coreSessionRoot, { recursive: true });
    // Let the canonical recovery binder create both app-owned roots on their
    // first trusted bind and persist their leaf identities before any journal
    // fixture is materialized. An existing root without that sidecar must be
    // rejected rather than adopted as a fresh trust anchor.
    const recoveryContext = { primaryRoot: primary, piSessionRoot: realpathSync(piSessionRoot), coreSessionRoot: realpathSync(coreSessionRoot) };
    await worldlines.recoverPromotionJournals(worlds, recoveryContext);
    recoveryContext.primaryRoot = realpathSync(primary);
    const withLock = (worldlines as unknown as { withPromotionTransaction?: <T>(operation: () => Promise<T>) => Promise<T> }).withPromotionTransaction;
    if (!withLock) throw new Error("shared promotion transaction lock is missing");

    const liveDir = seed(worlds, recoveryContext.primaryRoot, "live", "live.txt");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const live = withLock(async () => {
      entered();
      await gate;
    });
    await started;
    let recovered = false;
    const recovery = worldlines.recoverPromotionJournals(worlds, recoveryContext).then(() => { recovered = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (recovered) throw new Error("recovery did not wait for the live promotion transaction");
    if (!existsSync(join(liveDir, "before", "live.txt"))) throw new Error("recovery consumed live before-images");
    if (readFileSync(join(primary, "live.txt"), "utf8") !== "applied\n") throw new Error("recovery mutated the live primary path");
    release();
    await Promise.all([live, recovery]);
    if (readFileSync(join(primary, "live.txt"), "utf8") !== "before\n" || !existsSync(liveDir)) throw new Error("queued recovery did not retain its durable evidence after release");
    log("PASS recovery waits for a live promotion transaction and retains its journal");

    const concurrentDir = seed(worlds, recoveryContext.primaryRoot, "concurrent", "concurrent.txt");
    await Promise.all([worldlines.recoverPromotionJournals(worlds, recoveryContext), worldlines.recoverPromotionJournals(worlds, recoveryContext)]);
    if (readFileSync(join(primary, "concurrent.txt"), "utf8") !== "before\n" || !existsSync(concurrentDir)) {
      throw new Error("concurrent recovery was not idempotently serialized");
    }
    log("PASS concurrent promotion recovery is serialized and idempotent");

    // A delete promotion leaves the destination absent. Recovery must restore
    // the before-image through native no-replace install, not an exchange that
    // requires a destination entry to exist.
    const deleteRollbackDir = join(worlds, "promotion-journal", "rollback-delete-path");
    mkdirSync(join(deleteRollbackDir, "before"), { recursive: true, mode: 0o700 });
    writeFileSync(join(deleteRollbackDir, "before", "deleted.txt"), "delete-before\n");
    writeFileSync(join(deleteRollbackDir, "journal.json"), JSON.stringify({
      phase: "applying",
      primaryRoot: recoveryContext.primaryRoot,
      paths: [{ rel: "deleted.txt", kind: "delete", beforeExists: true, beforeHash: hash("delete-before\n"), afterHash: hash("") }],
    }));
    await worldlines.recoverPromotionJournals(worlds, recoveryContext);
    if (readFileSync(join(primary, "deleted.txt"), "utf8") !== "delete-before\n" || !existsSync(deleteRollbackDir)) {
      throw new Error("recovery did not restore a deleted destination through native install");
    }
    log("PASS recovery restores an absent delete destination through native no-replace install");

    const leftoversDir = join(worlds, "promotion-journal", "leftovers");
    const canonicalPrimary = realpathSync(primary);
    const rollbackTemp = join(canonicalPrimary, ".termina-promotion-leftover.tmp");
    const installDir = piSessionRoot;
    const installedSession = join(installDir, "promoted.jsonl");
    const installedSessionTemp = join(installDir, ".promoted.jsonl.tmp");
    mkdirSync(leftoversDir, { recursive: true, mode: 0o700 });
    mkdirSync(installDir, { recursive: true, mode: 0o700 });
    writeFileSync(rollbackTemp, "restore temp\n");
    writeFileSync(installedSession, "installed\n");
    writeFileSync(installedSessionTemp, "install temp\n");
    const parent = statSync(canonicalPrimary);
    writeFileSync(join(leftoversDir, "journal.json"), JSON.stringify({
      phase: "applying",
      engine: "pi",
      primaryRoot: recoveryContext.primaryRoot,
      paths: [],
      installedSession,
      installedSessionTemp,
      rollbackTemps: [{ path: rollbackTemp, parent: canonicalPrimary, parentDev: parent.dev, parentIno: parent.ino }],
    }));
    await worldlines.recoverPromotionJournals(worlds, recoveryContext);
    if (!existsSync(rollbackTemp) || !existsSync(installedSession) || !existsSync(installedSessionTemp) || !existsSync(leftoversDir)) {
      throw new Error("recovery deleted unproven promotion artifacts");
    }
    log("PASS recovery retains unproven rollback and session artifacts");

    const victimDir = join(worlds, "promotion-journal", "victim");
    const victim = join(primary, "victim.txt");
    mkdirSync(victimDir, { recursive: true });
    writeFileSync(victim, "user bytes\n");
    writeFileSync(join(victimDir, "journal.json"), JSON.stringify({ phase: "applying", engine: "pi", primaryRoot: recoveryContext.primaryRoot, paths: [], installedSession: victim }));
    await worldlines.recoverPromotionJournals(worlds, recoveryContext);
    if (!existsSync(victim) || !existsSync(victimDir)) throw new Error("recovery deleted a journal-selected primary file");
    log("PASS recovery retains journal-selected session paths outside the trusted root");

    const linkedTarget = join(primary, "journal-link-target");
    const linkedEntry = join(worlds, "promotion-journal", "linked");
    mkdirSync(linkedTarget, { recursive: true });
    writeFileSync(join(linkedTarget, "journal.json"), "{bad-json");
    symlinkSync(linkedTarget, linkedEntry, "dir");
    await worldlines.recoverPromotionJournals(worlds, recoveryContext);
    if (existsSync(join(linkedTarget, "conflict.json"))) throw new Error("recovery wrote through a symlinked journal directory");
    log("PASS recovery never follows a symlinked journal entry");

    const swappedJournal = seed(worlds, recoveryContext.primaryRoot, "post-validation-swap", "post-validation-swap.txt");
    const boundSwappedJournal = realpathSync(swappedJournal);
    const swappedAway = `${swappedJournal}-held`;
    const replacementSink = join(root, "replacement-sink");
    mkdirSync(replacementSink, { recursive: true });
    writeFileSync(join(replacementSink, "journal.json"), "{replacement}");
    worldlines.setPromotionRecoveryTestHookForTest((stage, boundJournal) => {
      if (stage !== "after-journal-validation" || boundJournal !== boundSwappedJournal) return;
      renameSync(swappedJournal, swappedAway);
      symlinkSync(replacementSink, swappedJournal, "dir");
    });
    try {
      await worldlines.recoverPromotionJournals(worlds, recoveryContext);
    } finally {
      worldlines.setPromotionRecoveryTestHookForTest(null);
    }
    if (readFileSync(join(primary, "post-validation-swap.txt"), "utf8") !== "applied\n") {
      throw new Error("post-validation journal swap mutated the primary path");
    }
    if (existsSync(join(replacementSink, "conflict.json")) || existsSync(join(replacementSink, "rollback.json"))) {
      throw new Error("post-validation journal swap wrote into the replacement sink");
    }
    if (!existsSync(swappedAway) || !lstatSync(swappedJournal).isSymbolicLink()) {
      throw new Error("post-validation journal swap hook did not execute");
    }
    log("PASS post-validation journal swap cannot mutate a replacement sink or primary");

    const abaJournal = seed(worlds, recoveryContext.primaryRoot, "aba-swap-back", "aba-authentic.txt");
    const abaForged = join(worlds, "promotion-journal", "aba-forged");
    const abaHeld = `${abaJournal}-held`;
    const abaForgedHeld = `${abaForged}-held`;
    const forgedVictim = join(primary, "aba-forged-victim.txt");
    writeFileSync(forgedVictim, "forged-applied\n");
    mkdirSync(abaForged, { recursive: true });
    writeFileSync(join(abaForged, "journal.json"), JSON.stringify({
      phase: "applying",
      primaryRoot: recoveryContext.primaryRoot,
      paths: [{ rel: "aba-forged-victim.txt", kind: "delete", beforeExists: false, beforeHash: hash(""), afterHash: hash("forged-applied\n") }],
    }));
    const abaCanonical = realpathSync(abaJournal);
    worldlines.setPromotionRecoveryTestHookForTest((stage, boundJournal) => {
      if (stage !== "after-journal-validation" || boundJournal !== abaCanonical) return;
      renameSync(abaJournal, abaHeld);
      renameSync(abaForged, abaJournal);
      renameSync(abaJournal, abaForgedHeld);
      renameSync(abaHeld, abaJournal);
    });
    try {
      await worldlines.recoverPromotionJournals(worlds, recoveryContext);
    } finally {
      worldlines.setPromotionRecoveryTestHookForTest(null);
    }
    if (readFileSync(join(primary, "aba-authentic.txt"), "utf8") !== "before\n") {
      throw new Error("authentic journal was not recovered after an ABA swap-back");
    }
    if (readFileSync(forgedVictim, "utf8") !== "forged-applied\n" || !existsSync(abaJournal)) {
      throw new Error("forged ABA journal reached a primary rollback sink");
    }
    log("PASS recovery binds authentic journal bytes across an ABA swap-back");

    const outsideSessionRoot = join(root, "outside-sessions");
    mkdirSync(outsideSessionRoot, { recursive: true });
    const outsideSession = join(outsideSessionRoot, "2026-08-30T12-00-00-000Z_00000000-0000-4000-8000-000000000010.jsonl");
    writeFileSync(outsideSession, "outside\n");
    const outsideJournal = join(worlds, "promotion-journal", "outside-session");
    mkdirSync(outsideJournal, { recursive: true });
    writeFileSync(join(outsideJournal, "journal.json"), JSON.stringify({ phase: "applying", engine: "pi", primaryRoot: recoveryContext.primaryRoot, paths: [], installedSession: outsideSession, installedSessionManifest: fileManifest(outsideSession) }));

    const symlinkTarget = join(outsideSessionRoot, "symlink-target.jsonl");
    const symlinkSession = join(recoveryContext.piSessionRoot, "2026-08-30T12-00-00-000Z_00000000-0000-4000-8000-000000000011.jsonl");
    writeFileSync(symlinkTarget, "target\n");
    symlinkSync(symlinkTarget, symlinkSession);
    const symlinkJournal = join(worlds, "promotion-journal", "symlink-session");
    mkdirSync(symlinkJournal, { recursive: true });
    writeFileSync(join(symlinkJournal, "journal.json"), JSON.stringify({ phase: "applying", engine: "pi", primaryRoot: recoveryContext.primaryRoot, paths: [], installedSession: symlinkSession, installedSessionManifest: fileManifest(symlinkSession) }));

    const replacedSession = join(recoveryContext.piSessionRoot, "2026-08-30T12-00-00-000Z_00000000-0000-4000-8000-000000000012.jsonl");
    writeFileSync(replacedSession, "original\n");
    const replacedManifest = fileManifest(replacedSession);
    rmSync(replacedSession);
    writeFileSync(replacedSession, "replacement\n");
    const replacedJournal = join(worlds, "promotion-journal", "replaced-session");
    mkdirSync(replacedJournal, { recursive: true });
    writeFileSync(join(replacedJournal, "journal.json"), JSON.stringify({ phase: "applying", engine: "pi", primaryRoot: recoveryContext.primaryRoot, paths: [], installedSession: replacedSession, installedSessionManifest: replacedManifest }));

    const relativeJournal = join(worlds, "promotion-journal", "relative-session");
    mkdirSync(relativeJournal, { recursive: true });
    writeFileSync(join(relativeJournal, "journal.json"), JSON.stringify({ phase: "applying", engine: "pi", primaryRoot: recoveryContext.primaryRoot, paths: [], installedSession: "relative.jsonl", installedSessionManifest: { status: "planned", path: "relative.jsonl" } }));
    await worldlines.recoverPromotionJournals(worlds, recoveryContext);
    if (!existsSync(outsideSession) || !existsSync(symlinkSession) || readFileSync(replacedSession, "utf8") !== "replacement\n") {
      throw new Error("recovery removed an unauthorized or replaced session artifact");
    }
    if (![outsideJournal, symlinkJournal, replacedJournal, relativeJournal].every(existsSync)) throw new Error("recovery removed evidence for an unauthorized session artifact");
    log("PASS recovery retains relative, outside, symlink, and replaced session paths");

    const rollbackParent = statSync(canonicalPrimary);
    for (const replacement of ["file", "symlink", "directory", "delete-recreate"]) {
      const rollbackDir = join(worlds, "promotion-journal", `rollback-${replacement}`);
      const temp = join(canonicalPrimary, `.termina-promotion-${replacement}.tmp`);
      mkdirSync(rollbackDir, { recursive: true });
      writeFileSync(temp, "app temp\n");
      const original = lstatSync(temp);
      rmSync(temp, { force: true });
      if (replacement === "symlink") symlinkSync(outsideSession, temp);
      else if (replacement === "directory") mkdirSync(temp);
      else writeFileSync(temp, replacement === "delete-recreate" ? "app temp\n" : "replacement\n");
      writeFileSync(join(rollbackDir, "journal.json"), JSON.stringify({
        phase: "applying",
        primaryRoot: recoveryContext.primaryRoot,
        paths: [],
        rollbackTemps: [{
          status: "created",
          rel: `${replacement}.txt`,
          path: temp,
          parent: canonicalPrimary,
          parentDev: rollbackParent.dev,
          parentIno: rollbackParent.ino,
          dev: original.dev,
          ino: original.ino,
          state: { type: "file", mode: original.mode & 0o777, hash: hash("app temp\n") },
        }],
      }));
    }
    await worldlines.recoverPromotionJournals(worlds, recoveryContext);
    for (const replacement of ["file", "symlink", "directory", "delete-recreate"]) {
      const temp = join(canonicalPrimary, `.termina-promotion-${replacement}.tmp`);
      if (!existsSync(temp) || !existsSync(join(worlds, "promotion-journal", `rollback-${replacement}`))) throw new Error(`recovery removed a ${replacement} rollback-temp replacement`);
    }
    log("PASS recovery retains file, symlink, directory, and delete/recreate rollback-temp replacements");

    const plannedOccupiedDir = join(worlds, "promotion-journal", "planned-occupied");
    const plannedMissingDir = join(worlds, "promotion-journal", "planned-missing");
    const plannedOccupied = join(canonicalPrimary, ".termina-promotion-planned-occupied.tmp");
    const plannedMissing = join(canonicalPrimary, ".termina-promotion-planned-missing.tmp");
    writeFileSync(plannedOccupied, "foreign\n");
    for (const [dir, path, rel] of [[plannedOccupiedDir, plannedOccupied, "occupied.txt"], [plannedMissingDir, plannedMissing, "missing.txt"]]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "journal.json"), JSON.stringify({
        phase: "applying",
        primaryRoot: recoveryContext.primaryRoot,
        paths: [],
        rollbackTemps: [{ status: "planned", rel, path, parent: canonicalPrimary, parentDev: rollbackParent.dev, parentIno: rollbackParent.ino }],
      }));
    }
    await worldlines.recoverPromotionJournals(worlds, recoveryContext);
    if (!existsSync(plannedOccupied) || !existsSync(plannedOccupiedDir) || !existsSync(plannedMissingDir)) throw new Error("recovery deleted planned rollback-temp journal evidence");
    log("PASS planned rollback-temp crash states retain journal evidence");

    const validDir = join(worlds, "promotion-journal", "valid-retention");
    const validInstalled = join(recoveryContext.piSessionRoot, "2026-08-30T12-00-00-000Z_00000000-0000-4000-8000-000000000001.jsonl");
    const validTemp = join(recoveryContext.piSessionRoot, `.${join(validInstalled).split("/").pop()}.tmp`);
    const validRollback = join(canonicalPrimary, ".termina-promotion-valid.tmp");
    mkdirSync(validDir, { recursive: true });
    writeFileSync(validInstalled, "installed\n");
    writeFileSync(validTemp, "temp\n");
    writeFileSync(validRollback, "rollback\n");
    const validParent = statSync(canonicalPrimary);
    const validRollbackInfo = statSync(validRollback);
    writeFileSync(join(validDir, "journal.json"), JSON.stringify({
      phase: "applying",
      engine: "pi",
      primaryRoot: recoveryContext.primaryRoot,
      paths: [],
      installedSession: validInstalled,
      installedSessionTemp: validTemp,
      installedSessionManifest: fileManifest(validInstalled),
      installedSessionTempManifest: fileManifest(validTemp),
      rollbackTemps: [{
        status: "created",
        rel: "valid.txt",
        path: validRollback,
        parent: canonicalPrimary,
        parentDev: validParent.dev,
        parentIno: validParent.ino,
        dev: validRollbackInfo.dev,
        ino: validRollbackInfo.ino,
        state: { type: "file", mode: validRollbackInfo.mode & 0o777, hash: hash("rollback\n") },
      }],
    }));
    await worldlines.recoverPromotionJournals(worlds, recoveryContext);
    if (!existsSync(validInstalled) || !existsSync(validTemp) || !existsSync(validRollback) || !existsSync(validDir)) {
      throw new Error("recovery deleted a journal-described session or temp artifact");
    }
    log("PASS recovery never treats a complete journal manifest as deletion provenance");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
