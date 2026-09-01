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
 * Verify processes get a full network deny.
 *
 * Resource limits (WORLDLINES §6.6) are not expressible in the profile
 * language either. Candidate launches therefore put macOS taskpolicy outside
 * sandbox-exec for memory enforcement, and apply POSIX process-count/CPU/file
 * descriptor/file-size limits in the shell immediately before exec.
 */
import { randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, delimiter, dirname, extname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { quoteShellArg } from "../shared/terminal-control.ts";

/** The one sandbox binary Worldlines preflights and launches. */
export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
/** macOS's per-process memory-policy launcher. */
export const TASKPOLICY_EXEC = "/usr/sbin/taskpolicy";

/**
 * Resource budgets for a live candidate and every descendant it launches.
 * taskpolicy's memory budget is in MiB; the process budget is applied with
 * RLIMIT_NPROC by the candidate shell before it execs the agent.
 */
export const CANDIDATE_MEMORY_LIMIT_MIB = 1024;
export const CANDIDATE_PROCESS_LIMIT = 256;

export interface SandboxResourceLimits {
  memoryLimitMiB: number;
  processLimit: number;
}

/** The small child-process surface needed by process-group cleanup. */
export interface SandboxChildProcess {
  readonly pid?: number | null;
  readonly exitCode?: number | null;
  readonly signalCode?: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
}

const DEFAULT_RESOURCE_LIMITS: SandboxResourceLimits = {
  memoryLimitMiB: CANDIDATE_MEMORY_LIMIT_MIB,
  processLimit: CANDIDATE_PROCESS_LIMIT,
};

/** Validate limits before they become shell or argv values. */
export function validateSandboxResourceLimits(limits: SandboxResourceLimits): void {
  if (!Number.isSafeInteger(limits.memoryLimitMiB) || limits.memoryLimitMiB < 1 || limits.memoryLimitMiB > 1024 * 1024) {
    throw new Error("candidate memory limit must be a positive integer number of MiB");
  }
  if (!Number.isSafeInteger(limits.processLimit) || limits.processLimit < 1 || limits.processLimit > 1_000_000) {
    throw new Error("candidate process limit must be a positive integer");
  }
}

function executableAvailable(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Candidate resource limits are currently implemented only by macOS's
 * taskpolicy plus POSIX RLIMIT_NPROC. Do not silently fall back to an
 * unbounded candidate on another platform or when the helper is unavailable.
 */
export function platformHasSandboxResourceLimits(): boolean {
  return process.platform === "darwin" && executableAvailable(SANDBOX_EXEC) && executableAvailable(TASKPOLICY_EXEC);
}

/**
 * Validate the complete candidate resource-launch contract without spawning
 * anything. The preflight caller uses this before allocating a comparison;
 * the launch helper repeats the checks at the final spawn boundary.
 */
export function sandboxResourceLimitPreflight(
  isExecutable: (path: string) => boolean = executableAvailable,
): string | null {
  if (process.platform !== "darwin") return `candidate sandbox resource limits are unsupported on ${process.platform}`;
  if (!isExecutable(SANDBOX_EXEC)) return `candidate sandbox helper is unavailable: ${SANDBOX_EXEC}`;
  if (!isExecutable(TASKPOLICY_EXEC)) return `candidate resource-limit helper is unavailable: ${TASKPOLICY_EXEC}`;
  try {
    const launch = candidateSandboxLaunch("/dev/null", ["/usr/bin/true"]);
    if (
      launch.cmd !== TASKPOLICY_EXEC
      || launch.args.slice(0, 4).join(" ") !== `-m ${CANDIDATE_MEMORY_LIMIT_MIB} -P kill`
      || launch.args[4] !== SANDBOX_EXEC
      || launch.args[5] !== "-f"
      || launch.args[7] !== "/bin/zsh"
      || !launch.args.at(-1)?.includes(`ulimit -SH -u ${CANDIDATE_PROCESS_LIMIT}`)
    ) {
      return "candidate resource-limit launch arguments are invalid";
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Environment capabilities recognized by the bundled Pi and agent-core
 * providers. A live candidate receives values only for its selected provider;
 * unknown/custom providers must use their copied auth/config files.
 *
 * Deliberately excluded even for a selected provider: proxy variables,
 * container/instance metadata credential URLs, ambient profile/config paths,
 * and filesystem-backed ADC/web-identity credentials. Those are broader host
 * capabilities rather than one provider token.
 */
export const CANDIDATE_PROVIDER_ENV: Readonly<Record<string, readonly string[]>> = {
  anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_BASE_URL"],
  "ant-ling": ["ANT_LING_API_KEY"],
  "azure-openai-responses": [
    "AZURE_OPENAI_API_KEY",
    "AZURE_OPENAI_BASE_URL",
    "AZURE_OPENAI_RESOURCE_NAME",
    "AZURE_OPENAI_API_VERSION",
    "AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
  ],
  openai: ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
  "openai-codex": [],
  "github-copilot": ["COPILOT_GITHUB_TOKEN"],
  deepseek: ["DEEPSEEK_API_KEY"],
  nvidia: ["NVIDIA_API_KEY"],
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GEMINI_BASE_URL"],
  "google-vertex": [
    "GOOGLE_CLOUD_API_KEY",
    "GOOGLE_CLOUD_PROJECT",
    "GCLOUD_PROJECT",
    "GOOGLE_CLOUD_LOCATION",
    "GOOGLE_VERTEX_BASE_URL",
  ],
  "amazon-bedrock": [
    "AWS_BEARER_TOKEN_BEDROCK",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
  ],
  mistral: ["MISTRAL_API_KEY"],
  groq: ["GROQ_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  "cloudflare-ai-gateway": ["CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID"],
  "cloudflare-workers-ai": ["CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID"],
  xai: ["XAI_API_KEY", "XAI_BASE_URL"],
  openrouter: ["OPENROUTER_API_KEY", "OPENROUTER_BASE_URL"],
  "vercel-ai-gateway": ["AI_GATEWAY_API_KEY"],
  zai: ["ZAI_API_KEY"],
  "zai-coding-cn": ["ZAI_CODING_CN_API_KEY"],
  opencode: ["OPENCODE_API_KEY"],
  "opencode-go": ["OPENCODE_API_KEY", "OPENCODE_GO_API_KEY"],
  "opencode-zen": ["OPENCODE_API_KEY"],
  radius: ["RADIUS_API_KEY"],
  huggingface: ["HF_TOKEN"],
  fireworks: ["FIREWORKS_API_KEY"],
  together: ["TOGETHER_API_KEY"],
  baseten: ["BASETEN_API_KEY"],
  "kimi-coding": ["KIMI_API_KEY"],
  minimax: ["MINIMAX_API_KEY"],
  "minimax-cn": ["MINIMAX_CN_API_KEY"],
  moonshotai: ["MOONSHOT_API_KEY"],
  "moonshotai-cn": ["MOONSHOT_API_KEY"],
  "qwen-token-plan": ["QWEN_TOKEN_PLAN_API_KEY"],
  "qwen-token-plan-individual": ["QWEN_TOKEN_PLAN_API_KEY"],
  "qwen-token-plan-cn": ["QWEN_TOKEN_PLAN_CN_API_KEY"],
  xiaomi: ["XIAOMI_API_KEY"],
  "xiaomi-token-plan-cn": ["XIAOMI_TOKEN_PLAN_CN_API_KEY"],
  "xiaomi-token-plan-ams": ["XIAOMI_TOKEN_PLAN_AMS_API_KEY"],
  "xiaomi-token-plan-sgp": ["XIAOMI_TOKEN_PLAN_SGP_API_KEY"],
  "llama.cpp": ["LLAMA_API_KEY", "LLAMA_BASE_URL"],
};

const CANDIDATE_RUNTIME_ENV = ["LANG", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM", "NO_COLOR", "FORCE_COLOR"] as const;
const DEFAULT_CANDIDATE_PATH = ["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const MAX_SANDBOX_PROFILE_BYTES = 1024 * 1024;

/** Keep executable search deterministic: absolute, control-free, unique dirs. */
function candidatePath(hostPath: string | undefined, prefixes: readonly string[]): string {
  const entries = [...prefixes, ...(hostPath ?? "").split(delimiter), ...DEFAULT_CANDIDATE_PATH];
  const clean: string[] = [];
  for (const entry of entries) {
    if (!entry || !isAbsolute(entry) || /[\0\r\n]/.test(entry)) continue;
    const path = normalize(entry);
    if (!clean.includes(path)) clean.push(path);
  }
  return clean.join(delimiter);
}

/**
 * Pure candidate-env policy used by main's candidate-only factory. This is an
 * allowlist, not the ordinary terminal environment with a larger blocklist.
 */
export function filterCandidateEnvironment(
  hostEnv: NodeJS.Dict<string | undefined>,
  provider: string | null,
  pathPrefixes: readonly string[],
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    PATH: candidatePath(hostEnv.PATH, pathPrefixes),
    PI_SKIP_VERSION_CHECK: "1",
  };
  for (const key of CANDIDATE_RUNTIME_ENV) {
    const value = hostEnv[key];
    if (value !== undefined && !/[\0\r\n]/.test(value)) env[key] = value;
  }
  const normalizedProvider = provider?.trim().toLowerCase() ?? "";
  for (const key of CANDIDATE_PROVIDER_ENV[normalizedProvider] ?? []) {
    const value = hostEnv[key];
    if (value !== undefined && value.length > 0 && !value.includes("\0")) env[key] = value;
  }
  return env;
}

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
  /** The exact immutable app bridge loaded by candidate Pi. */
  bridgePath: string;
  /** Read-only paths the sandboxed pi must load: the app package code
   *  and the node binary. These usually live inside the real home. */
  appReadPaths: string[];
  /** The candidate home's .pi/agent dir (the copied Pi resources). */
  agentHomeDir: string;
  /** True for evidence and Verify processes: network fully denied. */
  denyNetwork: boolean;
}

/** Escape a path for the sandbox profile language. */
function quote(p: string): string {
  return `"${p
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")}"`;
}

/**
 * sandbox-exec compares canonical filesystem paths (`/tmp` is
 * `/private/tmp` on macOS). Resolve the deepest existing ancestor so even a
 * deliberate non-existent sentinel such as `__none__` uses the same namespace.
 */
function sandboxPath(path: string): string {
  let current = resolve(path);
  const suffix: string[] = [];
  while (true) {
    try {
      return join(realpathSync(current), ...suffix.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      suffix.push(basename(current));
      current = parent;
    }
  }
}

/** Preserve an untrusted descendant lexically below its trusted canonical root. */
function sandboxDescendant(root: string, path: string): string {
  const rel = relative(resolve(root), resolve(path));
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`sandbox path is outside its root: ${path}`);
  return join(sandboxPath(root), rel);
}

/**
 * The ulimit preamble for every sandboxed launch. It is intentionally static:
 * callers append only shell-quoted argv values, so candidate-controlled text
 * cannot become shell syntax. A failed limit setup exits before the target is
 * exec'd (fail closed on platforms where this preamble is used).
 */
export function sandboxShellPreamble(processLimit = CANDIDATE_PROCESS_LIMIT): string {
  if (!Number.isSafeInteger(processLimit) || processLimit < 1 || processLimit > 1_000_000) {
    throw new Error("candidate process limit must be a positive integer");
  }
  return `ulimit -t 7200 && ulimit -n 1024 && ulimit -f 2097152 && ulimit -SH -u ${processLimit} || exit 126;`;
}

/**
 * Construct the one canonical candidate launch wrapper. taskpolicy must be
 * outside sandbox-exec: the latter's profile can deny the policy syscall, and
 * taskpolicy's inherited memory policy then covers sandbox-exec, the shell,
 * the agent, and all descendants. The returned argv is passed directly to
 * node-pty; no user value is interpolated without POSIX shell quoting.
 */
export function candidateSandboxLaunch(
  profilePath: string,
  command: readonly string[],
  limits: SandboxResourceLimits = DEFAULT_RESOURCE_LIMITS,
): { cmd: string; args: string[] } {
  validateSandboxResourceLimits(limits);
  if (!platformHasSandboxResourceLimits()) {
    throw new Error(`candidate sandbox resource limits are unsupported on ${process.platform}`);
  }
  if (!profilePath || profilePath.includes("\0")) throw new Error("candidate sandbox profile path is invalid");
  if (command.length === 0 || command.some((arg) => arg.includes("\0"))) {
    throw new Error("candidate sandbox command is invalid");
  }
  return {
    cmd: TASKPOLICY_EXEC,
    args: [
      "-m",
      String(limits.memoryLimitMiB),
      "-P",
      "kill",
      SANDBOX_EXEC,
      "-f",
      profilePath,
      "/bin/zsh",
      "-c",
      `${sandboxShellPreamble(limits.processLimit)} exec ${command.map(quoteShellArg).join(" ")}`,
    ],
  };
}

function processGroupAlive(child: SandboxChildProcess): boolean {
  const pid = child.pid;
  if (process.platform === "win32" || !pid || pid <= 0) {
    return child.exitCode === null && child.signalCode === null;
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForProcessGroupGone(child: SandboxChildProcess, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (processGroupAlive(child)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, Math.min(25, remaining)));
  }
  return !processGroupAlive(child);
}

function signalProcessGroup(child: SandboxChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (process.platform !== "win32" && pid && pid > 0) {
    try {
      process.kill(-pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        // Fall through to the direct child signal. This preserves cleanup if
        // a platform denies process-group signalling but permits child.kill.
      }
    }
  }
  try {
    child.kill(signal);
  } catch {
    /* The child may have exited between the group and direct signal. */
  }
}

/**
 * Stop a sandboxed worker and wait until its entire process group disappears.
 * The wait is asynchronous so timeout/cancellation cleanup never blocks the
 * Electron main thread. SIGKILL is the final fallback for descendants that
 * ignore the graceful signal.
 */
export async function terminateSandboxProcessGroup(
  child: SandboxChildProcess,
  initialSignal: NodeJS.Signals = "SIGTERM",
  graceMs = 1_500,
): Promise<boolean> {
  if (!processGroupAlive(child)) return true;
  signalProcessGroup(child, initialSignal);
  if (await waitForProcessGroupGone(child, graceMs)) return true;
  signalProcessGroup(child, "SIGKILL");
  return waitForProcessGroupGone(child, graceMs);
}

/** Build the sandbox profile text for one candidate. */
export function buildSandboxProfile(p: SandboxPaths): string {
  const deny = (kind: string, path?: string): string => (path ? `(deny ${kind} (subpath ${quote(path)}))` : `(deny ${kind})`);
  const allow = (kind: string, path: string): string => `(allow ${kind} (subpath ${quote(path)}))`;
  const allowExact = (kind: string, path: string): string => `(allow ${kind} (literal ${quote(path)}))`;
  const candidateRoot = sandboxPath(p.candidateRoot);
  const candidateSupport = sandboxPath(p.candidateSupport);
  // A candidate may replace files below its support directory between
  // launches. Do not follow those leaves while minting profile exceptions.
  const agentHomeDir = sandboxDescendant(p.candidateSupport, p.agentHomeDir);
  const lines: string[] = [
    "(version 1)",
    "(allow default)",
    // The primary project: no writes, no reads except its Git objects.
    deny("file-write*", sandboxPath(p.primaryRoot)),
    deny("file-read*", sandboxPath(p.primaryRoot)),
    allow("file-read*", sandboxPath(p.sourceObjectsDir)),
    // The real home: no access except the app's own load paths below.
    // Metadata (lstat) stays allowed so path resolution can traverse home
    // without opening any file in it.
    deny("file-write*", sandboxPath(p.realHome)),
    deny("file-read*", sandboxPath(p.realHome)),
    allow("file-read-metadata", sandboxPath(p.realHome)),
    // The sandboxed pi must load the pinned package code and node.
    ...p.appReadPaths.map((loadPath) => allow("file-read*", sandboxPath(loadPath))),
    // App-private state is unreadable. Metadata remains available only so
    // path resolution can reach the exact bridge and candidate exceptions.
    deny("file-write*", sandboxPath(p.userData)),
    deny("file-read*", sandboxPath(p.userData)),
    allow("file-read-metadata", sandboxPath(p.userData)),
    allowExact("file-read*", sandboxPath(p.bridgePath)),
    // Every comparison/session/journal below the worlds root is denied. The
    // current candidate's two directories are re-opened after all denies.
    deny("file-write*", sandboxPath(p.worldsRoot)),
    deny("file-read*", sandboxPath(p.worldsRoot)),
    // The app snapshot store: no access after materialization.
    deny("file-write*", sandboxPath(p.storeDir)),
    deny("file-read*", sandboxPath(p.storeDir)),
    // The sibling and the template: no access.
    deny("file-write*", sandboxPath(p.siblingDir)),
    deny("file-read*", sandboxPath(p.siblingDir)),
    deny("file-write*", sandboxPath(p.templateDir)),
    deny("file-read*", sandboxPath(p.templateDir)),
    deny("file-write*", sandboxPath(p.primaryEventsDir)),
    deny("file-read*", sandboxPath(p.primaryEventsDir)),
    // The candidate reads and writes only its own tree and support dirs.
    allow("file-read*", candidateRoot),
    allow("file-read*", candidateSupport),
    allow("file-write*", candidateRoot),
    allow("file-write*", candidateSupport),
    // The copied Pi resources are immutable inputs: no writes except the
    // auth file, whose token refresh changes only that copy (§6.6). The
    // rest of the home (npm logs, caches) stays writable for tooling.
    deny("file-write*", join(agentHomeDir, "settings.json")),
    deny("file-write*", join(agentHomeDir, "models.json")),
    deny("file-write*", join(agentHomeDir, "models-store.json")),
    deny("file-write*", join(agentHomeDir, "skills")),
    deny("file-write*", join(agentHomeDir, "prompts")),
    deny("file-write*", join(agentHomeDir, "themes")),
    deny("file-write*", join(agentHomeDir, "extensions")),
    allow("file-write*", join(agentHomeDir, "auth.json")),
    // Evidence and Verify processes run fully offline (WORLDLINES §6.8).
    ...(p.denyNetwork ? ["(deny network*)"] : []),
    // taskpolicy is the trusted outer launcher. A candidate must not be able
    // to invoke it again (or copy it into its writable tree) and replace the
    // inherited memory policy.
    `(deny file-read* (literal ${quote(TASKPOLICY_EXEC)}))`,
    `(deny process-exec (literal ${quote(TASKPOLICY_EXEC)}))`,
    // Process inspection denial breaks the pi TUI bootstrap (the node
    // runtime needs process info for its own startup). Documented gap.
    "(import \"system.sb\")",
    "",
  ];
  return lines.join("\n");
}

/** The only trusted profile location: a sibling of the candidate dirs. */
function trustedProfilePath(profilePath: string, candidateRoot: string): string {
  const path = resolve(profilePath);
  const expectedDir = join(dirname(resolve(candidateRoot)), "profiles");
  if (dirname(path) !== expectedDir || extname(path) !== ".sb") {
    throw new Error(`sandbox profile is outside the app-owned comparison profile directory: ${profilePath}`);
  }
  return path;
}

/** Atomically replace one private regular profile without following leaves. */
function writePrivateProfile(profilePath: string, content: string): string {
  const path = resolve(profilePath);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dirInfo = lstatSync(dir);
  if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) throw new Error(`sandbox profile directory is not a private directory: ${dir}`);
  chmodSync(dir, 0o700);

  const temporary = join(dir, `.${basename(path)}.tmp-${process.pid}-${randomUUID()}`);
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  let fd: number | null = null;
  try {
    fd = openSync(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o600);
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temporary, path);
    return path;
  } finally {
    if (fd !== null) closeSync(fd);
    rmSync(temporary, { force: true });
  }
}

/** Read one app-owned base profile without following a replacement symlink. */
function readPrivateProfile(profilePath: string): string {
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const fd = openSync(profilePath, fsConstants.O_RDONLY | noFollow);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > MAX_SANDBOX_PROFILE_BYTES) {
      throw new Error(`sandbox profile is not a bounded regular file: ${profilePath}`);
    }
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/** Write the live profile to its exact app-owned path and return that path. */
export function writeSandboxProfile(profilePath: string, paths: SandboxPaths): string {
  const path = trustedProfilePath(profilePath, paths.candidateRoot);
  return writePrivateProfile(path, buildSandboxProfile(paths));
}

/**
 * The evidence worker profile: the candidate's deny-list profile plus a
 * full network deny (WORLDLINES §6.8 — no evidence grant, no network).
 */
export function writeEvidenceProfile(cand: { profilePath: string; root: string }): string {
  const basePath = trustedProfilePath(cand.profilePath, cand.root);
  const base = readPrivateProfile(basePath);
  const stem = basename(basePath, extname(basePath));
  const path = join(dirname(basePath), `${stem}-evidence-${process.pid}-${randomUUID()}.sb`);
  return writePrivateProfile(path, `${base}\n(deny network*)\n`);
}

/** Build an evidence profile without writing through a mutable pathname. */
export function evidenceProfileContent(cand: { profilePath: string; root: string }, boundBase?: string): { path: string; content: string } {
  const basePath = trustedProfilePath(cand.profilePath, cand.root);
  // Production callers provide bytes read through the native bound profile
  // leaf.  The optional pathname read remains only for the focused sandbox
  // fixture, which supplies no native owner.
  const base = boundBase ?? readPrivateProfile(basePath);
  const stem = basename(basePath, extname(basePath));
  return {
    path: join(dirname(basePath), `${stem}-evidence-${process.pid}-${randomUUID()}.sb`),
    content: `${base}\n(deny network*)\n`,
  };
}
