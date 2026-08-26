/**
 * Kernel tests for agent-core harness upgrades.
 * No Electron, no API key, no scripts/build.mjs.
 *
 *   npm run test:agent-core
 */
process.env.TERMINA_CORE_TEST = "1";

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const core = await import("../agent-core/main.ts");

const {
  confinePath,
  matchGlob,
  grepFiles,
  globFiles,
  scanSkills,
  formatSkillIndex,
  formatProjectInstructions,
  formatUserInstructions,
  formatEnvironment,
  formatStub,
  parseMaxTurns,
  reproFor,
  toRequest,
  planPruneStubs,
  readProjectFile,
  writeProjectFile,
  nestedAgentsPointer,
  parseOffset,
  validateGrepPattern,
  buildCachedPrefix,
  replaySessionRecords,
  prepareSessionStream,
  sidecarStartFor,
  isDirectRun,
  tracesDirFor,
  retainTraceFiles,
  isValidTerminalId,
  capTail,
  readFileResult,
  buildFrozenSystem,
  traceRecord,
  isDirectRunFrom,
  hashSystem,
  webSearch,
  parseSearchResults,
} = core;

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + String(detail).slice(0, 240) : ""}`);
};

const root = mkdtempSync(join(tmpdir(), "agent-core-"));
const leftovers = [root];
const cleanup = () => {
  for (const p of leftovers) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
};
process.on("exit", cleanup);

writeFileSync(join(root, "ok.txt"), "hello");
mkdirSync(join(root, "pkg", "src"), { recursive: true });
writeFileSync(join(root, "pkg", "src", "a.ts"), "export const a = 1;\n");
writeFileSync(join(root, "pkg", "AGENTS.md"), "# pkg rules\n");
writeFileSync(join(root, "AGENTS.md"), "# root\n");
mkdirSync(join(root, "node_modules", "x"), { recursive: true });
writeFileSync(join(root, "node_modules", "x", "hid.ts"), "secret\n");
writeFileSync(join(root, "root.ts"), "export const root = 1;\n");

check("jail /etc/passwd fails", confinePath(root, "/etc/passwd").ok === false);
check("jail ../ outside fails", confinePath(root, "..").ok === false);
check("jail foo/../../etc/passwd fails", confinePath(root, "foo/../../etc/passwd").ok === false);
check("jail relative in-cwd succeeds", confinePath(root, "ok.txt").ok === true);
check("jail absolute /etc/passwd fails", confinePath(root, "/etc/passwd").ok === false);

const skillDir = mkdtempSync(join(tmpdir(), "agent-core-skill-"));
leftovers.push(skillDir);
const skillFile = join(skillDir, "SKILL.md");
writeFileSync(skillFile, "---\nname: demo\ndescription: d\n---\nbody\n");
const skillReal = realpathSync(skillFile);
const allow = new Set([skillReal]);
check("allow-set skill outside cwd is readable", confinePath(root, skillFile, { allow }).ok === true);
check("sibling next to allow-set skill is not readable", confinePath(root, join(skillDir, "other.md"), { allow }).ok === false);
check("write_file to allow path fails", writeProjectFile(root, skillFile, "nope").isError === true);

mkdirSync(join(root, "inner"), { recursive: true });
symlinkSync(join(root, "inner"), join(root, "inside-link"));
const insideWrite = writeProjectFile(root, "inside-link/new.txt", "ok");
check("symlink parent inside cwd succeeds", insideWrite.isError === false);
symlinkSync("/tmp", join(root, "out-link"));
check("symlink parent outside cwd rejects", writeProjectFile(root, "out-link/new.txt", "x").isError === true);
symlinkSync(join(root, "missing-target"), join(root, "dangle"));
const dangleWrite = writeProjectFile(root, "dangle/new.txt", "x");
check("dangling parent symlink rejects", dangleWrite.isError === true && dangleWrite.content.includes("cannot resolve"));
check("dangling parent confinePath fails closed", confinePath(root, "dangle/new.txt").ok === false);
check("dangling symlink itself fails closed", confinePath(root, "dangle").ok === false);

const big = Buffer.alloc(50 * 1024, 97);
writeFileSync(join(root, "big.txt"), big);
const first = readProjectFile(root, { path: "big.txt", offset: 0 });
check("read offset 0 truncates with next offset", !first.isError && first.content.includes("read_file offset "));
const next = Number((first.content.match(/offset (\d+)/) || [])[1]);
const second = readProjectFile(root, { path: "big.txt", offset: next });
check("read second offset returns more bytes", !second.isError && second.content.length > 0);
check("offset past EOF is empty success", readProjectFile(root, { path: "big.txt", offset: 5_000_000 }).content === "");
check("offset nope errors", readProjectFile(root, { path: "ok.txt", offset: "nope" }).isError === true);
check("offset infinity errors", readProjectFile(root, { path: "ok.txt", offset: Infinity }).isError === true);
check("offset unsafe integer errors", typeof parseOffset(Number.MAX_SAFE_INTEGER + 1) === "object");
writeFileSync(join(root, "bin.dat"), Buffer.from([1, 0, 2, 3]));
check("NUL in first 4 KB errors", readProjectFile(root, { path: "bin.dat" }).isError === true);
check("readFileResult does not require whole file API", !readFileResult(join(root, "ok.txt"), 0).isError);

const env1 = formatEnvironment(root, { probes: false });
const env2 = formatEnvironment(root, { probes: false });
check("environment two calls equal", env1 === env2);
check("environment listing JSON and no node_modules", env1.includes("listing:") && env1.includes("\"ok.txt\"") && !env1.includes("node_modules"));
mkdirSync(join(root, "bin"), { recursive: true });
writeFileSync(join(root, "bin", "python3"), "#!/bin/sh\necho HACKED\n", { mode: 0o755 });
const envProbe = formatEnvironment(root, { probes: true });
check("project-local python3 is not executed", !envProbe.includes("HACKED"));

writeFileSync(join(root, "hit.ts"), "alpha unique-token beta\n");
const g = await grepFiles(root, { pattern: "unique-token" });
check("grep matches", g.includes("unique-token") && g.includes("hit.ts"));
check("grep skips node_modules", !(await grepFiles(root, { pattern: "secret" })).includes("hid.ts"));
check("grep empty pattern errors", (await grepFiles(root, { pattern: "" })).startsWith("error:"));
check("grep invalid regex errors", (await grepFiles(root, { pattern: "(" })).startsWith("error:"));
check("grep (a+)+ rejected", validateGrepPattern("(a+)+") !== null);
check("grep (a|aa)+ rejected", validateGrepPattern("(a|aa)+") !== null);
check("grep backref rejected", validateGrepPattern("a\\1") !== null);
check("grep two quantifiers rejected", validateGrepPattern("a+b+") !== null);
check("sidecar grep has no path", sidecarStartFor({ name: "grep", id: "1", input: { path: "src" } }).path === undefined);

const globbed = await globFiles(root, "**/*.ts");
check("glob **/*.ts nested", globbed.includes("pkg/src/a.ts"));
check("glob **/*.ts root-level", globbed.includes("root.ts") && globbed.includes("hit.ts"));
check("glob ignores node_modules", !globbed.includes("hid.ts"));
check("glob brace errors", (await globFiles(root, "{a,b}")).startsWith("error:"));
check("glob overlong errors", (await globFiles(root, "a".repeat(300))).startsWith("error:"));
check("matchGlob repeated ** terminates", matchGlob("**/**/*.ts", "pkg/src/a.ts") === true);
check("sidecar glob has no path", sidecarStartFor({ name: "glob", id: "1", input: {} }).path === undefined);

const parsed = parseSearchResults({
  web: {
    results: [
      { title: "Node &lt;docs&gt;", url: "https://example.com/docs", description: "Official <b>documentation</b>" },
      { title: "Node.js API", url: "https://nodejs.org/api/", description: "" },
      { title: "Skip me", url: "javascript:alert(1)", description: "nope" },
    ],
  },
});
check("search parser keeps https url", parsed[0]?.url === "https://example.com/docs");
check("search parser strips markup", parsed[0]?.title === "Node <docs>" && parsed[0]?.snippet === "Official documentation");
check("search parser keeps second https", parsed[1]?.url === "https://nodejs.org/api/");
check("search parser skips non-http href", parsed.every((h) => h.title !== "Skip me"));

const manyJson = JSON.stringify({
  web: { results: Array.from({ length: 12 }, (_, i) => ({ title: `Hit ${i}`, url: `https://ex.test/${i}`, description: "s" })) },
});
let captured = { url: "", token: "", cache: "" };
const cappedSearch = await webSearch("node docs", {
  apiKey: "test-key",
  fetch: async (url, init) => {
    captured = {
      url,
      token: init.headers["x-subscription-token"] ?? "",
      cache: init.headers["cache-control"] ?? "",
    };
    return { ok: true, status: 200, text: async () => manyJson };
  },
});
check("web_search caps hits at 8", cappedSearch.split("\n").filter((l) => /^\d+\. /.test(l)).length === 8);
check(
  "web_search formats title and url",
  cappedSearch.includes("1. Hit 0") && cappedSearch.includes("https://ex.test/0"),
);
const capturedUrl = new URL(captured.url);
check(
  "web_search uses Brave JSON endpoint",
  capturedUrl.origin + capturedUrl.pathname === "https://api.search.brave.com/res/v1/web/search" &&
    capturedUrl.searchParams.get("q") === "node docs" &&
    capturedUrl.searchParams.get("count") === "8" &&
    capturedUrl.searchParams.get("result_filter") === "web",
);
check("web_search sends subscription token", captured.token === "test-key");
check("web_search sends cache-control no-cache", captured.cache === "no-cache");

