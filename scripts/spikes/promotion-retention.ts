import { mkdirSync, mkdtempSync, readdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorldlineManager } from "../../electron/worldlines.js";

function managerFor(worldsRoot: string): WorldlineManager {
  const manager = new WorldlineManager({ worldsRoot, primaryRoot: join(worldsRoot, "primary") } as never);
  const internal = manager as unknown as {
    comparisons: Map<string, unknown>;
    runsById: Map<string, unknown>;
  };
  internal.runsById.set("run", { startStateId: "state" });
  internal.comparisons.set("comparison", {
    engine: "pi",
    sourceRunId: "run",
    candidates: new Map([
      ["A", { state: "ready", sessionFile: join(worldsRoot, "session.jsonl"), terminalId: null, dir: join(worldsRoot, "A"), eventsDir: join(worldsRoot, "events") }],
    ]),
  });
  return manager;
}

export default async function run(log: (message: string) => void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "termina-promotion-retention-test-"));
  try {
    const worlds = join(root, "worlds");
    mkdirSync(worlds, { recursive: true });
    const journalRoot = join(worlds, "promotion-journal");
    mkdirSync(journalRoot, { recursive: true });
    for (let index = 0; index < 32; index += 1) {
      const operation = join(journalRoot, `retained-${index}`);
      mkdirSync(operation, { recursive: true });
      writeFileSync(join(operation, "journal.json"), "retained\n");
    }
    const countResult = await managerFor(worlds).promote("comparison", "A", true);
    if (countResult.ok || !/at capacity|retained\/conflicting journals/i.test(countResult.error ?? "")) {
      throw new Error(`journal-count admission was not bounded: ${JSON.stringify(countResult)}`);
    }
    if (readdirSync(journalRoot).length !== 32) throw new Error("journal admission changed retained evidence");
    log("PASS promotion admission refuses a 33rd retained journal without deleting evidence");

    rmSync(journalRoot, { recursive: true, force: true });
    mkdirSync(journalRoot, { recursive: true });
    const large = join(journalRoot, "large-retained.bin");
    writeFileSync(large, "");
    truncateSync(large, 7 * 1024 * 1024 * 1024);
    const byteResult = await managerFor(worlds).promote("comparison", "A", true);
    if (byteResult.ok || !/at capacity|retained\/conflicting journals/i.test(byteResult.error ?? "")) {
      throw new Error(`journal-byte admission was not bounded: ${JSON.stringify(byteResult)}`);
    }
    log("PASS promotion admission refuses retained evidence beyond the byte reserve");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
