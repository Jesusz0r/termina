/**
 * Build the Rust snapshot core and copy the binary next to the main bundle.
 * The core replaces the old snapshot worker thread.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Build the core in release mode and copy it to dist-electron.
 * TERMINA_SKIP_CORE_BUILD=1 skips cargo: the binary must already exist
 * (an install script downloaded it). The app then needs no Rust toolchain.
 */
export function buildCore() {
  mkdirSync("dist-electron", { recursive: true });
  if (process.env.TERMINA_SKIP_CORE_BUILD === "1") {
    const existing = join(process.cwd(), "dist-electron", "termina-core");
    if (existsSync(existing)) {
      console.log("✓ termina-core reused (TERMINA_SKIP_CORE_BUILD)");
      return;
    }
  }
  const cargo = process.env.CARGO ?? join(homedir(), ".cargo", "bin", "cargo");
  execFileSync(cargo, ["build", "--release", "--manifest-path", "core/Cargo.toml"], { stdio: "inherit" });
  copyFileSync("core/target/release/termina-core", "dist-electron/termina-core");
  chmodSync("dist-electron/termina-core", 0o755);
  console.log("✓ termina-core built");
}