check("web_search empty query errors", (await webSearch("")).startsWith("error:"));
check("web_search overlong query errors", (await webSearch("a".repeat(300))).startsWith("error:"));
check("web_search too many words errors", (await webSearch("w ".repeat(51))).includes("50 words"));
check("web_search missing key errors", (await webSearch("q", { apiKey: "" })).includes("BRAVE_API_KEY"));
check("web_search control-char key errors", (await webSearch("q", { apiKey: "abc\nxyz" })).includes("invalid"));
check(
  "web_search HTTP error",
  (await webSearch("q", { apiKey: "k", fetch: async () => ({ ok: false, status: 403, text: async () => "nope" }) })).includes("HTTP 403"),
);
check(
  "web_search no results",
  (await webSearch("q", { apiKey: "k", fetch: async () => ({ ok: true, status: 200, text: async () => "{}" }) })) === "(no results)",
);
check(
  "web_search invalid JSON errors",
  (await webSearch("q", { apiKey: "k", fetch: async () => ({ ok: true, status: 200, text: async () => "<html></html>" }) })).includes("invalid JSON"),
);
check(
  "web_search oversized JSON errors",
  (
    await webSearch("q", {
      apiKey: "k",
      fetch: async () => ({ ok: true, status: 200, text: async () => "x".repeat(512_001) }),
    })
  ).includes("too large"),
);
check(
  "web_search timeout",
  (await webSearch("q", { apiKey: "k", timeoutMs: 40, fetch: () => new Promise(() => {}) })).startsWith("error: search timed out"),
);
check("sidecar web_search has no path", sidecarStartFor({ name: "web_search", id: "1", input: { path: "src" } }).path === undefined);
check(
  "reproFor web_search quotes query",
  (reproFor({ id: "1", name: "web_search", input: { query: "foo 'bar'" } }) ?? "").includes("'\\''"),
);

