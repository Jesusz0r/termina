/** Run the CoreClient read-budget regression against the built release core. */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const builtCoreCandidates = [resolve("core/target/release/termina-core"), resolve("dist-electron/termina-core")];
const coreBin = process.env.TERMINA_CORE_BIN ?? builtCoreCandidates.find((candidate) => existsSync(candidate)) ?? builtCoreCandidates[0];
if (!existsSync(coreBin)) {
  console.error(`CoreClient read-budget gate needs a built core binary: ${coreBin}`);
  process.exit(2);
}

const result = spawnSync(
  process.execPath,
  ["--experimental-strip-types", "--no-warnings", resolve("scripts/core-client-read-budget-test.mjs")],
  {
    cwd: process.cwd(),
    env: { ...process.env, TERMINA_CORE_BIN: coreBin },
    stdio: "inherit",
  },
);

if (result.error) {
  console.error(`CoreClient read-budget gate failed to start: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? (result.signal ? 1 : 0));
