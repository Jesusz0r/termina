/**
 * Focused contracts for candidate filesystem and environment isolation.
 *
 * Run with:
 *   node --experimental-strip-types --no-warnings scripts/sandbox-security-test.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANDIDATE_PROVIDER_ENV,
  CANDIDATE_MEMORY_LIMIT_MIB,
  CANDIDATE_PROCESS_LIMIT,
  SANDBOX_EXEC,
  TASKPOLICY_EXEC,
  buildSandboxProfile,
  candidateSandboxLaunch,
  filterCandidateEnvironment,
  platformHasSandboxResourceLimits,
  sandboxResourceLimitPreflight,
  sandboxShellPreamble,
  terminateSandboxProcessGroup,
  validateSandboxResourceLimits,
  writeEvidenceProfile,
  writeSandboxProfile,
} from "../electron/sandbox.ts";

const results = [];
const requireLive = process.env.TERMINA_SANDBOX_REQUIRE_LIVE === "1";
const signalExitCodes = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
let activeRacerStop = null;
let signalExit = null;
let signalShutdown = null;
const requestSignalShutdown = (signal) => {
  signalExit ??= signalExitCodes[signal] ?? 1;
  signalShutdown ??= (async () => {
    try {
      if (activeRacerStop) await activeRacerStop(signal);
    } catch (error) {
      console.error(`sandbox racer cleanup failed during ${signal}: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exit(signalExit);
  })();
};
process.on("SIGINT", () => requestSignalShutdown("SIGINT"));
process.on("SIGTERM", () => requestSignalShutdown("SIGTERM"));
process.on("SIGHUP", () => requestSignalShutdown("SIGHUP"));
const testRacerMarker = process.env.NODE_ENV === "test" ? process.env.TERMINA_SANDBOX_RACER_MARKER : undefined;
const testFailAfterRacer = process.env.NODE_ENV === "test" && process.env.TERMINA_SANDBOX_TEST_FAIL_AFTER_RACER === "1";
const testHoldAfterRacer = process.env.NODE_ENV === "test" && process.env.TERMINA_SANDBOX_TEST_HOLD_AFTER_RACER === "1";
const wrappedGate = process.env.TERMINA_SANDBOX_GATE_WRAPPED === "1";
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${String(detail).slice(0, 240)}` : ""}`);
};

const fixture = mkdtempSync(join(tmpdir(), "termina-sandbox-security-"));
const externalFixture = mkdtempSync(join(tmpdir(), "termina-sandbox-security-external-"));
process.on("exit", () => {
  rmSync(fixture, { recursive: true, force: true });
  rmSync(externalFixture, { recursive: true, force: true });
});

const userData = join(fixture, "user-data");
const worldsRoot = join(userData, "worlds");
const comparison = join(worldsRoot, "comparison");
const profileDir = join(comparison, "profiles");
const liveProfilePath = join(profileDir, "A.sb");
const candidateRoot = join(comparison, "A");
const candidateSupport = join(comparison, "A-support");
const siblingDir = join(comparison, "B");
const siblingSupport = join(comparison, "B-support");
const templateDir = join(comparison, "template");
const otherWorld = join(worldsRoot, "other-comparison");
const sessionWorkspace = join(comparison, "session-workspace");
const promotionJournal = join(worldsRoot, "promotion-journal", "pending");
const primaryRoot = join(fixture, "primary");
const sourceObjectsDir = join(primaryRoot, ".git", "objects");
const storeDir = join(userData, "worldlines");
// Primary events normally live in app.getPath("temp"), outside home/userData.
// Keep this fixture disjoint so another broad deny cannot mask its contract.
const primaryEventsDir = join(externalFixture, "events");
const bridgePath = join(userData, 'termina-bridge-"quoted"\\path.ts');
const agentHomeDir = join(candidateSupport, "home", ".pi", "agent");
for (const path of [
  candidateRoot,
  candidateSupport,
  profileDir,
  siblingDir,
  siblingSupport,
  templateDir,
  otherWorld,
  sessionWorkspace,
  promotionJournal,
  sourceObjectsDir,
  storeDir,
  primaryEventsDir,
  agentHomeDir,
]) {
  mkdirSync(path, { recursive: true });
}
writeFileSync(bridgePath, "export default true;\n");
writeFileSync(join(agentHomeDir, "auth.json"), "{}\n");
writeFileSync(join(agentHomeDir, "settings.json"), "{}\n");
const primaryEventsSecret = join(primaryEventsDir, "primary-sidecar.jsonl");
writeFileSync(primaryEventsSecret, "primary event secret\n");
const primarySentinel = join(primaryRoot, "primary-sentinel.txt");
writeFileSync(primarySentinel, "primary source\n");
const preference = join(userData, "preferences.json");
const roster = join(userData, "terminal-roster.json");
const primarySession = join(userData, "agent-sessions", "primary.jsonl");
mkdirSync(join(userData, "agent-sessions"), { recursive: true });
for (const path of [preference, roster, primarySession]) writeFileSync(path, "secret\n");
const siblingSecret = join(siblingDir, "session.jsonl");
writeFileSync(siblingSecret, "sibling secret\n");
for (const dir of [siblingSupport, otherWorld, sessionWorkspace, promotionJournal]) {
  writeFileSync(join(dir, "secret.txt"), "world secret\n");
}

const paths = {
  candidateRoot,
  candidateSupport,
  siblingDir,
  templateDir,
  worldsRoot,
  primaryRoot,
  sourceObjectsDir,
  realHome: fixture,
  storeDir,
  primaryEventsDir,
  userData,
  bridgePath,
  appReadPaths: ["/bin", "/usr"],
  agentHomeDir,
  denyNetwork: false,
};
const profile = buildSandboxProfile(paths);
const canonicalWorldsRoot = realpathSync(worldsRoot);
const canonicalUserData = realpathSync(userData);
const canonicalPrimaryEvents = realpathSync(primaryEventsDir);
check("worlds root has a read deny", profile.includes(`(deny file-read* (subpath "${canonicalWorldsRoot}"))`));
check("worlds root has a write deny", profile.includes(`(deny file-write* (subpath "${canonicalWorldsRoot}"))`));
check("user data has a read deny", profile.includes(`(deny file-read* (subpath "${canonicalUserData}"))`));
check("external primary events have a read deny", profile.includes(`(deny file-read* (subpath "${canonicalPrimaryEvents}"))`));
check("external primary events have a write deny", profile.includes(`(deny file-write* (subpath "${canonicalPrimaryEvents}"))`));
check("bridge uses an exact read exception", profile.includes("(allow file-read* (literal ") && profile.includes('\\"quoted\\"\\\\path.ts'));
check("broad user-data read exception is absent", !profile.includes(`(allow file-read* (subpath "${canonicalUserData}"))`));
check(
  "candidate cannot replace its inherited memory policy",
  profile.includes(`(deny file-read* (literal "${TASKPOLICY_EXEC}"))`)
    && profile.includes(`(deny process-exec (literal "${TASKPOLICY_EXEC}"))`),
);

const authPath = join(agentHomeDir, "auth.json");
rmSync(authPath);
symlinkSync(preference, authPath);
const hostileAuthProfile = buildSandboxProfile(paths);
check(
  "auth exception does not follow a candidate-planted symlink",
  hostileAuthProfile.includes(`(allow file-write* (subpath "${join(realpathSync(candidateSupport), "home", ".pi", "agent", "auth.json")}"))`)
    && !hostileAuthProfile.includes(`(allow file-write* (subpath "${realpathSync(preference)}"))`),
);
rmSync(authPath);
writeFileSync(authPath, "{}\n");

const injected = buildSandboxProfile({ ...paths, candidateRoot: `${candidateRoot}\n(allow default)` });
check("profile path quoting prevents newline injection", !injected.includes(`"${candidateRoot}\n(allow default)"`));
check("profile path quoting preserves an escaped newline", injected.includes("\\n(allow default)"));

const symlinkProfilePath = join(profileDir, "symlink-target.sb");
symlinkSync(primarySentinel, symlinkProfilePath);
const writtenSymlinkProfile = writeSandboxProfile(symlinkProfilePath, paths);
check(
  "atomic profile replacement does not follow a planted target symlink",
  writtenSymlinkProfile === symlinkProfilePath
    && lstatSync(symlinkProfilePath).isFile()
    && readFileSync(primarySentinel, "utf8") === "primary source\n",
);

check("launcher constant is the verified absolute binary", SANDBOX_EXEC === "/usr/bin/sandbox-exec");
check("candidate resource defaults are valid", (() => {
  try {
    validateSandboxResourceLimits({ memoryLimitMiB: CANDIDATE_MEMORY_LIMIT_MIB, processLimit: CANDIDATE_PROCESS_LIMIT });
    return true;
  } catch {
    return false;
  }
})());
check("candidate resource validation rejects unsafe values", (() => {
  try {
    validateSandboxResourceLimits({ memoryLimitMiB: 0, processLimit: CANDIDATE_PROCESS_LIMIT });
    return false;
  } catch {
    return true;
  }
})());
check(
  "candidate shell preamble applies a process ceiling and fails closed",
  sandboxShellPreamble().includes(`ulimit -SH -u ${CANDIDATE_PROCESS_LIMIT}`)
    && sandboxShellPreamble().includes("|| exit 126;"),
);
const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const mainSource = readFileSync(join(repoRoot, "electron", "main.ts"), "utf8");
const sandboxSource = readFileSync(join(repoRoot, "electron", "sandbox.ts"), "utf8");
const worldlinesSource = readFileSync(join(repoRoot, "electron", "worldlines.ts"), "utf8");
const preflightSource = readFileSync(join(repoRoot, "electron", "worldline-git.ts"), "utf8");
check("evidence and Verify launch the absolute constant", !mainSource.includes('spawn("sandbox-exec"') && !mainSource.includes('? "sandbox-exec" :'));
check(
  "Evidence and Verify both derive from the trusted profile helper",
  (mainSource.includes("const profilePath = writeEvidenceProfile(cand)")
    && mainSource.includes("verifyProfilePath = writeEvidenceProfile(candidate)"))
    || (mainSource.includes("createBoundEvidenceProfile(cand)")
      && mainSource.includes("createBoundEvidenceProfile(candidate)")),
);
check("Pi and core candidates launch the absolute constant", !worldlinesSource.includes('cmd: "sandbox-exec"'));
check("preflight checks the same absolute constant", preflightSource.includes("readFileSync(SANDBOX_EXEC)"));
check(
  "evidence and Verify use the canonical resource-limit wrapper",
  mainSource.includes("candidateSandboxLaunch(profilePath")
    && mainSource.includes("candidateSandboxLaunch(verifyProfilePath!")
    && !mainSource.includes("spawn(SANDBOX_EXEC"),
);
check(
  "evidence and Verify preserve shell-safe command quoting",
  mainSource.includes("command.map(quoteShellArg)")
    && mainSource.includes("tc.args.map(quoteShellArg)"),
);
check(
  "preflight validates the resource helper and constructed arguments",
  mainSource.includes("sandboxResourceLimitPreflight()")
    && sandboxSource.includes("candidate resource-limit helper is unavailable")
    && sandboxSource.includes("candidate resource-limit launch arguments are invalid"),
);
check(
  "missing sandbox helper fails preflight",
  sandboxResourceLimitPreflight((path) => path !== SANDBOX_EXEC)?.includes("sandbox helper is unavailable") === true,
);
check(
  "missing resource-limit helper fails preflight",
  sandboxResourceLimitPreflight((path) => path !== TASKPOLICY_EXEC)?.includes("resource-limit helper is unavailable") === true,
);

if (process.platform === "darwin") {
  check("macOS exposes the taskpolicy resource launcher", platformHasSandboxResourceLimits() && TASKPOLICY_EXEC === "/usr/sbin/taskpolicy");
  check("macOS resource-limit preflight accepts the production wrapper", sandboxResourceLimitPreflight() === null);
  if (platformHasSandboxResourceLimits()) {
    const constructed = candidateSandboxLaunch(liveProfilePath, ["/bin/echo", "$(touch injected)", "line\nwith text"], {
      memoryLimitMiB: 64,
      processLimit: 8,
    });
    check(
      "candidate launch constructs taskpolicy memory and process limits",
      constructed.cmd === TASKPOLICY_EXEC
        && constructed.args.slice(0, 4).join(" ") === "-m 64 -P kill"
        && constructed.args.includes(SANDBOX_EXEC)
        && constructed.args.at(-1)?.includes("ulimit -SH -u 8")
        && constructed.args.at(-1)?.includes("'$(touch injected)'")
        && constructed.args.at(-1)?.includes("'line\nwith text'"),
    );

    // taskpolicy's process policy is inherited by descendants. The low test
    // ceiling makes zsh refuse a fanout without leaving long-lived children.
    const fanout = spawnSync(
      TASKPOLICY_EXEC,
      ["-m", "256", "-P", "kill", "/bin/zsh", "-c", `${sandboxShellPreamble(8)} for i in {1..128}; do /usr/bin/true & done; wait`],
      { encoding: "utf8", timeout: 15_000 },
    );
    check(
      "candidate process fanout is refused by the enforced ceiling",
      fanout.status !== 0 && /fork failed|resource temporarily unavailable|process/i.test(`${fanout.stdout}\n${fanout.stderr}`),
      `status=${fanout.status} stderr=${String(fanout.stderr).slice(0, 160)}`,
    );

    const control = spawnSync(
      TASKPOLICY_EXEC,
      ["-m", String(CANDIDATE_MEMORY_LIMIT_MIB), "-P", "kill", "/bin/zsh", "-c", `${sandboxShellPreamble()} exec /usr/bin/true`],
      { encoding: "utf8", timeout: 15_000 },
    );
    check(
      "ordinary bounded candidate startup remains allowed",
      control.status === 0 && control.signal === null,
      `status=${control.status} signal=${control.signal} stderr=${String(control.stderr).slice(0, 160)}`,
    );

    // A 1 MiB taskpolicy budget is intentionally below this test runner's
    // normal resident set. This is a refusal probe, not the production budget;
    // using the current Node binary avoids assuming an optional system runtime
    // such as /usr/bin/python3 and keeps the probe deterministic and leak-free.
    const memory = spawnSync(
      TASKPOLICY_EXEC,
      ["-m", "1", "-P", "kill", process.execPath, "-e", "process.stdout.write('unexpected')"],
      { encoding: "utf8" },
    );
    check(
      "candidate memory budget refuses over-budget startup",
      memory.signal === "SIGKILL" && memory.stdout === "" && memory.stderr === "",
      `status=${memory.status} signal=${memory.signal}`,
    );
  }
} else {
  check("unsupported platforms do not claim candidate resource limits", !platformHasSandboxResourceLimits());
}

if (process.platform !== "win32") {
  let timeoutChild = null;
  let descendantPid = null;
  let cleanupDetail = "";
  let cleanupPassed = false;
  const groupGone = (pid) => {
    if (!pid || pid <= 0) return true;
    try {
      process.kill(-pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  };
  try {
    const shell = existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/sh";
    timeoutChild = spawn(shell, ["-c", "sleep 30 & printf '%s\\n' \"$!\"; wait"], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    descendantPid = await new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("descendant marker timed out")), 3_000);
      timeoutChild.stdout?.on("data", (data) => {
        output += data.toString();
        const pid = Number(output.trim().split(/\s+/)[0]);
        if (Number.isInteger(pid) && pid > 0) {
          clearTimeout(timer);
          resolve(pid);
        }
      });
      timeoutChild.once("error", reject);
    });
    cleanupPassed = await terminateSandboxProcessGroup(timeoutChild, "SIGKILL", 100);
    const deadline = Date.now() + 2_000;
    while (!groupGone(timeoutChild.pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    cleanupPassed = cleanupPassed && groupGone(timeoutChild.pid) && groupGone(descendantPid);
  } catch (error) {
    cleanupDetail = error instanceof Error ? error.message : String(error);
  } finally {
    if (timeoutChild && !groupGone(timeoutChild.pid)) {
      await terminateSandboxProcessGroup(timeoutChild, "SIGKILL", 1_000).catch(() => undefined);
    }
  }
  check(
    "timeout cleanup waits for the full worker process group",
    cleanupPassed,
    cleanupDetail || `child=${timeoutChild?.pid ?? "none"} descendant=${descendantPid ?? "none"}`,
  );
}

const hostEnv = {
  PATH: "/opt/homebrew/bin::relative:/usr/bin:/bin:/usr/bin",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
  OPENAI_API_KEY: "selected-key",
  OPENAI_BASE_URL: "https://relay.invalid/v1",
  ANTHROPIC_API_KEY: "other-key",
  AWS_SECRET_ACCESS_KEY: "aws-secret",
  RANDOM_SERVICE_TOKEN: "ambient-token",
  HTTPS_PROXY: "http://proxy.invalid",
  HTTP_PROXY: "http://proxy.invalid",
  SSH_AUTH_SOCK: "/tmp/ssh.sock",
  GPG_AGENT_INFO: "/tmp/gpg.sock",
  DOCKER_HOST: "unix:///tmp/docker.sock",
  PI_SESSION_FILE: "/tmp/primary-session",
  TERMINA_CORE_SESSION_FILE: "/tmp/primary-core-session",
  NODE_OPTIONS: "--require /tmp/inject.js",
};
const openai = filterCandidateEnvironment(hostEnv, "openai", ["/app/node/bin"]);
check(
  "candidate PATH keeps only absolute unique entries",
  openai.PATH === "/app/node/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/local/bin:/usr/sbin:/sbin",
  openai.PATH,
);
check("candidate keeps terminal and locale basics", openai.LANG === hostEnv.LANG && openai.TERM === hostEnv.TERM && openai.COLORTERM === hostEnv.COLORTERM);
check("candidate forwards only the selected credential", openai.OPENAI_API_KEY === "selected-key" && openai.ANTHROPIC_API_KEY === undefined);
check("candidate forwards the selected provider base URL", openai.OPENAI_BASE_URL === hostEnv.OPENAI_BASE_URL);
for (const key of [
  "AWS_SECRET_ACCESS_KEY",
  "RANDOM_SERVICE_TOKEN",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "SSH_AUTH_SOCK",
  "GPG_AGENT_INFO",
  "DOCKER_HOST",
  "PI_SESSION_FILE",
  "TERMINA_CORE_SESSION_FILE",
  "NODE_OPTIONS",
]) {
  check(`candidate strips ${key}`, openai[key] === undefined);
}
const noProvider = filterCandidateEnvironment(hostEnv, null, []);
check("unknown provider receives no ambient credential", noProvider.OPENAI_API_KEY === undefined && noProvider.ANTHROPIC_API_KEY === undefined);

const allProviderKeys = [...new Set(Object.values(CANDIDATE_PROVIDER_ENV).flat())];
for (const [provider, keys] of Object.entries(CANDIDATE_PROVIDER_ENV)) {
  const seeded = Object.fromEntries(allProviderKeys.map((key) => [key, `${provider}:${key}`]));
  seeded.UNRELATED_API_KEY = "unrelated";
  const filtered = filterCandidateEnvironment(seeded, provider, []);
  check(
    `provider mapping is exact for ${provider}`,
    keys.every((key) => filtered[key] === seeded[key])
      && allProviderKeys.filter((key) => !keys.includes(key)).every((key) => filtered[key] === undefined)
      && filtered.UNRELATED_API_KEY === undefined,
  );
}

if (process.platform === "darwin") {
  const canApply = spawnSync(SANDBOX_EXEC, ["-p", "(version 1)\n(allow default)\n", "/usr/bin/true"], { encoding: "utf8" });
  if (canApply.status === 0) {
    const profilePath = writeSandboxProfile(liveProfilePath, paths);
    check("live profile uses the app-owned comparison profile directory", profilePath === liveProfilePath && !profilePath.startsWith(`${candidateRoot}/`) && !profilePath.startsWith(`${candidateSupport}/`));
    const probe = (path) => spawnSync(SANDBOX_EXEC, ["-f", profilePath, "/bin/cat", path], { encoding: "utf8" });
    const bridge = probe(bridgePath);
    check("macOS sandbox reads the exact immutable bridge", bridge.status === 0 && bridge.stdout.includes("export default"), bridge.stderr);
    const bridgeWrite = spawnSync(SANDBOX_EXEC, ["-f", profilePath, "/usr/bin/touch", bridgePath], { encoding: "utf8" });
    check("macOS sandbox keeps the bridge immutable", bridgeWrite.status !== 0, `status=${bridgeWrite.status}`);
    for (const [name, path] of [["preferences", preference], ["roster", roster], ["primary session", primarySession], ["sibling session", siblingSecret]]) {
      const result = probe(path);
      check(`macOS sandbox blocks ${name}`, result.status !== 0, `status=${result.status}`);
    }
    const primaryEventRead = probe(primaryEventsSecret);
    const primaryEventWrite = spawnSync(SANDBOX_EXEC, ["-f", profilePath, "/usr/bin/touch", join(primaryEventsDir, "candidate-write")], { encoding: "utf8" });
    check("macOS sandbox blocks external primary events read and write", primaryEventRead.status !== 0 && primaryEventWrite.status !== 0, `read=${primaryEventRead.status} write=${primaryEventWrite.status}`);
    for (const [name, dir] of [
      ["sibling support", siblingSupport],
      ["another comparison", otherWorld],
      ["session workspace", sessionWorkspace],
      ["promotion journal", promotionJournal],
    ]) {
      const read = probe(join(dir, "secret.txt"));
      const write = spawnSync(SANDBOX_EXEC, ["-f", profilePath, "/usr/bin/touch", join(dir, "candidate-write")], { encoding: "utf8" });
      check(`macOS sandbox blocks ${name} read and write`, read.status !== 0 && write.status !== 0, `read=${read.status} write=${write.status}`);
    }
    const nestedOwnDir = join(candidateRoot, "nested-candidate");
    mkdirSync(nestedOwnDir, { recursive: true });
    const own = join(nestedOwnDir, "own.txt");
    const writeOwn = spawnSync(SANDBOX_EXEC, ["-f", profilePath, "/bin/zsh", "-c", `echo own > ${JSON.stringify(own)}`], { encoding: "utf8" });
    check("macOS sandbox permits nested candidate writes", writeOwn.status === 0 && readFileSync(own, "utf8").trim() === "own", writeOwn.stderr);
    const supportOwn = join(candidateSupport, "own.txt");
    const writeSupport = spawnSync(SANDBOX_EXEC, ["-f", profilePath, "/bin/zsh", "-c", `echo support > ${JSON.stringify(supportOwn)}`], { encoding: "utf8" });
    check("macOS sandbox permits candidate support writes", writeSupport.status === 0 && readFileSync(supportOwn, "utf8").trim() === "support", writeSupport.stderr);
    const authWrite = spawnSync(SANDBOX_EXEC, ["-f", profilePath, "/bin/zsh", "-c", `echo refreshed > ${JSON.stringify(join(agentHomeDir, "auth.json"))}`], { encoding: "utf8" });
    const settingsWrite = spawnSync(SANDBOX_EXEC, ["-f", profilePath, "/bin/zsh", "-c", `echo changed > ${JSON.stringify(join(agentHomeDir, "settings.json"))}`], { encoding: "utf8" });
    check("macOS sandbox permits copied auth refresh", authWrite.status === 0 && readFileSync(join(agentHomeDir, "auth.json"), "utf8").includes("refreshed"), authWrite.stderr);
    check("macOS sandbox keeps copied settings immutable", settingsWrite.status !== 0 && readFileSync(join(agentHomeDir, "settings.json"), "utf8") === "{}\n", settingsWrite.stderr);

    // A live candidate may poison every .sb it can write, including the old
    // predictable locations, while Evidence/Verify derives and loads a new
    // profile. None of those writes may reach the app-owned profile directory.
    const poison = "(version 1)\n(allow default)\n";
    const candidateRootPoison = join(candidateRoot, "sandbox.sb");
    const candidateSupportPoison = join(candidateSupport, "sandbox.sb");
    // Seed both writable lookalikes deterministically. The long-running child
    // below is the race probe; it should not also be responsible for proving
    // that the scheduler happened to run it before the assertions.
    const poisonSetup = spawnSync(
      SANDBOX_EXEC,
      [
        "-f",
        profilePath,
        "/bin/zsh",
        "-c",
        'printf %s "$POISON" > "$ROOT_POISON"; printf %s "$POISON" > "$SUPPORT_POISON"',
      ],
      {
        cwd: candidateRoot,
        env: { PATH: "/usr/bin:/bin", POISON: poison, ROOT_POISON: candidateRootPoison, SUPPORT_POISON: candidateSupportPoison },
        encoding: "utf8",
      },
    );
    const racer = spawn(
      SANDBOX_EXEC,
      [
        "-f",
        profilePath,
        "/bin/zsh",
        "-c",
        'while :; do printf %s "$POISON" > "$TRUSTED_PROFILE" 2>/dev/null || true; done',
      ],
      {
        cwd: candidateRoot,
        env: { PATH: "/usr/bin:/bin", POISON: poison, TRUSTED_PROFILE: profilePath },
        stdio: "ignore",
        detached: process.platform !== "win32" && !wrappedGate,
      },
    );
    const racerGrouped = process.platform !== "win32" && !wrappedGate;
    const racerGroupExists = () => {
      if (!racerGrouped || !racer.pid) return racer.exitCode === null && racer.signalCode === null;
      try {
        process.kill(-racer.pid, 0);
        return true;
      } catch (error) {
        if (error?.code === "ESRCH") return false;
        if (error?.code === "EPERM") return true;
        throw error;
      }
    };
    let racerError = null;
    racer.once("error", (error) => {
      racerError = error;
    });
    const racerClosed = new Promise((resolve) => {
      racer.once("close", (code, signal) => resolve({ code, signal }));
    });
    const waitForRacerClose = async (timeoutMs) => {
      let timer;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      });
      const result = await Promise.race([racerClosed, timeout]);
      clearTimeout(timer);
      return result;
    };
    let racerStopPromise;
    const stopRacer = (initialSignal = "SIGTERM") => {
      racerStopPromise ??= (async () => {
        let killError = null;
        let killRequested = false;
        let signalSent = null;
        const sendSignal = (signal) => {
          if (!racerGroupExists()) return;
          try {
            if (racerGrouped) {
              process.kill(-racer.pid, signal);
              killRequested = true;
              signalSent = signal;
            } else if (racer.kill(signal)) {
              killRequested = true;
              signalSent = signal;
            }
          } catch (error) {
            killError ??= error;
          }
        };
        sendSignal(initialSignal);
        let closed = await waitForRacerClose(1_500);
        let escalated = false;
        if (!closed) {
          escalated = true;
          sendSignal("SIGKILL");
          closed = await waitForRacerClose(5_000);
        }
        if (!closed || racerGroupExists()) throw new Error("sandbox racer did not close after SIGKILL");
        if (killError) throw killError;
        return { ...closed, error: racerError, killError, killRequested, signalSent, escalated };
      })();
      return racerStopPromise;
    };
    activeRacerStop = stopRacer;
    if (testRacerMarker) writeFileSync(testRacerMarker, `${JSON.stringify({ child: process.pid, descendant: racer.pid })}\n`);
    const lookalikesPoisoned = () =>
      existsSync(candidateRootPoison)
      && existsSync(candidateSupportPoison)
      && readFileSync(candidateRootPoison, "utf8") === poison
      && readFileSync(candidateSupportPoison, "utf8") === poison;
    let evidenceProfile = null;
    let evidenceRead;
    let evidenceWrite;
    let racerResult;
    try {
      if (testFailAfterRacer) throw new Error("injected sandbox racer probe failure");
      if (testHoldAfterRacer) await new Promise(() => {});
      // Wait for both writable lookalikes to be observed before testing the
      // protected profile. A fixed sleep made this assertion scheduler-sensitive
      // on busy hosts without strengthening the write-race coverage.
      const poisonDeadline = Date.now() + 1_000;
      while (!lookalikesPoisoned() && Date.now() < poisonDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      evidenceProfile = writeEvidenceProfile({ root: candidateRoot, profilePath });
      evidenceRead = spawnSync(SANDBOX_EXEC, ["-f", evidenceProfile, "/bin/cat", primarySentinel], { encoding: "utf8" });
      evidenceWrite = spawnSync(SANDBOX_EXEC, ["-f", evidenceProfile, "/usr/bin/touch", primarySentinel], { encoding: "utf8" });
    } finally {
      try {
        racerResult = await stopRacer("SIGKILL");
      } finally {
        activeRacerStop = null;
        if (evidenceProfile) rmSync(evidenceProfile, { force: true });
      }
    }
    const racerStopped = racerResult.killRequested
      && ["SIGINT", "SIGTERM", "SIGHUP", "SIGKILL"].includes(racerResult.signal ?? racerResult.signalSent)
      && !racerResult.error
      && !racerResult.killError;
    const racerDetail = racerResult.error
      ? String(racerResult.error)
      : racerResult.killError
        ? String(racerResult.killError)
        : `signal=${racerResult.signal ?? "none"}`;
    check(
      "candidate can poison only candidate-writable profile lookalikes",
      poisonSetup.status === 0 && lookalikesPoisoned(),
      poisonSetup.stderr,
    );
    check(
      "candidate cannot poison the trusted live profile during a write race",
      racerStopped && readFileSync(profilePath, "utf8").includes(`(deny file-read* (subpath "${realpathSync(primaryRoot)}"))`),
      racerDetail,
    );
    check("Evidence/Verify profile is unique and app-owned", evidenceProfile.startsWith(`${profileDir}/`) && evidenceProfile !== profilePath);
    check("poisoned candidate profiles cannot make Evidence/Verify read or write primary source", evidenceRead.status !== 0 && evidenceWrite.status !== 0 && readFileSync(primarySentinel, "utf8") === "primary source\n", `read=${evidenceRead.status} write=${evidenceWrite.status}`);
  } else if (requireLive) {
    check(
      "required macOS live sandbox probes are available",
      false,
      `live sandbox probes are required but unavailable: ${String(canApply.stderr).trim() || `status=${canApply.status}`}`,
    );
  } else {
    console.log(`SKIP  macOS live sandbox probes — ${String(canApply.stderr).trim() || `status=${canApply.status}`}`);
  }
} else if (requireLive) {
  check("required live sandbox probes run on macOS", false, "the required live sandbox gate must run on a macOS runner");
}

if (signalShutdown) await signalShutdown;
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
