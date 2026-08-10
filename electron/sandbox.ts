/**
 * Candidate sandbox (WORLDLINES §6.6).
 *
 * Builds the macOS sandbox-exec deny-list profile for one candidate:
 * the candidate may write only inside its own tree and support dirs.
 * The profile denies writes and reads of the primary project (except the
 * read-only source object directory), the real home, the app snapshot
 * store, the sibling candidate, and the app-owned worlds root. The copied
 * Pi resources are write-denied except the auth file (token refresh).
 *
 * The profile is defense in depth for file-tool paths; the operating
 * system policy is the actual write boundary. Process-inspection denial
 * is a documented gap: it breaks the pi TUI bootstrap.
 *
 * Network: the sandbox language only accepts `*` or `localhost` as the
 * remote host, so a per-provider allowlist is not expressible. Candidates
 * keep network (the model provider must be reachable); evidence and
 * Verify workers get a full network deny.
 *
 * Resource limits (WORLDLINES §6.6: bounded memory, CPU time, file size,
 * process count, open files) are not expressible in the profile language
 * either; the launcher wraps the command with a ulimit preamble
 * (`sandboxShellPreamble`).
 */
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface SandboxPaths {
  /** The candidate source tree (writable). */
  candidateRoot: string;
  /** The candidate support dir: home, sessions, events, tmp (writable). */
  candidateSupport: string;
  /** The sibling candidate tree (denied). */
  siblingDir: string;
  /** The comparison template (denied after cloning). */
  templateDir: string;
  /** The app-owned worlds root (denied except the candidate paths). */
  worldsRoot: string;
  /** The opened primary project root (denied). */
  primaryRoot: string;
  /** The read-only source Git object directory (read allowed). */
  sourceObjectsDir: string;
  /** The real home directory (denied). */
  realHome: string;
  /** The app snapshot store (denied). */
  storeDir: string;
  /** The app's primary events directory (denied). */
  primaryEventsDir: string;
  /** The app user-data directory (denied except the worlds root). */
  userData: string;
  /** Read-only paths the sandboxed pi must load: the app package code
   *  and the node binary. These usually live inside the real home. */
  appReadPaths: string[];
  /** The candidate home's .pi/agent dir (the copied Pi resources). */
  agentHomeDir: string;
  /** True for evidence and Verify workers: network fully denied. */
  denyNetwork: boolean;
}

/** Escape a path for the sandbox profile language. */
function quote(p: string): string {
  return `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The ulimit preamble for every sandboxed launch: bounded CPU time,
 * open files, and output file size. The wrapper shell applies them before
 * exec, so signals pass through. The address-space and process-count
 * limits are omitted: setrlimit(RLIMIT_AS) fails with EINVAL on current
 * macOS, and RLIMIT_NPROC is per-user, so a bound would break npm's forks
 * whenever the machine is busy. Process groups bound candidates instead.
 */
export function sandboxShellPreamble(): string {
  return "ulimit -t 7200 -n 1024 -f 2097152;";
}

/** Build the sandbox profile text for one candidate. */
export function buildSandboxProfile(p: SandboxPaths): string {
  const deny = (kind: string, path?: string): string => (path ? `(deny ${kind} (subpath ${quote(path)}))` : `(deny ${kind})`);
  const allow = (kind: string, path: string): string => `(allow ${kind} (subpath ${quote(path)}))`;
  const lines: string[] = [
    "(version 1)",
    "(allow default)",
    // The primary project: no writes, no reads except its Git objects.
    deny("file-write*", p.primaryRoot),
    deny("file-read*", p.primaryRoot),
    allow("file-read*", p.sourceObjectsDir),
    // The real home: no access except the app's own load paths below.
    // Metadata (lstat) stays allowed so path resolution can traverse home
    // without opening any file in it.
    deny("file-write*", p.realHome),
    deny("file-read*", p.realHome),
    allow("file-read-metadata", p.realHome),
    // The sandboxed pi must load the pinned package code and node.
    ...p.appReadPaths.map((loadPath) => allow("file-read*", loadPath)),
    // The candidate reads its own tree and support dirs.
    allow("file-read*", p.candidateRoot),
    allow("file-read*", p.candidateSupport),
    // The app user data: the bridge file and the worlds root reads stay
    // available; writes stay limited to this candidate's own dirs.
    allow("file-read*", p.userData),
    // The app snapshot store: no access after materialization.
    deny("file-write*", p.storeDir),
    deny("file-read*", p.storeDir),
    // The sibling and the template: no access.
    deny("file-write*", p.siblingDir),
    deny("file-read*", p.siblingDir),
    deny("file-write*", p.templateDir),
    deny("file-read*", p.templateDir),
    // The app user data: no writes except this candidate's own dirs.
    deny("file-write*", p.userData),
    deny("file-write*", p.primaryEventsDir),
    // The copied Pi resources are immutable inputs: no writes except the
    // auth file, whose token refresh changes only that copy (§6.6). The
    // rest of the home (npm logs, caches) stays writable for tooling.
    deny("file-write*", join(p.agentHomeDir, "settings.json")),
    deny("file-write*", join(p.agentHomeDir, "models-store.json")),
    deny("file-write*", join(p.agentHomeDir, "skills")),
    deny("file-write*", join(p.agentHomeDir, "prompts")),
    deny("file-write*", join(p.agentHomeDir, "themes")),
    deny("file-write*", join(p.agentHomeDir, "extensions")),
    allow("file-write*", join(p.agentHomeDir, "auth.json")),
    // Evidence and Verify workers run fully offline (WORLDLINES §6.8).
    ...(p.denyNetwork ? ["(deny network*)"] : []),
    allow("file-write*", p.candidateRoot),
    allow("file-write*", p.candidateSupport),
    // Process inspection denial breaks the pi TUI bootstrap (the node
    // runtime needs process info for its own startup). Documented gap.
    "(import \"system.sb\")",
    "",
  ];
  return lines.join("\n");
}

/** Write the profile to a file and return its path. */
export function writeSandboxProfile(profileDir: string, paths: SandboxPaths): string {
  mkdirSync(profileDir, { recursive: true });
  const path = join(profileDir, "sandbox.sb");
  writeFileSync(path, buildSandboxProfile(paths), { mode: 0o600 });
  return path;
}

/**
 * The evidence worker profile: the candidate's deny-list profile plus a
 * full network deny (WORLDLINES §6.8 — no evidence grant, no network).
 */
export function writeEvidenceProfile(cand: { profilePath: string; root: string }): string {
  const base = readFileSync(cand.profilePath, "utf8");
  const path = join(dirname(cand.profilePath), `evidence-${process.pid}.sb`);
  writeFileSync(path, `${base}\n(deny network*)\n`, { mode: 0o600 });
  return path;
}

/** The launcher command that wraps the pi binary in the sandbox. */
export function sandboxLaunchArgs(profilePath: string, piBin: string, piArgs: string[]): { cmd: string; args: string[] } {
  return { cmd: "sandbox-exec", args: ["-f", profilePath, piBin, ...piArgs] };
}

/** The canonical real home directory. */
export function realHome(): string {
  return process.env.HOME ?? dirname(process.cwd());
}
