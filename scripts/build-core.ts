// @ts-nocheck
/**
 * Build the Rust snapshot core and copy the binary next to the main bundle.
 * The core replaces the old snapshot worker thread.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Check if the destination binary is newer than all core source files and manifests.
 */
function isCoreUpToDate(destination: string): boolean {
  if (!existsSync(destination)) return false;
  try {
    const destMtime = statSync(destination).mtimeMs;
    const inputs = ["core/Cargo.toml", "core/Cargo.lock", "core/src"];
    for (const input of inputs) {
      const full = join(process.cwd(), input);
      if (!existsSync(full)) continue;
      const st = statSync(full);
      if (st.mtimeMs > destMtime) return false;
      if (st.isDirectory()) {
        const entries = readdirSync(full, { recursive: true });
        for (const entry of entries) {
          const entryPath = join(full, String(entry));
          try {
            if (statSync(entryPath).mtimeMs > destMtime) return false;
          } catch {
            return false;
          }
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Publish a complete executable under a new inode.
 *
 * macOS can retain the code-signing state of an executable vnode when a
 * destination is rewritten in place. A later launch may then be killed by
 * AMFI even though the bytes and embedded signature are valid. Copying to a
 * sibling temporary directory and renaming the completed file keeps the
 * destination atomic and gives every staged build a fresh vnode.
 */
export function stageCoreBinary(source, destination) {
  const parent = dirname(destination);
  mkdirSync(parent, { recursive: true });
  const stageDir = mkdtempSync(join(parent, ".termina-core-stage-"));
  const staged = join(stageDir, "termina-core");
  try {
    copyFileSync(source, staged);
    chmodSync(staged, 0o755);
    renameSync(staged, destination);
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
}

/**
 * Build the core in release mode and copy it to dist-electron.
 * TERMINA_SKIP_CORE_BUILD=1 skips cargo only when a trusted build/release step
 * has already placed the binary. Source installs build from the checkout.
 */
export function buildCore(force = false) {
  mkdirSync("dist-electron", { recursive: true });
  const destination = join(process.cwd(), "dist-electron", "termina-core");
  if (!force) {
    if (process.env.TERMINA_SKIP_CORE_BUILD === "1") {
      if (existsSync(destination)) {
        console.log("✓ termina-core reused (TERMINA_SKIP_CORE_BUILD)");
        return;
      }
    }
    if (isCoreUpToDate(destination)) {
      console.log("✓ termina-core up to date");
      return;
    }
  }
  const cargo = process.env.CARGO ?? "cargo";
  execFileSync(cargo, ["build", "--release", "--manifest-path", "core/Cargo.toml"], { stdio: "inherit" });
  stageCoreBinary("core/target/release/termina-core", destination);
  console.log("✓ termina-core built");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  buildCore();
}
