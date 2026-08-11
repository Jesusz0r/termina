/**
 * Build the Rust snapshot core and copy the binary next to the main bundle.
 * The core replaces the old snapshot worker thread.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Build the core in release mode and copy it to dist-electron. */
export function buildCore() {
  const cargo = process.env.CARGO ?? join(homedir(), ".cargo", "bin", "cargo");
  execFileSync(cargo, ["build", "--release", "--manifest-path", "core/Cargo.toml"], { stdio: "inherit" });
  mkdirSync("dist-electron", { recursive: true });
  copyFileSync("core/target/release/termina-core", "dist-electron/termina-core");
  chmodSync("dist-electron/termina-core", 0o755);
  console.log("✓ termina-core built");
}