mkdirSync(join(root, ".agents", "skills", "demo"), { recursive: true });
writeFileSync(join(root, ".agents", "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: from project\n---\n");
const userSkills = mkdtempSync(join(tmpdir(), "agent-core-user-skills-"));
leftovers.push(userSkills);
mkdirSync(join(userSkills, "demo"), { recursive: true });
writeFileSync(join(userSkills, "demo", "SKILL.md"), "---\nname: demo\ndescription: from user\n---\n");
mkdirSync(join(root, ".agents", "skills", "amp"), { recursive: true });
writeFileSync(join(root, ".agents", "skills", "amp", "SKILL.md"), "---\nname: a&b\ndescription: x<y\n---\n");
const scanned = scanSkills([userSkills, join(root, ".agents", "skills")]);
const demo = scanned.skills.find((s) => s.name === "demo");
check("later project skill overrides user-global", demo?.description === "from project");
const xml = formatSkillIndex(scanned.skills);
check("XML-special name escaped", xml.includes("a&amp;b") && xml.includes("x&lt;y"));
check("missing skill dirs silent", scanSkills([join(root, "no-such-skills")]).skills.length === 0);

const outside = mkdtempSync(join(tmpdir(), "agent-core-out-"));
leftovers.push(outside);
writeFileSync(join(outside, "AGENTS.md"), "escape\n");
try {
  rmSync(join(root, "escape-agents"));
} catch {
  /* none */
}
symlinkSync(join(outside, "AGENTS.md"), join(root, "escape-agents.md"));
// project-scoped nested pointer uses realpath; a cwd file that is a symlink to outside AGENTS.md
symlinkSync(join(outside, "AGENTS.md"), join(root, "pkg", "escaped.md"));
check("nested pointer skip at cwd file", nestedAgentsPointer(root, join(root, "ok.txt")) === null);

check("project AGENTS.md under cap has no overflow", !formatProjectInstructions("# hi\n").includes("truncated"));
const longMd = `${"para\n\n".repeat(5)}${"x".repeat(30_000)}`;
const longAgents = formatProjectInstructions(longMd);
check("project AGENTS.md over cap overflow note", longAgents.includes("truncated") && longAgents.includes("read AGENTS.md with read_file"));
check("project over cap does not claim omitted tail", !longAgents.includes("x".repeat(1000)));
check("user-global over cap names absolute path", formatUserInstructions("y".repeat(10_000), "/abs/AGENTS.md").includes("/abs/AGENTS.md"));
check("user-global under cap no overflow", !formatUserInstructions("short", "/abs/AGENTS.md").includes("truncated"));

check("nested pointer on pkg file", (nestedAgentsPointer(root, join(root, "pkg", "src", "a.ts")) ?? "").includes("pkg/AGENTS.md"));
check("nested pointer skip on AGENTS.md itself", nestedAgentsPointer(root, join(root, "pkg", "AGENTS.md")) === null);
check("read_file prepends nested pointer", readProjectFile(root, { path: "pkg/src/a.ts" }).content.startsWith("[package instructions:"));
check(
  "read nested AGENTS.md has no pointer",
  !readProjectFile(root, { path: "pkg/AGENTS.md" }).content.startsWith("[package instructions:"),
);

check("parseMaxTurns missing → 80", parseMaxTurns(undefined) === 80);
check("parseMaxTurns 2", parseMaxTurns("2") === 2);
check("parseMaxTurns 0", parseMaxTurns("0") === 80);
check("parseMaxTurns -1", parseMaxTurns("-1") === 80);
check("parseMaxTurns 2.5", parseMaxTurns("2.5") === 80);
check("parseMaxTurns nope", parseMaxTurns("nope") === 80);

const stub = formatStub({ chars: 12, tool: "grep", sseq: 7, repro: "grep 'x'" });
check("formatStub includes storageSeq and repro", stub.includes("storageSeq 7") && stub.includes("reproduce: grep 'x'"));
const req = toRequest([
  {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "1", content: "hi", stubbed: true, repro: "x", chars: 3 }],
    tokens: 1,
    sseq: 1,
  },
]);
const reqJson = JSON.stringify(req);
check("toRequest strips stubbed/repro/chars", reqJson.includes('"content":"hi"') && !reqJson.includes("stubbed"));
check("reproFor grep includes pattern", (reproFor({ id: "1", name: "grep", input: { pattern: "abc" } }) ?? "").includes("abc"));
check(
  "reproFor quotes apostrophe",
  (reproFor({ id: "1", name: "bash", input: { command: "echo 'hi'" } }) ?? "").includes("'\\''"),
);
check(
  "reproFor newline becomes space",
  !(reproFor({ id: "1", name: "bash", input: { command: "echo\nhi" } }) ?? "").includes("\n"),
);

