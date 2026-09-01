import { existsSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const resultPath = process.env.TERMINA_E2E_TEST_CORE_BUILD_RESULT;
const runRoot = process.env.TERMINA_E2E_RUN_ROOT;
const cargo = process.env.CARGO ?? "";
if (!resultPath || !runRoot) throw new Error("missing isolated core-build fixture environment");

const metadata = cargo ? spawnSync(cargo, ["metadata", "--no-deps", "--format-version", "1", "--manifest-path", join(process.cwd(), "core", "Cargo.toml")], {
  encoding: "utf8",
  env: process.env,
}) : { status: 1, stderr: "CARGO was not supplied" };
const observed = {
  pid: process.pid,
  groupId: process.pid,
  runRoot,
  home: homedir(),
  cargo,
  cargoVersion: cargo ? spawnSync(cargo, ["--version"], { encoding: "utf8", env: process.env }).stdout?.trim() ?? "" : "",
  cargoStatus: metadata.status,
  cargoStderr: metadata.stderr?.trim() ?? metadata.error?.message ?? "",
  cargoHome: process.env.CARGO_HOME,
  cargoConfigPresent: process.env.CARGO_HOME ? existsSync(join(process.env.CARGO_HOME, "config.toml")) : false,
  authPathPresent: Boolean(process.env.TERMINA_AUTH_PATH),
  sessionPathPresent: Boolean(process.env.PI_SESSION_FILE),
  apiKeyPresent: Boolean(process.env.OPENAI_API_KEY),
};
writeFileSync(resultPath, `${JSON.stringify(observed)}\n`);
if (metadata.error || metadata.status !== 0) process.exit(1);
