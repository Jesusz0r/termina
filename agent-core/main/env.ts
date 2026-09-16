/**
 * Host environment surface: trusted PATH construction, binary resolution
 * outside the cwd jail, toolchain probes, and the `<environment>` block.
 * Pure over the process environment and filesystem; no retained state.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { IGNORED_SEGMENTS, parseGitignore, type GitignoreRules } from "../../shared/gitignore.ts";
import { freezeCwd, gitignoreSkips, readIgnoreFile, sortUtf8, underRoot } from "./files.ts";

const LISTING_CAP = 20;
const PROBE_TIMEOUT_MS = 500;

/** Well-known root markers. Names only, fixed order, omit missing. */
const ROOT_MANIFESTS = [
  "package.json",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "Gemfile",
] as const;

const TOOLCHAIN_BINS = ["python3", "rustc", "go", "gcc", "javac", "clang", "npm", "pnpm"] as const;

function extraBinDirs(): string[] {
  const home = homedir();
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(home, ".local", "bin"),
    join(home, ".cargo", "bin"),
  ];
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
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
  const root = freezeCwd(cwdRoot);
  for (const dir of trustedPath(process.env.PATH, cwdRoot).split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    let realDir: string;
    try {
      realDir = realpathSync(dir);
    } catch {
      continue;
    }
    if (underRoot(realDir, root)) continue;
    const cand = join(realDir, bin);
    try {
      if (!statSync(cand).isFile()) continue;
    } catch {
      continue;
    }
    const realCand = realpathOrNull(cand);
    // Skip bins we cannot canonicalize, and bins whose real path is inside cwd.
    if (realCand === null || underRoot(realCand, root)) continue;
    return cand;
  }
  return null;
}

function probeArgv(bin: string): string[] {
  return bin === "go" ? ["version"] : ["--version"];
}

function firstProbeLine(text: string): string {
  return text.split("\n")[0]?.trim() ?? "";
}

function probeAbs(absBin: string, argv: string[], remainingMs: number): string | null {
  if (remainingMs <= 0) return null;
  const result = spawnSync(absBin, argv, {
    timeout: remainingMs,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) return null;
  const line = (
    firstProbeLine(String(result.stdout ?? "")) || firstProbeLine(String(result.stderr ?? ""))
  ).slice(0, 80);
  return line || null;
}

function listRootManifests(root: string): string[] {
  const found: string[] = [];
  for (const name of ROOT_MANIFESTS) {
    try {
      if (statSync(join(root, name)).isFile()) found.push(name);
    } catch {
      /* missing or unreadable */
    }
  }
  return found;
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
      const text = readIgnoreFile(giPath);
      if (text !== null) listingRules.set("", parseGitignore(text));
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
  const manifests = listRootManifests(root);
  if (manifests.length > 0) {
    lines.push(`manifests: ${manifests.map((n) => JSON.stringify(n)).join(", ")}`);
  }
  if (opts?.probes !== false) {
    const tools: string[] = [`node ${process.version}`];
    const deadline = Date.now() + PROBE_TIMEOUT_MS;
    for (const bin of TOOLCHAIN_BINS) {
      const abs = resolveTrustedBin(bin, root);
      if (!abs) continue;
      const ver = probeAbs(abs, probeArgv(bin), deadline - Date.now());
      tools.push(ver ? `${bin} ${ver}` : bin);
    }
    lines.push(`toolchain: ${tools.join("; ")}`);
  }
  return `<environment>\n${lines.join("\n")}\n</environment>`;
}

function filesystemEntry(path: string): string {
  if (!path.startsWith("file:")) return path;
  try {
    return fileURLToPath(path);
  } catch {
    return path;
  }
}

export function isDirectRunFrom(selfUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  const self = filesystemEntry(selfUrl);
  const entry = filesystemEntry(argv1);
  const left = realpathOrNull(self);
  const right = realpathOrNull(entry);
  // Never mix realpath and resolve: /tmp vs /private/tmp (or a one-sided
  // EMFILE) would look like a library import and skip main().
  if (left !== null && right !== null) return left === right;
  return resolve(self) === resolve(entry);
}