check(
  "planPruneStubs no-ops under high-water",
  planPruneStubs([{ role: "user", content: "hi", tokens: 10 }], { systemTokens: 10, usable: 100_000, protectTokens: 4_000 })
    .length === 0,
);

const tools = [
  { name: "a", description: "a", input_schema: { type: "object", properties: {} } },
  { name: "b", description: "b", input_schema: { type: "object", properties: {} } },
];
const prefix1 = buildCachedPrefix("sys", tools);
const prefix2 = buildCachedPrefix("sys", tools);
check("buildCachedPrefix deep-equal", JSON.stringify(prefix1) === JSON.stringify(prefix2));
check("buildCachedPrefix top-level automatic cache", prefix1.cache_control?.type === "ephemeral");
check("buildCachedPrefix system marker", prefix1.system[0]?.cache_control?.type === "ephemeral");
check("buildCachedPrefix last tool copy", prefix1.tools[1]?.cache_control?.type === "ephemeral");
check("buildCachedPrefix does not mutate tools", tools[1].cache_control === undefined);

check("sidecar write maps to write", sidecarStartFor({ name: "write_file", id: "9", input: { path: "a.ts" } }).toolName === "write");
check("sidecar read_file has no path", sidecarStartFor({ name: "read_file", id: "9", input: { path: "a.ts" } }).path === undefined);

