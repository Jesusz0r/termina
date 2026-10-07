import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface VerifyStage {
  args: string[];
  event: string;
  cwd: string;
  secret: string | null;
  hostSession: string | null;
}

/** An offline npm package whose test runner exists only in its local .bin. */
export async function writeVerifyPackage(root: string, scripts: Record<string, string>): Promise<void> {
  await mkdir(join(root, "node_modules", ".bin"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "verify-fixture", version: "1.0.0", scripts }));
  await writeFile(join(root, ".npmrc"), "update-notifier=false\nignore-scripts=false\n");
  await writeFile(join(root, "node_modules", ".bin", "termina-verify-fixture"), `#!/usr/bin/env node
const fs = require("node:fs");
const stage = JSON.stringify({
  args: process.argv.slice(2), event: process.env.npm_lifecycle_event,
  cwd: process.cwd(), secret: process.env.ANTHROPIC_API_KEY ?? null,
  hostSession: process.env.PI_SESSION_FILE ?? null,
});
fs.appendFileSync("stages.jsonl", stage + "\\n");
console.log(stage);
if (process.argv[2] === "fail") process.exit(7);
`, { mode: 0o755 });
}

export async function readVerifyStages(root: string): Promise<VerifyStage[]> {
  return (await readFile(join(root, "stages.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
}
