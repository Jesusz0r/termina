import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const instance = process.env.TERMINA_E2E_TEST_INSTANCE;
const pidDir = process.env.TERMINA_E2E_TEST_PID_DIR;
const role = process.env.TERMINA_E2E_TEST_CHILD_ROLE;
if (!instance || !pidDir || !role) throw new Error("missing blocking E2E child environment");

await mkdir(pidDir, { recursive: true });
await writeFile(join(pidDir, `${instance}-${role}.json`), `${JSON.stringify({
  pid: process.pid,
  groupId: Number(process.env.TERMINA_E2E_GROUP_ID ?? process.pid),
  role,
  runRoot: process.env.TERMINA_E2E_RUN_ROOT,
})}\n`);

if (process.env.TERMINA_E2E_TEST_SPAWN_GRANDCHILD === "1" && role === "build") {
  spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    env: {
      ...process.env,
      TERMINA_E2E_TEST_CHILD_ROLE: "build-grandchild",
      TERMINA_E2E_TEST_SPAWN_GRANDCHILD: "0",
    },
    stdio: "inherit",
  });
}

const stop = async (signal) => {
  await appendFile(join(pidDir, `${instance}-${role}-signals.log`), `${signal}\n`);
  process.exit(0);
};
if (process.env.TERMINA_E2E_TEST_IGNORE_TERM !== "1") {
  process.once("SIGTERM", () => { void stop("SIGTERM"); });
}
process.once("SIGINT", () => { void stop("SIGINT"); });

setInterval(() => {}, 1_000);