const utf = "é".repeat(30);
const capped = capTail(utf, 8, "bash 'x'");
check("capTail uses byte tail and repro marker", capped.includes("early output truncated") && capped.includes("reproduce:"));

const handoff = "<context-handoff>\nkeep\n</context-handoff>";
const sessionLines = [
  JSON.stringify({ storageSeq: 1, type: "message", message: { role: "user", content: "old1" } }),
  JSON.stringify({
    storageSeq: 2,
    type: "message",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "BIG".repeat(100), tool: "bash", repro: "bash x" }] },
  }),
  JSON.stringify({ storageSeq: 3, type: "message", message: { role: "user", content: "tail" } }),
  JSON.stringify({ storageSeq: 4, type: "message", message: { role: "user", content: handoff } }),
  JSON.stringify({ storageSeq: 5, type: "revision", kind: "summarize", evicted: 2, summarySseq: 4 }),
].join("\n");
const replayed = replaySessionRecords(sessionLines);
check("summarize replay handoff first", replayed.ok && replayed.messages[0]?.content === handoff);
check("summarize replay keeps tail", replayed.ok && replayed.messages[1]?.content === "tail");

const pruneLines = [
  JSON.stringify({
    storageSeq: 1,
    type: "message",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "BODY", tool: "bash", repro: "bash x" }] },
  }),
  JSON.stringify({ storageSeq: 2, type: "revision", kind: "prune", targets: [{ sseq: 1, blockIndex: 0 }] }),
].join("\n");
const pruned = replaySessionRecords(pruneLines);
check(
  "prune replay uses formatStub",
  pruned.ok && String(pruned.messages[0]?.content[0]?.content ?? "").includes("storageSeq 1"),
);

const truncLines = [
  JSON.stringify({ storageSeq: 1, type: "message", message: { role: "user", content: "drop" } }),
  JSON.stringify({ storageSeq: 2, type: "message", message: { role: "user", content: "keep" } }),
  JSON.stringify({ storageSeq: 3, type: "revision", kind: "truncate", dropped: 1 }),
].join("\n");
const truncated = replaySessionRecords(truncLines);
check("truncate replay preserves boundary", truncated.ok && truncated.messages.length === 1 && truncated.messages[0]?.content === "keep");

const sess = join(root, "term-1.session.jsonl");
writeFileSync(sess, sessionLines);
prepareSessionStream(sess, "fresh");
check("fresh session stream truncates file", readFileSync(sess, "utf8") === "");

check("duplicate storageSeq fails resume", replaySessionRecords(`${sessionLines}\n${JSON.stringify({ storageSeq: 1, type: "message", message: { role: "user", content: "x" } })}`).ok === false);
check("non-positive storageSeq fails", replaySessionRecords(JSON.stringify({ storageSeq: 0, type: "message", message: { role: "user", content: "x" } })).ok === false);
check("truncated final line ignored", replaySessionRecords(`${JSON.stringify({ storageSeq: 1, type: "message", message: { role: "user", content: "ok" } })}\n{not-json`).ok === true);

