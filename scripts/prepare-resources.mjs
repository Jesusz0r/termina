/**
 * Prepare the packaged resources: the node runtime and the core binary.
 *
 * The bundle ships its own node because pi's cli.js starts with a node
 * shebang and pi spawns node itself. The node version must satisfy pi's
 * engines (>= 22.19). The core binary comes from the release build or the
 * local cargo build.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { platform } from "node:os";
import { buildCore } from "./build-core.mjs";

const RESOURCES = join(process.cwd(), "resources");
const NODE_MAJOR = 22;

function osArch() {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const os = platform() === "darwin" ? "darwin" : platform() === "win32" ? "win" : "linux";
  return `${os}-${arch}`;
}

/** The newest node 22.x LTS release. */
async function latestNode22() {
  const res = await fetch("https://nodejs.org/dist/index.json");
  if (!res.ok) throw new Error(`node index fetch failed: ${res.status}`);
  const releases = await res.json();
  const release = releases.find((r) => r.version.startsWith(`v${NODE_MAJOR}.`) && r.lts !== false);
  if (!release) throw new Error(`no node ${NODE_MAJOR} LTS release found`);
  const kind = process.platform === "win32" ? "zip" : "tar.gz";
  return { version: release.version, url: `https://nodejs.org/dist/${release.version}/node-${release.version}-${osArch()}.${kind}` };
}

/** Download and extract the node runtime into resources/node. */
async function prepareNode() {
  const nodeBin = join(RESOURCES, "node", "bin", "node");
  if (existsSync(nodeBin)) {
    try {
      const version = execFileSync(nodeBin, ["--version"], { encoding: "utf8" }).trim();
      // Reuse only when the staged runtime meets pi's engine floor. An old
      // 22.x would ship and break pi's startup.
      const match = /^v(\d+)\.(\d+)\./.exec(version);
      if (match && (Number(match[1]) > 22 || (Number(match[1]) === 22 && Number(match[2]) >= 19))) {
        console.log(`✓ node reused (${version})`);
        return;
      }
    } catch {
      /* the binary is broken — redownload */
    }
  }
  const { version, url } = await latestNode22();
  console.log(`↓ node ${version} (${osArch()})`);
  mkdirSync(RESOURCES, { recursive: true });
  const archive = join(RESOURCES, `node-${version}.${process.platform === "win32" ? "zip" : "tar.gz"}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`node download failed: ${res.status}`);
  writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  rmSync(join(RESOURCES, "node"), { recursive: true, force: true });
  execFileSync("tar", ["-xf", archive, "-C", RESOURCES], { stdio: "inherit" });
  renameSync(join(RESOURCES, `node-${version}-${osArch()}`), join(RESOURCES, "node"));
  rmSync(archive, { force: true });
  chmodSync(nodeBin, 0o755);
  console.log(`✓ node ${version} staged`);
}

/** Copy the release core binary into resources/termina-core. */
function prepareCore() {
  if (process.env.TERMINA_SKIP_CORE_BUILD !== "1") buildCore();
  mkdirSync(RESOURCES, { recursive: true });
  copyFileSync(join(process.cwd(), "dist-electron", "termina-core"), join(RESOURCES, "termina-core"));
  chmodSync(join(RESOURCES, "termina-core"), 0o755);
  console.log("✓ termina-core staged");
}

await prepareNode();
prepareCore();
console.log(`resources ready in ${RESOURCES}`);
