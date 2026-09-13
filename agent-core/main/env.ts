/**
 * Host environment surface: trusted PATH construction, binary resolution
 * outside the cwd jail, toolchain probes, and the `<environment>` block.
 * Pure over the process environment and filesystem; no retained state.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { IGNORED_SEGMENTS, parseGitignore, type GitignoreRules } from "../../shared/gitignore.ts";
import { freezeCwd, gitignoreSkips, sortUtf8, underRoot } from "./files.ts";

const LISTING_CAP = 20;
const PROBE_TIMEOUT_MS = 500;

function extraBinDirs(): string[] {
  const home = homedir();
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(home, ".local", "bin"),
    join(home, ".cargo", "bin"),
  ];
}

/** Add user binary directories that a GUI launch leaves off PATH. Search the process PATH first. */
export function trustedPath(pathEnv = process.env.PATH ?? "", cwdRoot?: string): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  const extra = extraBinDirs();
  const extraSet = new Set(extra);
  const root = cwdRoot ? freezeCwd(cwdRoot) : "";
  for (const dir of [...pathEnv.split(delimiter), ...extra]) {
    if (!dir || seen.has(dir)) continue;
    if (root && extraSet.has(dir)) {
      try {
        if (underRoot(realpathSync(dir), root)) continue;
      } catch {
        /* A missing extra directory stays on PATH. bash skips it. */
      }
    }
    seen.add(dir);
    parts.push(dir);
  }
  return parts.join(delimiter);
}

export function resolveTrustedBin(bin: string, cwdRoot: string): string | null {
  for (const dir of trustedPath(process.env.PATH, cwdRoot).split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    let realDir: string;
    try {
      realDir = realpathSync(dir);
    } catch {
      continue;
    }
    if (underRoot(realDir, cwdRoot)) continue;
    const cand = join(realDir, bin);
    try {
      if (statSync(cand).isFile()) return cand;
    } catch {
      continue;
    }
  }
  return null;
}

function probeAbs(absBin: string, remainingMs: number): string | null {
  if (remainingMs <= 0) return null;
  try {
    const out = execFileSync(absBin, ["--version"], {
      timeout: remainingMs,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const line = String(out).split("\n")[0]?.trim() ?? "";
    return line ? line.slice(0, 80) : null;
  } catch (err) {
    const extra = err as { stdout?: string; stderr?: string };
    const line = `${extra.stdout ?? ""}${extra.stderr ?? ""}`.split("\n")[0]?.trim() ?? "";
    return line ? line.slice(0, 80) : null;
  }
}

export function formatEnvironment(cwd: string, opts?: { probes?: boolean }): string {
  const root = freezeCwd(cwd);
  const lines = [
    `cwd: ${JSON.stringify(root)}`,
    `platform: ${JSON.stringify(process.platform)}`,
    `date: ${JSON.stringify(new Date().toISOString().slice(0, 10))}`,
  ];
  try {
    const giPath = join(root, ".gitignore");
    const listingRules: GitignoreRules = new Map();
    try {
      if (existsSync(giPath)) listingRules.set("", parseGitignore(readFileSync(giPath, "utf8")));
    } catch {
      /* listing still works without gitignore */
    }
    const names = sortUtf8(
      readdirSync(root).filter((n) => {
        if (n === "." || n === ".." || IGNORED_SEGMENTS.has(n)) return false;
        return !gitignoreSkips(listingRules, n, false) && !gitignoreSkips(listingRules, n, true);
      }),
    ).slice(0, LISTING_CAP);
    if (names.length > 0) lines.push(`listing: ${names.map((n) => JSON.stringify(n)).join(", ")}`);
  } catch {
    /* unreadable cwd */
  }
  if (opts?.probes !== false) {
    const tools: string[] = [`node ${process.version}`];
    const deadline = Date.now() + PROBE_TIMEOUT_MS;
    for (const bin of ["python3", "rustc", "go"]) {
      const abs = resolveTrustedBin(bin, root);
      if (!abs) continue;
      const ver = probeAbs(abs, deadline - Date.now());
      if (ver) tools.push(`${bin} ${ver}`);
    }
    lines.push(`toolchain: ${tools.join("; ")}`);
  }
  return `<environment>\n${lines.join("\n")}\n</environment>`;
}

export function isDirectRunFrom(selfUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  try {
    const self = selfUrl.startsWith("file:") ? fileURLToPath(selfUrl) : selfUrl;
    return realpathSync(self) === realpathSync(argv1);
  } catch {
    return false;
  }
}