check("invalid terminal id rejected", isValidTerminalId("../evil") === false);
check("tracesDirFor invalid id is null", tracesDirFor(root, "../evil") === null);
const tdir = join(root, "traces");
mkdirSync(tdir);
writeFileSync(join(tdir, "turn-10.json"), "{}");
writeFileSync(join(tdir, "turn-2.json"), "{}");
writeFileSync(join(tdir, "noise.txt"), "x");
const kept = retainTraceFiles(tdir, 1);
check("trace retention numeric", kept.includes("turn-10.json") && !kept.includes("turn-2.json"));

mkdirSync(join(root, "cycle", "a"), { recursive: true });
try {
  symlinkSync(join(root, "cycle"), join(root, "cycle", "a", "loop"));
} catch {
  /* windows */
}
const cyc = await globFiles(join(root, "cycle"), "**/*");
check("in-root symlink cycle terminates", typeof cyc === "string");

const outSkill = join(outside, "SKILL.md");
writeFileSync(outSkill, "---\nname: out\ndescription: no\n---\n");
mkdirSync(join(root, ".agents", "skills", "link"), { recursive: true });
try {
  symlinkSync(outSkill, join(root, ".agents", "skills", "link", "SKILL.md"));
} catch {
  /* ignore */
}
const scannedLink = scanSkills([join(root, ".agents", "skills")]);
check("skill file symlink outside scan root omitted", !scannedLink.skills.some((s) => s.name === "out"));

check("import does not count as direct run", isDirectRun() === false);

const unicodeDir = mkdtempSync(join(tmpdir(), "agent-core-uni-"));
leftovers.push(unicodeDir);
writeFileSync(join(unicodeDir, "ä.txt"), "a");
writeFileSync(join(unicodeDir, "b.txt"), "b");
const listing = formatEnvironment(unicodeDir, { probes: false });
check("unicode listing present", listing.includes("ä.txt") && listing.includes("b.txt"));

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "agent-core", "main.ts");
const banner = await new Promise((resolve) => {
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", src], {
    env: { ...process.env, TERMINA_CORE_TEST: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    resolve(out);
  }, 3000);
  child.stdout.on("data", (d) => {
    out += d.toString();
    if (out.includes("termina agent-core")) {
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve(out);
    }
  });
  child.on("exit", () => {
    clearTimeout(timer);
    resolve(out);
  });
});
check("direct source starts even with TERMINA_CORE_TEST=1", String(banner).includes("termina agent-core"));

check("grep lookaround (?=) rejected", validateGrepPattern("a(?=b)") !== null);
check("grep lookaround (?!) rejected", validateGrepPattern("a(?!b)") !== null);
check("grep lookbehind (?<=) rejected", validateGrepPattern("a(?<=b)") !== null);
check("grep lookbehind (?<!) rejected", validateGrepPattern("a(?<!b)") !== null);
check(
  "grep timeout note",
  (await grepFiles(root, { pattern: "unique-token" }, { budgetMs: 0 })).includes("timed out"),
);

writeFileSync(join(root, "many.txt"), Array.from({ length: 60 }, (_, i) => `hit-line-${i}`).join("\n"));
check("grep caps hits", (await grepFiles(root, { pattern: "hit-line" })).split("\n").length <= 50);

const parentDir = mkdtempSync(join(tmpdir(), "agent-core-parent-"));
leftovers.push(parentDir);
writeFileSync(join(parentDir, "AGENTS.md"), "PARENT-ONLY-TEXT\n");
const childDir = join(parentDir, "proj");
mkdirSync(childDir);
const childFrozen = buildFrozenSystem({
  cwd: childDir,
  userAgentsPath: null,
  userSkillDir: null,
  probes: false,
});
check("ancestor AGENTS.md is not loaded", !childFrozen.system.includes("PARENT-ONLY-TEXT"));
check("missing project AGENTS.md omits block", !childFrozen.system.includes("<project-instructions>"));
check("missing user-global omitted", !childFrozen.system.includes("<user-instructions>"));

const escapedCwd = mkdtempSync(join(tmpdir(), "agent-core-esc-"));
leftovers.push(escapedCwd);
symlinkSync(join(outside, "AGENTS.md"), join(escapedCwd, "AGENTS.md"));
const escapedFrozen = buildFrozenSystem({
  cwd: escapedCwd,
  userAgentsPath: null,
  userSkillDir: null,
  probes: false,
});
check(
  "project AGENTS.md symlink outside omitted",
  !escapedFrozen.system.includes("escape") && !escapedFrozen.system.includes("<project-instructions>"),
);

const skillCwd = mkdtempSync(join(tmpdir(), "agent-core-skillroot-"));
leftovers.push(skillCwd);
mkdirSync(join(skillCwd, ".agents"), { recursive: true });
const foreignSkills = mkdtempSync(join(tmpdir(), "agent-core-foreign-skills-"));
leftovers.push(foreignSkills);
mkdirSync(join(foreignSkills, "sneaky"));
writeFileSync(join(foreignSkills, "sneaky", "SKILL.md"), "---\nname: sneaky\ndescription: no\n---\n");
symlinkSync(foreignSkills, join(skillCwd, ".agents", "skills"));
const skillRootFrozen = buildFrozenSystem({
  cwd: skillCwd,
  userAgentsPath: null,
  userSkillDir: null,
  probes: false,
});
check("project skill-root symlink outside not scanned", !skillRootFrozen.system.includes("sneaky"));

const userHome = mkdtempSync(join(tmpdir(), "agent-core-user-home-"));
leftovers.push(userHome);
writeFileSync(join(userHome, "AGENTS.md"), "USER-PREF-LINE\n");
mkdirSync(join(userHome, "skills", "u"), { recursive: true });
writeFileSync(join(userHome, "skills", "u", "SKILL.md"), "---\nname: uskill\ndescription: udesc\n---\n");
const withUser = buildFrozenSystem({
  cwd: root,
  userAgentsPath: join(userHome, "AGENTS.md"),
  userSkillDir: join(userHome, "skills"),
  probes: false,
});
const userPos = withUser.system.indexOf("USER-PREF-LINE");
const skillPos = withUser.system.indexOf("<skill-index>");
const projPos = withUser.system.indexOf("<project-instructions>");
check("user-global before skill index", userPos >= 0 && userPos < skillPos);
check("skill index before project", skillPos >= 0 && skillPos < projPos);

const longUser = join(userHome, "long.md");
writeFileSync(longUser, "z".repeat(10_000));
const longFrozen = buildFrozenSystem({
  cwd: root,
  userAgentsPath: longUser,
  userSkillDir: null,
  probes: false,
});
const longReal = realpathSync(longUser);
check("user overflow names absolute path", longFrozen.system.includes(longReal));
check("user overflow allow-set readable", readProjectFile(root, { path: longUser }, longFrozen.allow).isError === false);
check(
  "user overflow path stays outside HTML comment",
  !longFrozen.system.includes(`read_file ${longReal} -->`),
);

const dashPath = "/tmp/foo--bar/AGENTS.md";
const dashNote = formatUserInstructions("y".repeat(10_000), dashPath);
check("user overflow with -- in path stays comment-safe", dashNote.includes(JSON.stringify(dashPath)) && !dashNote.includes("foo--bar/AGENTS.md -->"));

const listRoot = mkdtempSync(join(tmpdir(), "agent-core-list-"));
leftovers.push(listRoot);
for (let i = 0; i < 25; i++) writeFileSync(join(listRoot, `f${String(i).padStart(2, "0")}.txt`), "x");
const listingCap = formatEnvironment(listRoot, { probes: false });
check("listing capped at 20", [...listingCap.matchAll(/"f\d+\.txt"/g)].length === 20);
const jsonRoot = mkdtempSync(join(tmpdir(), "agent-core-json-"));
leftovers.push(jsonRoot);
writeFileSync(join(jsonRoot, 'quot"ed'), "x");
const listingJson = formatEnvironment(jsonRoot, { probes: false });
check("listing JSON-encodes special names", listingJson.includes(JSON.stringify('quot"ed')));

const prevPath = process.env.PATH;
let envMissing = "";
try {
  process.env.PATH = "/nonexistent-agent-core-path";
  envMissing = formatEnvironment(root, { probes: true });
} finally {
  process.env.PATH = prevPath;
}
check("missing trusted probe omits that line", envMissing.includes("node ") && !envMissing.includes("python3") && !envMissing.includes("rustc"));

const noArgs = traceRecord({
  role: "main",
  model: "m",
  status: "ok",
  storageSeqRange: [1, 2],
  toolNames: ["grep"],
  usage: null,
  ttftMs: 1,
  turnMs: 2,
  revisions: 0,
  wasteCause: null,
  systemHash: hashSystem("sys"),
});
const traceJson = JSON.stringify(noArgs);
check("trace record has no tool arguments or paths", !traceJson.includes("args") && !traceJson.includes("pattern") && !Object.hasOwn(noArgs, "input"));
check("trace record keeps tool names only", noArgs.toolNames[0] === "grep" && noArgs.systemHash.length === 16);

const fakeEntry = join(root, "entry.mjs");
writeFileSync(fakeEntry, "");
check("isDirectRunFrom same entry is direct", isDirectRunFrom(pathToFileURL(fakeEntry).href, fakeEntry) === true);
check("isDirectRunFrom different entry is not", isDirectRunFrom(pathToFileURL(fakeEntry).href, join(root, "other.mjs")) === false);

const bundled = join(here, "..", "dist-electron", "agent-core.mjs");
if (existsSync(bundled)) {
  const bundledBanner = await new Promise((resolve) => {
    const child = spawn(process.execPath, [bundled], {
      env: { ...process.env, TERMINA_CORE_TEST: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(out);
    }, 3000);
    child.stdout.on("data", (d) => {
      out += d.toString();
      if (out.includes("termina agent-core")) {
        clearTimeout(timer);
        child.kill("SIGKILL");
        resolve(out);
      }
    });
    child.on("exit", () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
  check("bundled entry starts even with TERMINA_CORE_TEST=1", String(bundledBanner).includes("termina agent-core"));
} else {
  check("bundled entry comparison uses canonical paths", isDirectRunFrom(pathToFileURL(fakeEntry).href, realpathSync(fakeEntry)) === true);
}

const summarizeMissing = replaySessionRecords(
  [
    JSON.stringify({ storageSeq: 1, type: "message", message: { role: "user", content: "old" } }),
    JSON.stringify({ storageSeq: 2, type: "revision", kind: "summarize", evicted: 1 }),
  ].join("\n"),
);
check("summarize without summarySseq fails closed", summarizeMissing.ok === false);

check("sidecar bash has no path", sidecarStartFor({ name: "bash", id: "1", input: { path: "src" } }).path === undefined);
check("sidecar write keeps path", sidecarStartFor({ name: "write_file", id: "1", input: { path: "a.ts" } }).path === "a.ts");

const uniGlob = await globFiles(unicodeDir, "*");
const uniLines = uniGlob.split("\n");
check(
  "bytewise unicode glob order",
  uniLines.indexOf("b.txt") !== -1 && uniLines.indexOf("ä.txt") !== -1 && uniLines.indexOf("b.txt") < uniLines.indexOf("ä.txt"),
);

check("sidecar start is not usage", sidecarStartFor({ name: "read_file", id: "1", input: {} }).t === "tool");

mkdirSync(join(root, "pkg-esc"), { recursive: true });
writeFileSync(join(root, "pkg-esc", "a.ts"), "export {}\n");
symlinkSync(join(outside, "AGENTS.md"), join(root, "pkg-esc", "AGENTS.md"));
check("nested AGENTS.md symlink outside is not advertised", nestedAgentsPointer(root, join(root, "pkg-esc", "a.ts")) === null);

check(
  "explicit read of ignored walk name works",
  !readProjectFile(root, { path: ".agents/skills/demo/SKILL.md" }).isError,
);

writeFileSync(join(root, "skip.bin"), Buffer.from("secret-bin\0more"));
check("grep skips binary NUL files", !(await grepFiles(root, { pattern: "secret-bin" })).includes("skip.bin"));
check("replay reports max storageSeq", replayed.ok && replayed.maxSeq === 5);

const failed = results.filter((r) => !r).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
