/**
 * Kernel tests for agent-core harness upgrades.
 * No Electron, no API key, no scripts/build.mjs.
 *
 *   npm run test:agent-core
 */
process.env.TERMINA_CORE_TEST = "1";

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const core = await import("../agent-core/main.ts");
const host = await import("../agent-core/host.ts");

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
  parsePrintPrompt,
  reproFor,
  toRequest,
  planPruneStubs,
  readProjectFile,
  writeProjectFile,
  editProjectFile,
  nestedAgentsPointer,
  parseOffset,
  validateGrepPattern,
  buildCachedPrefix,
  replaySessionRecords,
  prepareSessionStream,
  sidecarStartFor,
  formatToolAnnounce,
  formatToolFollowup,
  runBash,
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
  WEB_SEARCH_TOOL,
  requestTools,
  placeStreamBlock,
  compactStreamBlocks,
  toProviderBlock,
  resolveSessionFile,
  quarantineSessionFile,
  MAX_SESSION_FILE_BYTES,
  rotateSessionFile,
  sessionRotateStamp,
  sliceSessionText,
  writeForkedSession,
  copySessionImageFiles,
  SLASH_COMMANDS,
  matchingSlashCommands,
  completeSlashLine,
  stampHistoryCache,
  formatOverlay,
  retryAfter,
  parseThinkingCommand,
  thinkingEnabledFor,
  thinkingRequestFor,
  outputTokenBudget,
  fetchUrl,
  fetchUrlError,
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
const rgDir = mkdtempSync(join(tmpdir(), "agent-core-rg-"));
leftovers.push(rgDir);
writeFileSync(join(rgDir, "rg"), "#!/bin/sh\necho \"from-rg.ts:1:rg-hit\"\n");
chmodSync(join(rgDir, "rg"), 0o755);
const prevPathForRg = process.env.PATH;
process.env.PATH = `${rgDir}${delimiter}${prevPathForRg ?? ""}`;
const rgHit = await grepFiles(root, { pattern: "unique-token" });
check("grep uses trusted rg when present", rgHit.includes("from-rg.ts") && rgHit.includes("rg-hit"));
process.env.PATH = prevPathForRg;
const jsHit = await grepFiles(root, { pattern: "unique-token", }, { jsOnly: true });
check("grep jsOnly fallback still matches", jsHit.includes("unique-token") && jsHit.includes("hit.ts"));
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

writeFileSync(join(root, ".gitignore"), "hidden.secret\nskipdir/\n");
writeFileSync(join(root, "hidden.secret"), "gitignore-secret\n");
mkdirSync(join(root, "skipdir"), { recursive: true });
writeFileSync(join(root, "skipdir", "x.ts"), "gitignore-secret\n");
writeFileSync(join(root, "visible.secret"), "keep-secret\n");
const giGrep = await grepFiles(root, { pattern: "gitignore-secret" });
check("grep skips gitignored file", !giGrep.includes("hidden.secret"));
check("grep skips gitignored directory", !giGrep.includes("skipdir"));
check(
  "grep of an explicit gitignored path still reads it",
  (await grepFiles(root, { pattern: "gitignore-secret", path: "hidden.secret" })).includes("hidden.secret"),
);
const giGlob = await globFiles(root, "**/*.ts");
check("glob skips gitignored directory", !giGlob.includes("skipdir/x.ts") && giGlob.includes("hit.ts"));
const envGi = formatEnvironment(root, { probes: false });
check("environment listing omits gitignored names", !envGi.includes("hidden.secret") && envGi.includes("visible.secret"));

writeFileSync(join(root, "edit-me.ts"), "const a = 1;\nconst b = 2;\n");
const edited = editProjectFile(root, "edit-me.ts", "const a = 1;", "const a = 42;");
check("edit unique occurrence", edited.isError === false && readFileSync(join(root, "edit-me.ts"), "utf8").includes("const a = 42;"));
check("edit missing old_text fails", editProjectFile(root, "edit-me.ts", "no-such-text", "x").isError === true);
check("edit non-unique old_text fails", editProjectFile(root, "edit-me.ts", "const", "x").isError === true);
check("edit empty old_text fails", editProjectFile(root, "edit-me.ts", "", "x").isError === true);
check("edit outside cwd fails", editProjectFile(root, "/etc/passwd", "root", "x").isError === true);
writeFileSync(join(root, "dollar.ts"), "cost $1 and done\n");
const dollar = editProjectFile(root, "dollar.ts", "cost $1", "cost $2");
check("edit treats $ in new_text as literal", dollar.isError === false && readFileSync(join(root, "dollar.ts"), "utf8") === "cost $2 and done\n");
const editStart = sidecarStartFor({
  name: "edit",
  id: "e1",
  input: { path: "a.ts", old_text: "old", new_text: "new" },
});
check("sidecar edit maps to edit with path", editStart.toolName === "edit" && editStart.path === "a.ts");
check(
  "sidecar edit carries oldText/newText",
  editStart.edits?.[0]?.oldText === "old" && editStart.edits?.[0]?.newText === "new",
);
writeFileSync(join(root, "many.ts"), "foo foo foo\n");
const replaced = editProjectFile(root, "many.ts", "foo", "bar", true);
check("replace_all counts three", replaced.isError === false && replaced.content.includes("3 replacements"));
check("replace_all writes every occurrence", readFileSync(join(root, "many.ts"), "utf8") === "bar bar bar\n");
check("replace_all omits sidecar edits", sidecarStartFor({
  name: "edit",
  id: "e2",
  input: { path: "many.ts", old_text: "foo", new_text: "bar", replace_all: true },
}).edits === undefined);
const noneReplace = editProjectFile(root, "many.ts", "zzz", "q", true);
check("replace_all zero matches errors", noneReplace.isError === true);
const stillUnique = editProjectFile(root, "many.ts", "bar", "baz");
check("unique default still errors on duplicates", stillUnique.isError === true && stillUnique.content.includes("not unique"));
check(
  "tool announce shows edit path",
  formatToolAnnounce({ id: "1", name: "edit", input: { path: "a.ts" } }) === "[edit a.ts]",
);
check(
  "tool followup counts grep hits",
  formatToolFollowup({ id: "1", name: "grep", input: {} }, { result: { content: "a:1:x\nb:2:y" }, isError: false }) ===
    "(2 hits)\n",
);

const echo = await runBash("echo hello-core", { cwd: root });
check("bash echo succeeds", echo.isError === false && echo.content.includes("hello-core"));
const largeBash = await runBash(`${JSON.stringify(process.execPath)} -e 'process.stdout.write("x".repeat(30000))'`, { cwd: root });
check("bash keeps a bounded tail with a marker", Buffer.byteLength(largeBash.content) < 22 * 1024 && largeBash.content.includes("early output truncated"));
const t0 = Date.now();
let stopBash = false;
const killed = runBash("sleep 8", { cwd: root, timeoutMs: 20_000, shouldStop: () => stopBash });
setTimeout(() => {
  stopBash = true;
}, 120);
const killedGot = await killed;
check("bash interrupt returns quickly", Date.now() - t0 < 3000);
check("bash interrupt is an error", killedGot.isError === true);

const hostDir = mkdtempSync(join(tmpdir(), "agent-core-host-"));
leftovers.push(hostDir);
const hostId = "term-1";
const hostBridge = "core-test-bridge";
writeFileSync(join(hostDir, `verify-${hostId}.md`), "verify-body");
writeFileSync(join(hostDir, `edits-${hostId}.md`), "edits-body");
const ctx = host.readContextFiles(hostDir, hostId);
check("context concatenates verify and edits", ctx.includes("verify-body") && ctx.includes("edits-body") && ctx.includes("---"));
check("context skips missing mailbox", !ctx.includes("mailbox"));
writeFileSync(join(hostDir, `verify-${hostId}.md`), "x".repeat(host.HOST_CONTEXT_BYTES + 100));
const cappedContext = host.readContextFiles(hostDir, hostId);
check("host context has a total byte cap", Buffer.byteLength(cappedContext) === host.HOST_CONTEXT_BYTES);
check("host context reports truncation", cappedContext.endsWith("[host context truncated]"));
const promptName = host.promptFileName(hostId, hostBridge, "abcd1234");
const written = host.writePromptPayload(hostDir, hostId, promptName, { prompt: "do work", context: ctx });
check("prompt payload writes a plain filename", written === promptName && existsSync(join(hostDir, promptName)));
const payload = JSON.parse(readFileSync(join(hostDir, promptName), "utf8"));
check("prompt payload keeps prompt and context", payload.prompt === "do work" && payload.context.includes("verify-body"));
const ackId = "ack-req-1";
const ackWait = host.waitForAck(hostDir, hostId, ackId, 1000, hostBridge);
setTimeout(() => {
  writeFileSync(join(hostDir, `ack-${hostId}-${ackId}.json`), JSON.stringify({ ok: true, token: "tok-1" }));
}, 80);
const ackGot = await ackWait;
check("waitForAck claims a successful ack", ackGot?.ok === true && ackGot?.token === "tok-1");
check("waitForAck removes the ack file", !existsSync(join(hostDir, `ack-${hostId}-${ackId}.json`)));
const missed = await host.waitForAck(hostDir, hostId, "missing-ack", 120, hostBridge);
check("waitForAck times out to null", missed === null);
writeFileSync(
  join(hostDir, `startup-control-${hostId}.json`),
  JSON.stringify({ opId: "op-1", action: "structured", content: [{ type: "text", text: "do the task" }] }),
);
const control = host.consumeStartupControl(hostDir, hostId, hostBridge);
check("startup-control structured is consumed", control?.action === "structured" && host.structuredStartupText(control) === "do the task");
check("startup-control file is claimed away", !existsSync(join(hostDir, `startup-control-${hostId}.json`)));
writeFileSync(join(hostDir, "startup-control.json"), JSON.stringify({ opId: "op-2", action: "prefill", text: "draft" }));
const generic = host.consumeStartupControl(hostDir, hostId, hostBridge);
check("startup-control generic prefill", generic?.action === "prefill" && generic.text === "draft");
const png1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const imgDir = mkdtempSync(join(tmpdir(), "agent-core-img-"));
leftovers.push(imgDir);
const attached = host.appendPendingImage(imgDir, hostId, png1x1, "image/png", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
check("appendPendingImage writes a pending png", attached.ok && attached.count === 1 && existsSync(join(imgDir, attached.name)));
check("peekPendingImageCount sees the file", host.peekPendingImageCount(imgDir, hostId) === 1);
const consumed = host.consumePendingImages(imgDir, hostId);
check("consumePendingImages returns bytes and drops the list", consumed.length === 1 && consumed[0]?.bytes.length === png1x1.length && host.peekPendingImageCount(imgDir, hostId) === 0);
const sessImg = join(imgDir, "core-imgtest.jsonl");
writeFileSync(sessImg, "");
const stored = host.persistLoadedImages(sessImg, consumed);
check("persistLoadedImages writes a sidecar file", stored[0]?.name === "core-imgtest-img-1.png" && existsSync(join(imgDir, "core-imgtest-img-1.png")));
const expanded = host.expandFileImageSource({ type: "file", name: stored[0].name, media_type: "image/png" }, [imgDir]);
check("expandFileImageSource reads base64", expanded?.type === "base64" && typeof expanded.data === "string" && expanded.data.length > 0);
const missingImg = host.expandFileImageSource({ type: "file", name: "core-imgtest-img-1.png", media_type: "image/png" }, [join(imgDir, "nope")]);
check("expandFileImageSource jails the path", missingImg === null);
const evilName = "image-term-1-evil.png";
try {
  symlinkSync("/etc/passwd", join(imgDir, evilName));
  writeFileSync(join(imgDir, `images-${hostId}.json`), JSON.stringify({ images: [{ name: evilName, mediaType: "image/png" }] }));
  const evilGot = host.consumePendingImages(imgDir, hostId);
  check(
    "consumePendingImages skips a symlink out of the events dir",
    evilGot.length === 0 && !evilGot.some((img) => img.bytes.includes(Buffer.from("root:"))),
  );
} catch (err) {
  check("consumePendingImages skips a symlink out of the events dir", false, err instanceof Error ? err.message : String(err));
}
const structuredImg = host.structuredStartup({
  opId: "op-3",
  action: "structured",
  content: [
    { type: "text", text: "look at this" },
    { name: "core-imgtest-img-1.png", mediaType: "image/png" },
  ],
});
check(
  "structuredStartup keeps image refs",
  structuredImg.text === "look at this" && structuredImg.images[0]?.name === "core-imgtest-img-1.png",
);
const imgReq = toRequest(
  [{ role: "user", content: [{ type: "text", text: "see" }, { type: "image", source: { type: "file", name: stored[0].name, media_type: "image/png" } }], tokens: 1, sseq: 1 }],
  [imgDir],
);
check(
  "toRequest expands a file image to base64",
  Array.isArray(imgReq[0].content) &&
    imgReq[0].content[1]?.type === "image" &&
    imgReq[0].content[1]?.source?.type === "base64",
);
const oversize = host.appendPendingImage(imgDir, hostId, Buffer.alloc(host.MAX_IMAGE_BYTES + 1), "image/png", "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee");
check("appendPendingImage rejects an oversized image", oversize.ok === false);
host.appendPendingImage(imgDir, hostId, png1x1, "image/png", "cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee");
host.appendPendingImage(imgDir, hostId, png1x1, "image/png", "dddddddd-bbbb-cccc-dddd-eeeeeeeeeeee");
host.appendPendingImage(imgDir, hostId, png1x1, "image/png", "eeeeeeee-bbbb-cccc-dddd-eeeeeeeeeeee");
host.appendPendingImage(imgDir, hostId, png1x1, "image/png", "ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee");
const fifth = host.appendPendingImage(imgDir, hostId, png1x1, "image/png", "99999999-bbbb-cccc-dddd-eeeeeeeeeeee");
check("appendPendingImage caps at four", fifth.ok && fifth.count === 4 && host.peekPendingImageCount(imgDir, hostId) === 4);
check(
  "firstPlanText accepts a checkbox list",
  host.firstPlanText("intro\n- [ ] edit src/foo.ts\n")?.includes("- [ ] edit src/foo.ts"),
);
check("firstPlanText ignores prose", host.firstPlanText("hello there") === null);
const planA = "- [ ] one.ts\n";
check("planTextIfChanged emits first list", host.planTextIfChanged(planA, "") === planA);
check("planTextIfChanged silent on identical", host.planTextIfChanged(planA, planA) === null);
check("planTextIfChanged emits a changed list", host.planTextIfChanged("- [ ] two.ts\n", planA)?.includes("two.ts"));
check(
  "visibleAssistantText skips thinking",
  host.visibleAssistantText([
    { type: "thinking", text: "secret" },
    { type: "text", text: "- [ ] task" },
  ]) === "- [ ] task" && host.firstPlanText(host.visibleAssistantText([{ type: "thinking", text: "- [ ] nope" }])) === null,
);

check("web_search is Anthropic server tool", WEB_SEARCH_TOOL.type === "web_search_20250305" && WEB_SEARCH_TOOL.name === "web_search");
const clientPrefix = buildCachedPrefix("sys", [
  { name: "a", description: "a", input_schema: { type: "object" } },
  { name: "b", description: "b", input_schema: { type: "object" } },
]);
const reqTools = requestTools(clientPrefix.tools);
check("requestTools keeps cache on last client tool", reqTools[1]?.cache_control?.type === "ephemeral");
check(
  "requestTools skips web_search for completions providers",
  requestTools(clientPrefix.tools, "xai").every((t) => t.name !== "web_search") &&
    requestTools(clientPrefix.tools, "xai").length === clientPrefix.tools.length,
);
check(
  "requestTools appends web_search without cache_control",
  reqTools[2]?.type === "web_search_20250305" && reqTools[2]?.cache_control === undefined,
);
check("sidecar web_search has no path", sidecarStartFor({ name: "web_search", id: "1", input: { path: "src" } }).path === undefined);
check("sidecar fetch has no path", sidecarStartFor({ name: "fetch", id: "1", input: { url: "https://example.com" } }).path === undefined);
check("fetchUrlError rejects file", Boolean(fetchUrlError("file:///etc/passwd")?.includes("not allowed")));
check("fetchUrlError rejects data", Boolean(fetchUrlError("data:text/plain,hi")?.includes("not allowed")));
check("fetchUrlError allows https", fetchUrlError("https://example.com/x") === null);
const fetchSrv = createServer((req, res) => {
  if (req.url === "/big") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("z".repeat(30_000));
    return;
  }
  if (req.url === "/go") {
    res.writeHead(302, { location: "/ok" });
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("fetched-body");
});
await new Promise((resolve) => fetchSrv.listen(0, "127.0.0.1", resolve));
const fetchPort = fetchSrv.address().port;
const fetched = await fetchUrl(`http://127.0.0.1:${fetchPort}/ok`);
check("fetch loopback in tests", fetched.isError === false && fetched.content === "fetched-body");
const bounced = await fetchUrl(`http://127.0.0.1:${fetchPort}/go`);
check("fetch follows a redirect", bounced.isError === false && bounced.content === "fetched-body");
const bigFetch = await fetchUrl(`http://127.0.0.1:${fetchPort}/big`);
check("fetch caps bytes", bigFetch.isError === false && bigFetch.content.includes("truncated") && Buffer.byteLength(bigFetch.content) < 30_000);
const stopped = await fetchUrl(`http://127.0.0.1:${fetchPort}/ok`, { shouldStop: () => true });
check("fetch interrupt is an error", stopped.isError === true);
fetchSrv.close();
const slots = [];
placeStreamBlock(slots, 1, { type: "text", text: "kept" });
check("stream compact skips holes", compactStreamBlocks(slots).length === 1 && compactStreamBlocks(slots)[0].text === "kept");
check(
  "toProviderBlock strips view keys only",
  JSON.stringify(toProviderBlock({ type: "text", text: "hi", stubbed: true, chars: 2 })).includes("hi") &&
    !JSON.stringify(toProviderBlock({ type: "text", text: "hi", stubbed: true })).includes("stubbed"),
);
check(
  "toProviderBlock keeps thinking",
  toProviderBlock({ type: "thinking", thinking: "abc", signature: "sig" }).thinking === "abc",
);
const unsignedThinking = toRequest([{ role: "assistant", content: [{ type: "thinking", thinking: "abc" }], tokens: 1, sseq: 1 }]);
check("toRequest drops unsigned thinking", unsignedThinking[0]?.content?.length === 0);
const searchReq = toRequest([
  {
    role: "assistant",
    content: [
      { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "x" } },
      {
        type: "web_search_tool_result",
        tool_use_id: "s1",
        content: [{ type: "web_search_result", url: "https://ex.test", title: "t", encrypted_content: "secret" }],
      },
      { type: "text", text: "hi", citations: [{ type: "web_search_result_location", url: "https://ex.test" }] },
    ],
    tokens: 1,
    sseq: 1,
  },
]);
const searchJson = JSON.stringify(searchReq);
check("toRequest keeps server_tool_use", searchJson.includes("server_tool_use") && searchJson.includes("\"query\":\"x\""));
check("toRequest keeps encrypted search content", searchJson.includes("encrypted_content"));
check("toRequest keeps text citations", searchJson.includes("citations") && searchJson.includes("web_search_result_location"));
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
const prunePlan = planPruneStubs(
  [
    {
      role: "user",
      content: [
        { type: "tool_result", content: "a".repeat(8_000) },
        { type: "tool_result", content: "b".repeat(8_000) },
      ],
      tokens: 9_000,
    },
    { role: "user", content: "recent one", tokens: 10 },
    { role: "user", content: "recent two", tokens: 10 },
  ],
  { systemTokens: 0, usable: 10_000, protectTokens: 10 },
);
check("planPruneStubs addresses exact blocks", prunePlan.map((p) => p.blockIndex).join(",") === "0,1");
check("planPruneStubs stubs tool_results", prunePlan.every((p) => p.action === "stub"));
const thinkPlan = planPruneStubs(
  [
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "t".repeat(4_000) },
        { type: "text", text: "hi" },
      ],
      tokens: 9_000,
    },
    { role: "user", content: "recent one", tokens: 10 },
    { role: "user", content: "recent two", tokens: 10 },
  ],
  { systemTokens: 0, usable: 10_000, protectTokens: 10 },
);
check("planPruneStubs drops old thinking", thinkPlan.length === 1 && thinkPlan[0]?.action === "drop" && thinkPlan[0]?.blockIndex === 0);
check(
  "planPruneStubs billed high with small history is a no-op",
  planPruneStubs(
    [
      { role: "user", content: [{ type: "tool_result", content: "a".repeat(8_000) }], tokens: 100 },
      { role: "user", content: "a", tokens: 10 },
      { role: "user", content: "b", tokens: 10 },
    ],
    { systemTokens: 0, usable: 10_000, protectTokens: 10, fillTokens: 9_000 },
  ).length === 0,
);
const thinkReplay = [
  JSON.stringify({
    storageSeq: 1,
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "secret" },
        { type: "text", text: "ok" },
      ],
    },
  }),
  JSON.stringify({
    storageSeq: 2,
    type: "revision",
    kind: "prune",
    targets: [{ sseq: 1, blockIndex: 0, action: "drop" }],
  }),
].join("\n");
const droppedThink = replaySessionRecords(thinkReplay);
check(
  "prune replay drops thinking and matches live",
  droppedThink.ok &&
    droppedThink.messages[0]?.content?.length === 1 &&
    droppedThink.messages[0]?.content[0]?.type === "text" &&
    droppedThink.messages[0]?.content[0]?.text === "ok",
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
check("invalid message content fails resume", replaySessionRecords(JSON.stringify({ storageSeq: 1, type: "message", message: { role: "user", content: {} } })).ok === false);
check("invalid truncate revision fails resume", replaySessionRecords(`${JSON.stringify({ storageSeq: 1, type: "message", message: { role: "user", content: "x" } })}\n${JSON.stringify({ storageSeq: 2, type: "revision", kind: "truncate", dropped: 2 })}`).ok === false);
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

const auth = await import("../agent-core/auth.ts");
const {
  pickHeaders,
  needsRefresh,
  parseTokenResponse,
  parseOauthToken,
  parseModelRef,
  DEFAULT_MODELS,
  modifyProvider,
  resolveAuth,
  runLogin,
  runLogout,
  parseAuthCommand,
  maskSecret,
  authBanner,
  resetAuthCache,
  isOAuthToken,
  requestHeaders,
  extractAccountId,
  defaultLoginMode,
  providerProtocol,
  validateCopilotApiUrl,
  hasStoredCredential,
  hasEnvCredential,
  firstAuthenticatedProvider,
} = auth;
const compat = await import("../agent-core/openai-compat.ts");
const authFile = join(root, "auth.json");
process.env.TERMINA_AUTH_PATH = authFile;
resetAuthCache();

check("pickHeaders oat uses bearer", pickHeaders("sk-ant-oat-secret").authorization === "Bearer sk-ant-oat-secret");
check("pickHeaders oat sets betas", Boolean(pickHeaders("sk-ant-oat-secret")["anthropic-beta"]));
check("pickHeaders api key uses x-api-key", pickHeaders("sk-ant-api-x")["x-api-key"] === "sk-ant-api-x");
check("pickHeaders api key has no bearer", pickHeaders("sk-ant-api-x").authorization === undefined);
check("isOAuthToken sniffs oat", isOAuthToken("prefix-sk-ant-oat-zz") === true);

check("needsRefresh past is true", needsRefresh(Date.now() - 1000) === true);
check("needsRefresh future is false", needsRefresh(Date.now() + 60_000) === false);

check("parseTokenResponse missing access fails", parseTokenResponse({ refresh_token: "r", expires_in: 10 }).ok === false);
check("parseTokenResponse missing refresh fails", parseTokenResponse({ access_token: "a", expires_in: 10 }).ok === false);
const parsedTok = parseTokenResponse({ access_token: "a", refresh_token: "r", expires_in: 3600 }, 1_000_000);
check(
  "parseTokenResponse back-dates expires",
  parsedTok.ok === true && parsedTok.expires === 1_000_000 + 3600 * 1000 - 300_000,
);
check("maskSecret hides the raw token", !maskSecret("sk-ant-oat-abcdefgh").includes("sk-ant-oat-abcd") && maskSecret("sk-ant-oat-abcdefgh").endsWith("efgh"));

modifyProvider("anthropic", () => ({ type: "api_key", key: "stored-key", extra: "keep-me" }));
modifyProvider("other", () => ({ type: "api_key", key: "other-key" }));
modifyProvider("anthropic", (current) => ({ ...current, key: "stored-key-2" }));
const storedFile = JSON.parse(readFileSync(authFile, "utf8"));
check("modifyProvider preserves unrelated root keys", storedFile.other?.key === "other-key");
check("modifyProvider preserves extra entry fields", storedFile.anthropic?.extra === "keep-me");

const prevKey = process.env.ANTHROPIC_API_KEY;
const prevTok = process.env.ANTHROPIC_AUTH_TOKEN;
process.env.ANTHROPIC_API_KEY = "env-api-key";
process.env.ANTHROPIC_AUTH_TOKEN = "env-auth-token";
resetAuthCache();
const storedWins = await resolveAuth("anthropic");
check("stored credential beats env", storedWins.ok && storedWins.token === "stored-key-2" && storedWins.source === "api_key");
runLogout("anthropic");
resetAuthCache();
const envWins = await resolveAuth("anthropic");
check("env ANTHROPIC_API_KEY used when no store", envWins.ok && envWins.envName === "ANTHROPIC_API_KEY" && envWins.token === "env-api-key");
delete process.env.ANTHROPIC_API_KEY;
resetAuthCache();
const altEnv = await resolveAuth("anthropic");
check("env ANTHROPIC_AUTH_TOKEN is second", altEnv.ok && altEnv.envName === "ANTHROPIC_AUTH_TOKEN");
delete process.env.ANTHROPIC_AUTH_TOKEN;
resetAuthCache();
const none = await resolveAuth("anthropic");
check("missing credential fails closed", none.ok === false);
if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
else process.env.ANTHROPIC_API_KEY = prevKey;
if (prevTok === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
else process.env.ANTHROPIC_AUTH_TOKEN = prevTok;

check("parseAuthCommand bare /login asks to pick", "error" in parseAuthCommand("/login") && String(parseAuthCommand("/login").error).includes("pick a provider"));
check("parseAuthCommand bare /logout asks to pick", "error" in parseAuthCommand("/logout") && String(parseAuthCommand("/logout").error).includes("pick a provider"));
check("parseAuthCommand code mode", parseAuthCommand("/login code").mode === "code");
check("parseAuthCommand rejects unknown provider", "error" in parseAuthCommand("/login nope"));
check("banner does not contain raw token", !authBanner({ ok: true, providerId: "anthropic", token: "sk-ant-oat-SUPERSECRET99", kind: "oauth", source: "oauth", baseUrl: "https://api.anthropic.com", headers: {} }).includes("SUPERSECRET"));
const cancelledLogin = new AbortController();
cancelledLogin.abort();
const cancelledResult = await runLogin("anthropic", "browser", {
  write: () => {},
  openUrl: () => {},
  signal: cancelledLogin.signal,
});
check("browser login respects an already-aborted signal", cancelledResult.ok === false && cancelledResult.error === "login cancelled");

const prevTimeout = process.env.TERMINA_TEST_LOGIN_TIMEOUT_MS;
const prevDenyPort = process.env.TERMINA_TEST_REDIRECT_PORT;
process.env.TERMINA_TEST_REDIRECT_PORT = "27323";
let denyOut = "";
const denyP = runLogin("anthropic", "browser", {
  write: (t) => {
    denyOut += t;
  },
  openUrl: () => {},
});
let denyResult;
try {
  const started = Date.now();
  while (!denyOut.includes("authorize:") && Date.now() - started < 2000) await new Promise((r) => setTimeout(r, 20));
  await fetch("http://127.0.0.1:27323/callback?error=access_denied&state=x");
  denyResult = await denyP;
} catch (err) {
  denyResult = { ok: false, error: String(err) };
}
check("oauth access_denied is login cancelled", denyResult.ok === false && denyResult.error === "login cancelled");
process.env.TERMINA_TEST_LOGIN_TIMEOUT_MS = "150";
process.env.TERMINA_TEST_REDIRECT_PORT = "27324";
const timedOut = await runLogin("anthropic", "browser", { write: () => {}, openUrl: () => {} });
check(
  "oauth wait times out as cancelled",
  timedOut.ok === false && String(timedOut.error).includes("login cancelled"),
);
if (prevTimeout === undefined) delete process.env.TERMINA_TEST_LOGIN_TIMEOUT_MS;
else process.env.TERMINA_TEST_LOGIN_TIMEOUT_MS = prevTimeout;
if (prevDenyPort === undefined) delete process.env.TERMINA_TEST_REDIRECT_PORT;
else process.env.TERMINA_TEST_REDIRECT_PORT = prevDenyPort;

const tokenSrv = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => {
    body += c;
  });
  req.on("end", () => {
    let grant = "";
    try {
      grant = JSON.parse(body).grant_type;
    } catch {
      grant = "";
    }
    res.setHeader("content-type", "application/json");
    if (grant === "refresh_token") {
      res.end(JSON.stringify({ access_token: "sk-ant-oat-refreshed99", refresh_token: "refresh-2", expires_in: 3600 }));
      return;
    }
    res.end(JSON.stringify({ access_token: "sk-ant-oat-login99xy", refresh_token: "refresh-1", expires_in: 3600 }));
  });
});
const tokenPort = await new Promise((resolve) => {
  tokenSrv.listen(0, "127.0.0.1", () => resolve(tokenSrv.address().port));
});
const prevTokenUrl = process.env.TERMINA_TEST_TOKEN_URL;
const prevRedir = process.env.TERMINA_TEST_REDIRECT_PORT;
process.env.TERMINA_TEST_TOKEN_URL = `http://127.0.0.1:${tokenPort}/`;
process.env.TERMINA_TEST_REDIRECT_PORT = "27321";
resetAuthCache();
runLogout("anthropic");
let loginOut = "";
const loginP = runLogin("anthropic", "browser", {
  write: (t) => {
    loginOut += t;
  },
  openUrl: () => {},
});
let loginResult;
try {
  const started = Date.now();
  while (!loginOut.includes("authorize:") && Date.now() - started < 2000) await new Promise((r) => setTimeout(r, 20));
  const authUrl = (loginOut.match(/authorize: (\S+)/) || [])[1];
  const state = new URL(authUrl).searchParams.get("state");
  await fetch(`http://127.0.0.1:27321/callback?code=test-code&state=${state}`);
  loginResult = await loginP;
} catch (err) {
  loginResult = { ok: false, error: String(err) };
}
check("login stores oauth credential", loginResult.ok === true);
resetAuthCache();
const afterLogin = await resolveAuth("anthropic");
check(
  "login resolve uses bearer oat",
  afterLogin.ok && afterLogin.kind === "oauth" && afterLogin.headers.authorization?.startsWith("Bearer ") && afterLogin.headers["x-api-key"] === undefined,
);
modifyProvider("anthropic", (current) => ({ ...current, expires: Date.now() - 1 }));
resetAuthCache();
const afterRefresh = await resolveAuth("anthropic");
check(
  "expired oauth refreshes and persists",
  afterRefresh.ok && afterRefresh.token === "sk-ant-oat-refreshed99" && JSON.parse(readFileSync(authFile, "utf8")).anthropic.refresh === "refresh-2",
);
if (prevTokenUrl === undefined) delete process.env.TERMINA_TEST_TOKEN_URL;
else process.env.TERMINA_TEST_TOKEN_URL = prevTokenUrl;
if (prevRedir === undefined) delete process.env.TERMINA_TEST_REDIRECT_PORT;
else process.env.TERMINA_TEST_REDIRECT_PORT = prevRedir;
tokenSrv.close();

check(
  "DEFAULT_MODELS anthropic main is sonnet 5",
  DEFAULT_MODELS.anthropic.main === "claude-sonnet-5" && DEFAULT_MODELS.anthropic.summary === "claude-haiku-4-5",
);
check(
  "DEFAULT_MODELS openai is gpt-5.6 sol/luna",
  DEFAULT_MODELS.openai.main === "gpt-5.6-sol" && DEFAULT_MODELS.openai.summary === "gpt-5.6-luna",
);
check(
  "DEFAULT_MODELS openai-codex is gpt-5.6 sol/luna",
  DEFAULT_MODELS["openai-codex"].main === "gpt-5.6-sol" && DEFAULT_MODELS["openai-codex"].summary === "gpt-5.6-luna",
);
check(
  "DEFAULT_MODELS github-copilot is gpt-5.6 terra/luna",
  DEFAULT_MODELS["github-copilot"].main === "gpt-5.6-terra" && DEFAULT_MODELS["github-copilot"].summary === "gpt-5.6-luna",
);
check(
  "DEFAULT_MODELS xai is grok-4.6",
  DEFAULT_MODELS.xai.main === "grok-4.6" && DEFAULT_MODELS.xai.summary === "grok-4.6",
);
check(
  "DEFAULT_MODELS google is gemini 3.7 flash / 3.5 flash-lite",
  DEFAULT_MODELS.google.main === "gemini-3.7-flash" && DEFAULT_MODELS.google.summary === "gemini-3.5-flash-lite",
);
check(
  "DEFAULT_MODELS openrouter is gpt-5.6 terra/luna",
  DEFAULT_MODELS.openrouter.main === "openai/gpt-5.6-terra" && DEFAULT_MODELS.openrouter.summary === "openai/gpt-5.6-luna",
);
check("parseModelRef grok is xai", parseModelRef("grok-4.6").provider === "xai" && parseModelRef("grok-4.6").model === "grok-4.6");
check(
  "parseModelRef openai-codex prefix",
  parseModelRef("openai-codex/gpt-5.6-sol").provider === "openai-codex" && parseModelRef("openai-codex/gpt-5.6-sol").model === "gpt-5.6-sol",
);
check("parseModelRef provider override", parseModelRef("gpt-5", "openai-codex").provider === "openai-codex");
check("parseModelRef gpt defaults to openai", parseModelRef("gpt-5").provider === "openai");
check("defaultLoginMode xai is device", defaultLoginMode("xai") === "device");
check("defaultLoginMode openai is key", defaultLoginMode("openai") === "key");
check("providerProtocol xai is completions", providerProtocol("xai") === "openai-completions");
check("providerProtocol openai-codex is responses", providerProtocol("openai-codex") === "openai-codex-responses");
check("parseAuthCommand /login xai is device", parseAuthCommand("/login xai").mode === "device" && parseAuthCommand("/login xai").provider === "xai");
check("parseAuthCommand /login key openai", parseAuthCommand("/login key openai").mode === "key" && parseAuthCommand("/login key openai").provider === "openai");
check("parseAuthCommand /login openai-codex", parseAuthCommand("/login openai-codex").provider === "openai-codex" && parseAuthCommand("/login openai-codex").mode === "browser");
check(
  "parseAuthCommand /login openai oauth is Codex",
  parseAuthCommand("/login openai oauth").provider === "openai-codex" && parseAuthCommand("/login openai oauth").mode === "browser",
);
check(
  "parseAuthCommand /login openai key is API key",
  parseAuthCommand("/login openai key").provider === "openai" && parseAuthCommand("/login openai key").mode === "key",
);
check(
  "parseAuthCommand /login anthropic key",
  parseAuthCommand("/login anthropic key").provider === "anthropic" && parseAuthCommand("/login anthropic key").mode === "key",
);
check(
  "parseAuthCommand /login xai oauth is device",
  parseAuthCommand("/login xai oauth").mode === "device" && parseAuthCommand("/login xai oauth").provider === "xai",
);
check(
  "parseAuthCommand is case-insensitive",
  parseAuthCommand("/login OpenAI OAuth").provider === "openai-codex" && parseAuthCommand("/login KEY Anthropic").mode === "key",
);
check("parseAuthCommand google oauth is rejected", "error" in parseAuthCommand("/login google oauth"));
check(
  "parseAuthCommand /logout openai oauth is Codex",
  parseAuthCommand("/logout openai oauth").cmd === "logout" && parseAuthCommand("/logout openai oauth").provider === "openai-codex",
);
check(
  "parseAuthCommand /logout openai key is API key store",
  parseAuthCommand("/logout openai key").provider === "openai",
);
check(
  "parseAuthCommand /login github-copilot is device",
  parseAuthCommand("/login github-copilot").mode === "device" && parseAuthCommand("/login github-copilot").provider === "github-copilot",
);
check(
  "validateCopilotApiUrl allows githubcopilot hosts",
  validateCopilotApiUrl("https://api.individual.githubcopilot.com/") === "https://api.individual.githubcopilot.com",
);
check("validateCopilotApiUrl rejects http", validateCopilotApiUrl("http://api.githubcopilot.com") === null);
check("validateCopilotApiUrl rejects other hosts", validateCopilotApiUrl("https://evil.example/copilot") === null);

const prevOpenAI = process.env.OPENAI_API_KEY;
const prevXai = process.env.XAI_API_KEY;
process.env.OPENAI_API_KEY = "sk-openai-env";
process.env.XAI_API_KEY = "xai-env-key";
resetAuthCache();
const openaiEnv = await resolveAuth("openai");
const xaiEnv = await resolveAuth("xai");
check("OPENAI_API_KEY resolves", openaiEnv.ok && openaiEnv.token === "sk-openai-env" && openaiEnv.headers.authorization === "Bearer sk-openai-env");
check("XAI_API_KEY resolves", xaiEnv.ok && xaiEnv.token === "xai-env-key");
modifyProvider("openai", () => ({ type: "api_key", key: "stored-openai" }));
resetAuthCache();
const openaiStored = await resolveAuth("openai");
check("stored openai key beats env", openaiStored.ok && openaiStored.token === "stored-openai");
runLogout("openai");
if (prevOpenAI === undefined) delete process.env.OPENAI_API_KEY;
else process.env.OPENAI_API_KEY = prevOpenAI;
if (prevXai === undefined) delete process.env.XAI_API_KEY;
else process.env.XAI_API_KEY = prevXai;

const xaiKeep = parseOauthToken(
  { access_token: "new-access", expires_in: 3600 },
  1_000_000,
  { requireRefresh: false, previousRefresh: "old-refresh", defaultExpiresIn: 3600 },
);
check(
  "xai refresh keeps previous refresh token",
  xaiKeep.ok === true && xaiKeep.refresh === "old-refresh" && xaiKeep.access === "new-access",
);

const jwtPayload = Buffer.from(
  JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-99" } }),
).toString("base64url");
const jwt = `eyJhbGciOiJub25lIn0.${jwtPayload}.sig`;
check("extractAccountId reads chatgpt_account_id", extractAccountId(jwt) === "acct-99");
check(
  "codex headers include account id",
  requestHeaders("openai-codex", jwt, { accountId: "acct-99" })["chatgpt-account-id"] === "acct-99" &&
    requestHeaders("openai-codex", jwt).originator === "codex_cli_rs",
);

let keyOut = "";
const keyLogin = await runLogin("google", "key", {
  write: (t) => {
    keyOut += t;
  },
  waitForCode: async () => "gemini-stored-key",
});
resetAuthCache();
const googleStored = await resolveAuth("google");
check("google key login stores api_key", keyLogin.ok === true && googleStored.ok && googleStored.token === "gemini-stored-key");
runLogout("google");

const mapped = compat.toCompletionsMessages("sys", [
  { role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "bash", input: { command: "ls" } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "ok" }] },
]);
check(
  "completions maps tool_use to tool_calls",
  mapped[0].role === "system" &&
    mapped[1].role === "assistant" &&
    mapped[1].tool_calls?.[0]?.id === "call-1" &&
    mapped[2].role === "tool" &&
    mapped[2].tool_call_id === "call-1",
);
const mappedImg = compat.toCompletionsMessages("sys", [
  {
    role: "user",
    content: [
      { type: "text", text: "what is this" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "aaa" } },
    ],
  },
]);
check(
  "completions maps image blocks to image_url",
  Array.isArray(mappedImg[1].content) &&
    mappedImg[1].content[0]?.type === "text" &&
    mappedImg[1].content[1]?.type === "image_url" &&
    String(mappedImg[1].content[1]?.image_url?.url).startsWith("data:image/png;base64,"),
);
const responsesImg = compat.toResponsesInput([
  {
    role: "user",
    content: [
      { type: "text", text: "what is this" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "aaa" } },
    ],
  },
]);
check(
  "responses maps image blocks to input_image",
  responsesImg[0].role === "user" &&
    responsesImg[0].content[1]?.type === "input_image" &&
    String(responsesImg[0].content[1]?.image_url).startsWith("data:image/png;base64,"),
);
const responsesIn = compat.toResponsesInput([
  { role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "bash", input: { command: "ls" } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "ok" }] },
]);
check(
  "responses maps tool_use to function_call",
  responsesIn[0].type === "function_call" && responsesIn[0].call_id === "call-1" && responsesIn[1].type === "function_call_output",
);
const streamResult = compat.completionResultFromEvents(
  [
    { choices: [{ delta: { content: "Hi" } }] },
    {
      choices: [
        {
          delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "bash", arguments: "{\"command\":\"ls\"}" } }] },
          finish_reason: "tool_calls",
        },
      ],
    },
    { usage: { prompt_tokens: 10, completion_tokens: 4 } },
  ],
  () => {},
  Date.now(),
);
check(
  "completion stream collects text and tool_use",
  streamResult.blocks[0]?.type === "text" &&
    streamResult.blocks[0]?.text === "Hi" &&
    streamResult.blocks[1]?.type === "tool_use" &&
    streamResult.blocks[1]?.name === "bash" &&
    streamResult.stopReason === "tool_calls",
);

const deviceSrv = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => {
    body += c;
  });
  req.on("end", () => {
    const params = new URLSearchParams(body);
    res.setHeader("content-type", "application/json");
    if (params.get("grant_type") === "urn:ietf:params:oauth:grant-type:device_code") {
      res.end(JSON.stringify({ access_token: "xai-access-99", refresh_token: "xai-refresh-1", expires_in: 3600 }));
      return;
    }
    res.end(
      JSON.stringify({
        device_code: "dev-1",
        user_code: "ABCD-1234",
        verification_uri: "http://127.0.0.1/device",
        interval: 0,
        expires_in: 60,
      }),
    );
  });
});
const devicePort = await new Promise((resolve) => {
  deviceSrv.listen(0, "127.0.0.1", () => resolve(deviceSrv.address().port));
});
const prevDevice = process.env.TERMINA_TEST_DEVICE_URL;
const prevTok2 = process.env.TERMINA_TEST_TOKEN_URL;
process.env.TERMINA_TEST_DEVICE_URL = `http://127.0.0.1:${devicePort}/`;
process.env.TERMINA_TEST_TOKEN_URL = `http://127.0.0.1:${devicePort}/`;
resetAuthCache();
runLogout("xai");
const xaiLogin = await runLogin("xai", "device", {
  write: () => {},
  openUrl: () => {},
});
resetAuthCache();
const xaiAfter = await resolveAuth("xai");
check(
  "xai device login stores oauth",
  xaiLogin.ok === true && xaiAfter.ok && xaiAfter.kind === "oauth" && xaiAfter.token === "xai-access-99",
);
runLogout("xai");
if (prevDevice === undefined) delete process.env.TERMINA_TEST_DEVICE_URL;
else process.env.TERMINA_TEST_DEVICE_URL = prevDevice;
if (prevTok2 === undefined) delete process.env.TERMINA_TEST_TOKEN_URL;
else process.env.TERMINA_TEST_TOKEN_URL = prevTok2;
deviceSrv.close();

const modelsMod = await import("../agent-core/models.ts");
const {
  parseModelsPayload,
  isChatModel,
  pickDefaultModel,
  parseModelSwitch,
  modelsUrl,
  formatModelBanner,
  formatModelLines,
  formatCatalogLines,
  catalogHeaders,
  loadProviderModels,
  catalogFetchAllowed,
} = modelsMod;

check("isChatModel drops embeddings", isChatModel("text-embedding-3-small", "openai") === false);
check("isChatModel keeps gpt", isChatModel("gpt-5", "openai") === true);
check("isChatModel keeps gpt-4o", isChatModel("gpt-4o", "openai") === true);
check("isChatModel keeps gemini flash", isChatModel("gemini-2.5-flash", "google") === true);
check("isChatModel grok on xai", isChatModel("grok-4.3", "xai") === true);
check("isChatModel grok-image dropped", isChatModel("grok-2-image", "xai") === false);

const openaiList = parseModelsPayload(
  { data: [{ id: "gpt-5" }, { id: "text-embedding-3-small" }, { id: "gpt-4.1-mini" }] },
  "openai",
);
check("parseModelsPayload filters non-chat", openaiList.map((m) => m.id).join(",") === "gpt-5,gpt-4.1-mini");
const anthList = parseModelsPayload(
  { data: [{ id: "claude-sonnet-4-5-20250929", display_name: "Claude Sonnet 4.5" }] },
  "anthropic",
);
check("parseModelsPayload anthropic display name", anthList[0]?.id === "claude-sonnet-4-5-20250929" && anthList[0]?.name === "Claude Sonnet 4.5");
const gemList = parseModelsPayload(
  { models: [{ name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash" }] },
  "google",
);
check("parseModelsPayload strips google models/ prefix", gemList[0]?.id === "gemini-2.5-flash");
const slugList = parseModelsPayload({ models: [{ slug: "gpt-5.4", display_name: "GPT-5.4" }] }, "openai-codex");
check("parseModelsPayload reads Codex slug", slugList[0]?.id === "gpt-5.4");
check(
  "pickDefaultModel prefix match",
  pickDefaultModel(anthList, "claude-sonnet-4-5") === "claude-sonnet-4-5-20250929",
);
check("pickDefaultModel empty is null", pickDefaultModel([], "gpt-5") === null);
check("parseModelSwitch prefix changes provider", parseModelSwitch("xai/grok-4.6", "anthropic").provider === "xai");
check(
  "parseModelSwitch empty tail uses default",
  parseModelSwitch("xai/", "anthropic").provider === "xai" && parseModelSwitch("xai/", "anthropic").model === DEFAULT_MODELS.xai.main,
);
check(
  "parseModelSwitch openrouter keeps vendor/model",
  parseModelSwitch("anthropic/claude-sonnet-4", "openrouter").provider === "openrouter" &&
    parseModelSwitch("anthropic/claude-sonnet-4", "openrouter").model === "anthropic/claude-sonnet-4",
);
check("modelsUrl anthropic uses /v1/models", modelsUrl("anthropic", "https://api.anthropic.com").includes("/v1/models"));
check("modelsUrl openai uses /models", modelsUrl("openai", "https://api.openai.com/v1").endsWith("/models"));
check(
  "modelsUrl openai-codex adds client_version",
  modelsUrl("openai-codex", "https://chatgpt.com/backend-api").includes("/codex/models") &&
    modelsUrl("openai-codex", "https://chatgpt.com/backend-api").includes("client_version="),
);
check(
  "catalogHeaders drop Responses-only fields",
  catalogHeaders({
    authorization: "Bearer x",
    "content-type": "application/json",
    "openai-beta": "responses=experimental",
    originator: "codex_cli_rs",
  }).authorization === "Bearer x" &&
    catalogHeaders({
      authorization: "Bearer x",
      "content-type": "application/json",
      "openai-beta": "responses=experimental",
      originator: "codex_cli_rs",
    })["openai-beta"] === undefined &&
    catalogHeaders({
      authorization: "Bearer x",
      "content-type": "application/json",
      "openai-beta": "responses=experimental",
      originator: "codex_cli_rs",
    })["content-type"] === undefined,
);
check("formatModelBanner marks current", formatModelBanner([{ id: "a" }, { id: "b" }], "b").includes("*b"));
check("formatModelLines stars current", formatModelLines([{ id: "a" }, { id: "b" }], "a").startsWith("* a"));
check(
  "formatCatalogLines names the provider",
  formatCatalogLines(
    [
      { provider: "openai-codex", id: "gpt-5.4" },
      { provider: "anthropic", id: "claude-sonnet-4-5" },
    ],
    "openai-codex",
    "gpt-5.4",
  ).includes("openai-codex") &&
    formatCatalogLines(
      [
        { provider: "openai-codex", id: "gpt-5.4" },
        { provider: "anthropic", id: "claude-sonnet-4-5" },
      ],
      "openai-codex",
      "gpt-5.4",
    ).includes("*") &&
    formatCatalogLines(
      [
        { provider: "openai-codex", id: "gpt-5.4" },
        { provider: "anthropic", id: "claude-sonnet-4-5" },
      ],
      "openai-codex",
      "gpt-5.4",
    ).includes("anthropic"),
);
check("catalogFetchAllowed is false under harness", catalogFetchAllowed() === false);

const modelSrv = createServer((_req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ data: [{ id: "claude-sonnet-4-5-20250929" }, { id: "claude-haiku-4-5-20251001" }, { id: "not-a-model" }] }));
});
const modelPort = await new Promise((resolve) => {
  modelSrv.listen(0, "127.0.0.1", () => resolve(modelSrv.address().port));
});
const prevModelsUrl = process.env.TERMINA_TEST_MODELS_URL;
const prevAnth = process.env.ANTHROPIC_API_KEY;
process.env.TERMINA_TEST_MODELS_URL = `http://127.0.0.1:${modelPort}/`;
process.env.ANTHROPIC_API_KEY = "test-catalog-key";
resetAuthCache();
runLogout("anthropic");
const live = await loadProviderModels("anthropic");
check(
  "loadProviderModels uses live list when authenticated",
  live.ok === true && live.models.map((m) => m.id).join(",") === "claude-sonnet-4-5-20250929,claude-haiku-4-5-20251001",
);
if (prevModelsUrl === undefined) delete process.env.TERMINA_TEST_MODELS_URL;
else process.env.TERMINA_TEST_MODELS_URL = prevModelsUrl;
if (prevAnth === undefined) delete process.env.ANTHROPIC_API_KEY;
else process.env.ANTHROPIC_API_KEY = prevAnth;
resetAuthCache();
modelSrv.close();

runLogout("anthropic");
runLogout("xai");
modifyProvider("xai", () => ({ type: "oauth", access: "xai-access", refresh: "xai-refresh", expires: Date.now() + 60_000 }));
const prevAnth2 = process.env.ANTHROPIC_API_KEY;
process.env.ANTHROPIC_API_KEY = "env-anthropic-leftover";
resetAuthCache();
check("hasStoredCredential xai", hasStoredCredential("xai") === true);
check("hasEnvCredential anthropic", hasEnvCredential("anthropic") === true);
check("firstAuthenticatedProvider prefers stored over env", firstAuthenticatedProvider() === "xai");
runLogout("xai");
resetAuthCache();
check("firstAuthenticatedProvider falls back to env", firstAuthenticatedProvider() === "anthropic");
if (prevAnth2 === undefined) delete process.env.ANTHROPIC_API_KEY;
else process.env.ANTHROPIC_API_KEY = prevAnth2;
resetAuthCache();

const refused = await loadProviderModels("anthropic");
check("loadProviderModels without catalog url is skipped in tests", refused.ok === false);

process.env.TERMINA_TEST_MODELS_URL = "http://127.0.0.1:1/";
process.env.ANTHROPIC_API_KEY = "k";
resetAuthCache();
runLogout("anthropic");
const netFail = await loadProviderModels("anthropic");
check("loadProviderModels network failure is not a throw", netFail.ok === false && typeof netFail.error === "string");
delete process.env.TERMINA_TEST_MODELS_URL;
if (prevAnth === undefined) delete process.env.ANTHROPIC_API_KEY;
else process.env.ANTHROPIC_API_KEY = prevAnth;
resetAuthCache();

const sse = new ReadableStream({
  start(c) {
    c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hi"}}]}'));
    c.close();
  },
});
let filteredText = "";
const sseEvents = await compat.readSseJson(sse, undefined, (event) => {
  filteredText = event.choices?.[0]?.delta?.content ?? "";
  return false;
});
check("readSseJson streams and can discard events", filteredText === "Hi" && sseEvents.length === 0);

const itemDelta = compat.responsesResultFromEvents(
  [
    { type: "response.output_item.added", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "bash", arguments: "" } },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"command":"ls"}' },
  ],
  () => {},
  Date.now(),
);
check(
  "responses delta item_id attaches to call_id",
  itemDelta.blocks[0]?.type === "tool_use" && itemDelta.blocks[0]?.id === "call_1" && itemDelta.blocks[0]?.name === "bash",
);
const failedStream = compat.responsesResultFromEvents(
  [{ type: "response.failed", response: { error: { message: "quota" } } }],
  () => {},
  Date.now(),
);
check("responses failed event is an error", failedStream.error === "quota");
const bodyOpenAI = compat.completionsBody("gpt-5", "sys", [], [], "max_completion_tokens", {
  cacheKey: "abc",
  maxTokens: 16_384,
});
check(
  "openai completions uses max_completion_tokens",
  bodyOpenAI.max_completion_tokens === 16_384 && bodyOpenAI.max_tokens === undefined && bodyOpenAI.prompt_cache_key === "abc",
);
const bodyXai = compat.completionsBody("grok-4.3", "sys", [], []);
check("other completions keep max_tokens and skip cache key", bodyXai.max_tokens === 16_384 && bodyXai.prompt_cache_key === undefined);
const bodyCodex = compat.responsesBody("gpt-5.4", "sys", [], [], { cacheKey: "def", maxTokens: 24_384 });
check(
  "codex responses set cache key and max_output_tokens",
  bodyCodex.prompt_cache_key === "def" && bodyCodex.max_output_tokens === 24_384,
);

check(
  "resolveSessionFile override wins",
  resolveSessionFile("/events", "term-1", "/tmp/sess.jsonl") === "/tmp/sess.jsonl",
);
check(
  "resolveSessionFile falls back to events dir",
  resolveSessionFile("/events", "term-1") === join("/events", "term-1.session.jsonl"),
);

const mcp = await import("../agent-core/mcp.ts");
check("KERNEL_TOOL_NAMES includes fetch", mcp.KERNEL_TOOL_NAMES.has("fetch"));
check("mcpToolName prefixes server and tool", mcp.mcpToolName("github", "list_issues") === "mcp_github_list_issues");
check("mcpToolName stays within 64 chars", mcp.mcpToolName("very-long-server-name-here", "very_long_tool_name_that_exceeds").length <= 64);
check(
  "selectMcpTools prefixes kernel-like names and drops duplicates",
  mcp.selectMcpTools([{ name: "bash", description: "nope", input_schema: {}, server: "x", original: "bash" }])[0]?.name === "mcp_x_bash" &&
    mcp.selectMcpTools([
      { name: "echo", description: "echo", input_schema: {}, server: "x", original: "echo" },
      { name: "echo", description: "echo", input_schema: {}, server: "x", original: "echo" },
    ]).length === 1,
);
const manyMcpTools = Array.from({ length: 20 }, (_, i) => ({
  name: `tool_${i}`,
  description: "x".repeat(1000),
  input_schema: { type: "object", description: "y".repeat(7000) },
  server: "large",
  original: `tool_${i}`,
}));
check("MCP tool schemas have one total budget", mcp.selectMcpTools(manyMcpTools).length < manyMcpTools.length);
check(
  "parseMcpConfig skips http and disabled servers",
  mcp.parseMcpConfig({
    mcpServers: {
      gh: { command: "npx", args: ["-y", "x"] },
      web: { type: "http", url: "https://example.com" },
      off: { command: "npx", disabled: true },
    },
  }).map((s) => s.name).join(",") === "gh",
);
check(
  "parseMcpConfig keeps stdio when a url field is present",
  mcp.parseMcpConfig({
    mcpServers: { gh: { command: "npx", args: ["-y", "x"], url: "https://github.com" } },
  }).map((s) => s.name).join(",") === "gh",
);
check("jailMcpCwd rejects a parent path", mcp.jailMcpCwd("/proj", "..") === null);
check("jailMcpCwd allows a subdir", mcp.jailMcpCwd("/proj", "tools") === join("/proj", "tools"));
const mcpMerged = mcp.mergeClientTools(
  [{ name: "bash", description: "bash", input_schema: { type: "object" } }],
  [{ name: "mcp_x_echo", description: "echo", input_schema: { type: "object" } }],
);
const mcpPrefix = buildCachedPrefix("sys", mcpMerged);
check(
  "MCP tools sit in the cached client list",
  mcpPrefix.tools.some((t) => t.name === "mcp_x_echo") && mcpPrefix.tools.at(-1)?.name === "mcp_x_echo" && mcpPrefix.tools.at(-1)?.cache_control?.type === "ephemeral",
);
const mcpRequested = requestTools(mcpPrefix.tools, "anthropic");
check(
  "web_search stays last and uncached after MCP tools",
  mcpRequested.at(-1)?.name === "web_search" && mcpRequested.at(-1)?.cache_control === undefined && mcpRequested.at(-2)?.name === "mcp_x_echo",
);
const mcpDir = mkdtempSync(join(tmpdir(), "agent-core-mcp-"));
leftovers.push(mcpDir);
const mcpUser = join(mcpDir, "user.json");
const mcpProj = join(mcpDir, "proj.json");
writeFileSync(mcpUser, JSON.stringify({ mcpServers: { gh: { command: "npx" }, keep: { command: "npx" } } }));
writeFileSync(mcpProj, JSON.stringify({ mcpServers: { gh: { command: "npx", disabled: true } } }));
check(
  "MCP loads only the user-owned config",
  mcp.loadMcpConfigs(mcpUser).map((s) => s.name).join(",") === "gh,keep",
);
check("project MCP config is not an executable source", mcp.projectMcpPath === undefined);
const mcpJail = mkdtempSync(join(tmpdir(), "agent-core-mcp-jail-"));
leftovers.push(mcpJail);
try {
  symlinkSync("/tmp", join(mcpJail, "out"));
  check("jailMcpCwd rejects a symlink out of the project", mcp.jailMcpCwd(mcpJail, "out") === null);
} catch (err) {
  check("jailMcpCwd rejects a symlink out of the project", false, err instanceof Error ? err.message : String(err));
}
const echoServer = join(mcpDir, "echo-mcp.mjs");
writeFileSync(
  echoServer,
  `process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let n;
  while ((n = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, n);
    buf = buf.slice(n + 1);
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "echo" } } }) + "\\n");
    } else if (msg.method === "tools/list") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo", description: "echo text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] } }) + "\\n");
    } else if (msg.method === "tools/call") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: String(msg.params?.arguments?.text ?? "") }] } }) + "\\n");
    }
  }
});
`,
);
const liveMcp = await mcp.startMcp(
  [{ name: "echo", command: process.execPath, args: [echoServer], env: {} }],
  { projectRoot: mcpDir, confineCwd: (cwd) => mcp.jailMcpCwd(mcpDir, cwd) },
);
check("mcp handshake lists the echo tool", liveMcp.tools[0]?.name === "mcp_echo_echo" && liveMcp.notes.length === 0);
const echoed = await liveMcp.call("mcp_echo_echo", { text: "hello-mcp" });
check("mcp tools/call round-trips", echoed.isError === false && echoed.content === "hello-mcp");
liveMcp.shutdown();
const hangServer = join(mcpDir, "hang-mcp.mjs");
writeFileSync(
  hangServer,
  `process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let n;
  while ((n = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, n);
    buf = buf.slice(n + 1);
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "hang" } } }) + "\\n");
    } else if (msg.method === "tools/list") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "hang", description: "hang", inputSchema: { type: "object" } }] } }) + "\\n");
    }
  }
});
`,
);
const hangMcp = await mcp.startMcp(
  [{ name: "hang", command: process.execPath, args: [hangServer], env: {} }],
  { projectRoot: mcpDir, confineCwd: (cwd) => mcp.jailMcpCwd(mcpDir, cwd) },
);
const tHang = Date.now();
const interruptedCall = await hangMcp.call("mcp_hang_hang", {}, { shouldStop: () => true });
check("mcp interrupt returns quickly", Date.now() - tHang < 2000 && interruptedCall.isError === true && interruptedCall.content.includes("interrupted"));
const afterInterrupt = await hangMcp.call("mcp_hang_hang", {});
check("mcp interrupt kills the server", afterInterrupt.isError === true);
hangMcp.shutdown();
const timeoutMcp = await mcp.startMcp(
  [{ name: "hang", command: process.execPath, args: [hangServer], env: {} }],
  { projectRoot: mcpDir, confineCwd: (cwd) => mcp.jailMcpCwd(mcpDir, cwd) },
);
const timed = await timeoutMcp.call("mcp_hang_hang", {}, { timeoutMs: 200, shouldStop: () => false });
check("mcp call timeout kills the server", timed.isError === true && timed.content.includes("timed out"));
const afterKill = await timeoutMcp.call("mcp_hang_hang", {});
check("mcp call after timeout sees a dead server", afterKill.isError === true);
timeoutMcp.shutdown();
const deadMcp = await mcp.startMcp(
  [{ name: "gone", command: join(mcpDir, "missing-bin"), args: [], env: {} }],
  { projectRoot: mcpDir, confineCwd: (cwd) => mcp.jailMcpCwd(mcpDir, cwd) },
);
check("mcp spawn failure does not throw", deadMcp.tools.length === 0 && deadMcp.notes.some((n) => n.includes("gone")));
deadMcp.shutdown();
writeFileSync(join(mcpDir, "bad.json"), "{not json");
check("invalid mcp json loads as no servers", mcp.parseMcpConfig(null).length === 0 && mcp.loadMcpConfigs(join(mcpDir, "bad.json")).length === 0);

const rosterMod = await import("../electron/terminal-roster.ts");
check("parseTerminalRoster empty", rosterMod.parseTerminalRoster(null).length === 0);
check(
  "parseTerminalRoster keeps engine and session",
  rosterMod.parseTerminalRoster({
    terminals: [{ id: "term-2", type: "agent", engine: "core", sessionId: "core-abc", sessionFile: "/tmp/core-abc.jsonl" }],
  })[0]?.engine === "core" &&
    rosterMod.parseTerminalRoster({
      terminals: [{ id: "term-2", type: "agent", engine: "core", sessionId: "core-abc", sessionFile: "/tmp/core-abc.jsonl" }],
    })[0]?.sessionId === "core-abc",
);
check("parseTerminalRoster drops dispatch-like ids", rosterMod.parseTerminalRoster([{ id: "job-1", type: "agent", engine: "pi" }]).length === 0);
check("parseTerminalRoster defaults agent engine to pi", rosterMod.parseTerminalRoster([{ id: "term-1", type: "agent" }])[0]?.engine === "pi");
check(
  "parseTerminalRoster drops relative sessionFile",
  rosterMod.parseTerminalRoster([{ id: "term-1", type: "agent", engine: "core", sessionFile: "agent-sessions/x.jsonl" }])[0]?.sessionFile == null,
);
check(
  "parseTerminalRoster drops duplicate ids",
  rosterMod.parseTerminalRoster([
    { id: "term-1", type: "agent", engine: "core" },
    { id: "term-1", type: "agent", engine: "pi" },
  ]).length === 1,
);
check(
  "parseTerminalRoster drops sessionId with slash",
  rosterMod.parseTerminalRoster([{ id: "term-1", type: "agent", sessionId: "a/b" }])[0]?.sessionId == null,
);
check("isCoreSessionId rejects parent segment", rosterMod.isCoreSessionId("..") === false);
check("isCoreSessionId accepts uuid form", rosterMod.isCoreSessionId("core-11111111-1111-1111-1111-111111111111") === true);
const liveRoster = [{ id: "term-3", type: "agent", engine: "core" }];
const unrestoredRoster = [
  { id: "term-1", type: "agent", engine: "pi" },
  { id: "term-3", type: "agent", engine: "pi" },
];
const composed = rosterMod.composeTerminalRoster(liveRoster, unrestoredRoster);
check("composeTerminalRoster prefers live id", composed[0]?.id === "term-3" && composed[0]?.engine === "core");
check("composeTerminalRoster keeps unrestored sibling", composed[1]?.id === "term-1" && composed.length === 2);
const manyLive = Array.from({ length: 20 }, (_, i) => ({ id: `term-${i + 1}`, type: "agent", engine: "pi" }));
check("composeTerminalRoster caps at 16", rosterMod.composeTerminalRoster(manyLive, []).length === rosterMod.MAX_TERMINAL_ROSTER);

const qdir = mkdtempSync(join(tmpdir(), "agent-core-quarantine-"));
leftovers.push(qdir);
const qfile = join(qdir, "sess.jsonl");
writeFileSync(qfile, '{"storageSeq":1}\n');
check("quarantineSessionFile moves a file aside", quarantineSessionFile(qfile) === true && !existsSync(qfile) && existsSync(`${qfile}.bad`));
writeFileSync(qfile, "second\n");
check("quarantineSessionFile does not overwrite an existing aside file", quarantineSessionFile(qfile) === true && existsSync(`${qfile}.bad`) && readFileSync(`${qfile}.bad`, "utf8") === '{"storageSeq":1}\n');
check("MAX_SESSION_FILE_BYTES is 32 MiB", MAX_SESSION_FILE_BYTES === 32 * 1024 * 1024);

const sliceSrc = [
  JSON.stringify({ storageSeq: 1, type: "message", message: { role: "user", content: "u1" } }),
  JSON.stringify({ storageSeq: 2, type: "message", message: { role: "assistant", content: "a1" } }),
  JSON.stringify({ storageSeq: 3, type: "revision", kind: "prune", targets: [] }),
  JSON.stringify({ storageSeq: 4, type: "message", message: { role: "user", content: "u2" } }),
].join("\n") + "\n";
const slice2 = sliceSessionText(sliceSrc, 2);
check("slice keeps prefix messages", slice2.ok && slice2.kept === 2 && slice2.text.includes("\"u1\"") && !slice2.text.includes("\"u2\""));
const slice3 = sliceSessionText(sliceSrc, 3);
check("slice keeps revision records in the prefix", slice3.ok && slice3.kept === 3 && slice3.text.includes("\"prune\""));
check("slice through 0 is empty", sliceSessionText(sliceSrc, 0).ok && sliceSessionText(sliceSrc, 0).text === "");
check("slice rejects negative seq", sliceSessionText(sliceSrc, -1).ok === false);
const dupSlice = sliceSessionText(
  JSON.stringify({ storageSeq: 1, type: "message", message: { role: "user", content: "a" } }) +
    "\n" +
    JSON.stringify({ storageSeq: 1, type: "message", message: { role: "user", content: "b" } }) +
    "\n",
  1,
);
check("slice fails closed on duplicate storageSeq", dupSlice.ok === false);
const truncSlice = sliceSessionText(sliceSrc + "{not json", 4);
check("slice ignores a truncated final line", truncSlice.ok && truncSlice.kept === 4);
const forkDir = mkdtempSync(join(tmpdir(), "agent-core-fork-"));
leftovers.push(forkDir);
const forkSrc = join(forkDir, "src.jsonl");
const forkDst = join(forkDir, "out", "dst.jsonl");
writeFileSync(forkSrc, sliceSrc);
const writtenFork = await writeForkedSession(forkSrc, forkDst, 2);
check("writeForkedSession writes the sliced prefix", writtenFork.ok && existsSync(forkDst) && readFileSync(forkDst, "utf8").includes("\"a1\"") && !readFileSync(forkDst, "utf8").includes("\"u2\""));
const emptyFork = await writeForkedSession(forkSrc, join(forkDir, "empty.jsonl"), 0);
check("writeForkedSession through 0 writes an empty file", emptyFork.ok && readFileSync(join(forkDir, "empty.jsonl"), "utf8") === "");
writeFileSync(join(forkDir, "src-img-1.png"), png1x1);
writeFileSync(join(forkDir, "other-img-1.png"), png1x1);
const forkImgDst = join(forkDir, "out-img", "dst.jsonl");
await writeForkedSession(forkSrc, forkImgDst, 2);
check("writeForkedSession copies sidecar images", existsSync(join(forkDir, "out-img", "src-img-1.png")));
check("writeForkedSession does not copy a sibling session's images", !existsSync(join(forkDir, "out-img", "other-img-1.png")));
const copyOnlyDir = join(forkDir, "copy-only");
mkdirSync(copyOnlyDir);
await copySessionImageFiles(forkSrc, join(copyOnlyDir, "session.jsonl"));
check("copySessionImageFiles copies without rewriting jsonl", existsSync(join(copyOnlyDir, "src-img-1.png")));
check("copySessionImageFiles keeps the source stem", !existsSync(join(copyOnlyDir, "other-img-1.png")));

const rotDir = mkdtempSync(join(tmpdir(), "agent-core-rotate-"));
leftovers.push(rotDir);
const rotLive = join(rotDir, "core-aaaa.jsonl");
check("rotateSessionFile skips a missing file", rotateSessionFile(rotLive).ok && rotateSessionFile(rotLive).aside === null);
writeFileSync(rotLive, "");
check("rotateSessionFile skips an empty file", rotateSessionFile(rotLive).ok && rotateSessionFile(rotLive).aside === null && existsSync(rotLive));
writeFileSync(rotLive, JSON.stringify({ storageSeq: 1, type: "message", message: { role: "user", content: "keep me" } }) + "\n");
const rotFixed = new Date(2026, 7, 26, 15, 4, 5).getTime();
const rotated = rotateSessionFile(rotLive, rotFixed);
check("sessionRotateStamp is filesystem-safe", sessionRotateStamp(rotFixed) === "2026-08-26T15-04-05");
check(
  "rotateSessionFile moves a non-empty session aside",
  rotated.ok &&
    rotated.aside === join(rotDir, "core-aaaa-2026-08-26T15-04-05.jsonl") &&
    !existsSync(rotLive) &&
    existsSync(rotated.aside) &&
    readFileSync(rotated.aside, "utf8").includes("keep me"),
);
writeFileSync(rotLive, JSON.stringify({ storageSeq: 1, type: "message", message: { role: "user", content: "newer" } }) + "\n");
const rotatedAgain = rotateSessionFile(rotLive, rotFixed);
check(
  "rotateSessionFile does not overwrite an existing aside file",
  rotatedAgain.ok &&
    rotatedAgain.aside === join(rotDir, "core-aaaa-2026-08-26T15-04-05-1.jsonl") &&
    readFileSync(rotated.aside, "utf8").includes("keep me") &&
    existsSync(rotatedAgain.aside) &&
    readFileSync(rotatedAgain.aside, "utf8").includes("newer"),
);

const searchMod = await import("../electron/session-search.ts");
const piLine = JSON.stringify({
  type: "message",
  message: {
    role: "assistant",
    content: [
      { type: "text", text: "created compute in `utils.ts`" },
      { type: "toolCall", name: "write", arguments: { path: "utils.ts" } },
    ],
  },
});
const coreLine = JSON.stringify({
  storageSeq: 2,
  type: "message",
  message: {
    role: "assistant",
    content: [
      { type: "text", text: "edited greeting" },
      { type: "thinking", text: "secret" },
      { type: "tool_use", id: "1", name: "edit", input: { path: "greeting.ts", old_text: "a", new_text: "b" } },
    ],
  },
});
const usageLine = JSON.stringify({ storageSeq: 3, type: "usage", input: 1 });
const piParsed = searchMod.parseSessionMessageLine(piLine);
const coreParsed = searchMod.parseSessionMessageLine(coreLine);
check("parse Pi toolCall extracts the path", piParsed?.role === "assistant" && piParsed.text.includes("compute") && piParsed.paths.includes("utils.ts"));
check(
  "parse core tool_use extracts the path and skips thinking",
  coreParsed?.role === "assistant" &&
    coreParsed.text.includes("edited greeting") &&
    coreParsed.text.includes("[edit]") &&
    !coreParsed.text.includes("secret") &&
    coreParsed.paths.includes("greeting.ts"),
);
check("parse skips usage records", searchMod.parseSessionMessageLine(usageLine) === null);
const toolResultLine = JSON.stringify({
  storageSeq: 4,
  type: "message",
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "1", content: [{ type: "text", text: "compute output" }] }],
  },
});
check(
  "parse core tool_result arrays",
  searchMod.parseSessionMessageLine(toolResultLine)?.text.includes("compute output") === true,
);
check("sessionTimestampFromName reads a rotate suffix", searchMod.sessionTimestampFromName("core-aaaa-2026-08-26T15-04-05.jsonl") === rotFixed);
const merged = searchMod.mergeSessionFiles([
  [
    { path: "/s/a.jsonl", name: "a.jsonl", mtimeMs: 10 },
    { path: "/s/b.jsonl", name: "b.jsonl", mtimeMs: 20 },
  ],
  [{ path: "/s/a.jsonl", name: "a.jsonl", mtimeMs: 10 }],
]);
check("mergeSessionFiles drops duplicate paths and sorts newest first", merged.length === 2 && merged[0]?.path === "/s/b.jsonl");

const searchDir = mkdtempSync(join(tmpdir(), "agent-core-search-"));
leftovers.push(searchDir);
writeFileSync(join(searchDir, "utils.ts"), "export function compute() {}\n");
writeFileSync(join(searchDir, "greeting.ts"), "export const greeting = 'hi';\n");
const coreJsonl = join(searchDir, "core-bbbb.jsonl");
writeFileSync(
  coreJsonl,
  [
    JSON.stringify({ storageSeq: 1, type: "message", message: { role: "user", content: "add compute" } }),
    coreLine,
  ].join("\n") + "\n",
);
const searchHits = await searchMod.searchSessionFiles({
  query: "compute",
  files: [{ path: coreJsonl, name: "core-bbbb.jsonl", mtimeMs: 1 }],
  projectCwd: searchDir,
  canonicalize: (p) => p,
  isProjectFile: (rel) => rel === "utils.ts" || rel === "greeting.ts",
});
check("search finds a core user line", searchHits.some((h) => h.text.includes("add compute") && h.sessionFile === "core-bbbb.jsonl"));
const greetingHits = await searchMod.searchSessionFiles({
  query: "greeting",
  files: [{ path: coreJsonl, name: "core-bbbb.jsonl", mtimeMs: 1 }],
  projectCwd: searchDir,
  canonicalize: (p) => p,
  isProjectFile: (rel) => rel === "utils.ts" || rel === "greeting.ts",
});
check("search resolves a core edit path", greetingHits.some((h) => h.filePath === "greeting.ts"));
check("slash menu puts help first", SLASH_COMMANDS[0]?.name === "/help");
check("slash menu puts exit last", SLASH_COMMANDS.at(-1)?.name === "/exit");
check("slash /clear is listed", SLASH_COMMANDS.some((c) => c.name === "/clear"));
check("slash /compact is listed", SLASH_COMMANDS.some((c) => c.name === "/compact"));
check("slash /thinking is listed", SLASH_COMMANDS.some((c) => c.name === "/thinking"));
check(
  "slash /thinking lists off first",
  matchingSlashCommands("/thinking")[0]?.submit === "/thinking off" &&
    matchingSlashCommands("/thinking").some((c) => c.submit === "/thinking on"),
);
check("slash /thinking o matches off", matchingSlashCommands("/thinking o")[0]?.submit === "/thinking off");
check("parseThinkingCommand missing is null", parseThinkingCommand("/model") === null);
check("parseThinkingCommand bare shows", parseThinkingCommand("/thinking")?.show === true);
check("parseThinkingCommand on", parseThinkingCommand("/thinking on")?.enabled === true);
check("parseThinkingCommand off", parseThinkingCommand("/thinking off")?.enabled === false);
check("parseThinkingCommand rejects junk", typeof parseThinkingCommand("/thinking maybe")?.error === "string");
check("thinkingEnabledFor default off", thinkingEnabledFor("claude-sonnet-5", false) === false);
check("thinkingEnabledFor sonnet on", thinkingEnabledFor("claude-sonnet-5", true) === true);
check("thinkingEnabledFor haiku stays off", thinkingEnabledFor("claude-haiku-4-5", true) === false);
check("thinkingEnabledFor gpt stays off", thinkingEnabledFor("gpt-5.6-sol", true) === false);
check("thinkingEnabledFor fable stays on", thinkingEnabledFor("claude-fable-5", false) === true);
check("outputTokenBudget off is output cap", outputTokenBudget({ thinking: false }) === 16_384);
check("outputTokenBudget on is a single cap", outputTokenBudget({ thinking: true }) === 32_768);
check(
  "thinkingRequestFor sonnet 5 off is disabled",
  JSON.stringify(thinkingRequestFor("claude-sonnet-5", false)) === JSON.stringify({ type: "disabled" }),
);
check(
  "thinkingRequestFor sonnet 5 on is adaptive",
  JSON.stringify(thinkingRequestFor("claude-sonnet-5", true)) ===
    JSON.stringify({ type: "adaptive", display: "summarized" }),
);
check(
  "thinkingRequestFor sonnet 4.6 on is adaptive",
  JSON.stringify(thinkingRequestFor("claude-sonnet-4-6", true)) ===
    JSON.stringify({ type: "adaptive", display: "summarized" }),
);
check(
  "thinkingRequestFor sonnet 4.5 on is budget",
  JSON.stringify(thinkingRequestFor("claude-sonnet-4-5", true)) ===
    JSON.stringify({ type: "enabled", budget_tokens: 16_384 }),
);
check("thinkingRequestFor sonnet 4.5 off is omitted", thinkingRequestFor("claude-sonnet-4-5", false) === undefined);
check("thinkingRequestFor haiku is omitted", thinkingRequestFor("claude-haiku-4-5", true) === undefined);
check("thinkingRequestFor gpt is omitted", thinkingRequestFor("gpt-5.6-sol", true) === undefined);
check(
  "thinkingRequestFor fable off stays adaptive",
  JSON.stringify(thinkingRequestFor("claude-fable-5", false)) ===
    JSON.stringify({ type: "adaptive", display: "summarized" }),
);

const cacheMsgs = [
  { role: "user", content: "hi" },
  { role: "assistant", content: [{ type: "tool_use", id: "1", name: "read_file", input: {} }] },
  {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "1", content: "one" },
      { type: "tool_result", tool_use_id: "2", content: "two" },
    ],
  },
];
const stamped = stampHistoryCache(cacheMsgs);
check("stampHistoryCache does not mutate input", cacheMsgs[2].content[1].cache_control === undefined);
check(
  "stampHistoryCache marks last tool_result only",
  stamped[2].content[1].cache_control?.type === "ephemeral" && stamped[2].content[0].cache_control === undefined,
);
check("stampHistoryCache leaves earlier messages", stamped[0] === cacheMsgs[0]);
const converted = compat.toCompletionsMessages("sys", stamped);
check(
  "openai conversion drops cache_control",
  converted.every((m) => !("cache_control" in m) && (typeof m.content === "string" || m.content == null || !JSON.stringify(m).includes("cache_control"))),
);
check("stampHistoryCache no-ops without tool_result", stampHistoryCache([{ role: "user", content: "hi" }])[0].content === "hi");
check("formatOverlay omits empty", formatOverlay({ messages: [] }) === "");
const overlayMsgs = [
  { role: "assistant", content: [{ type: "tool_use", name: "edit", input: { path: "a.ts" } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "ok" }] },
];
const overlay = formatOverlay({ messages: overlayMsgs, hostContext: "verify failed" });
check("formatOverlay includes edit path", overlay.includes("a.ts") && overlay.includes("<modified-files>"));
check("formatOverlay includes host context", overlay.includes("verify failed") && overlay.startsWith("<working-set>"));
check("formatOverlay does not invent a stored user message", overlayMsgs.every((m) => m.role !== "user" || Array.isArray(m.content)));
const manyReads = {
  role: "assistant",
  content: Array.from({ length: 41 }, (_, i) => ({ type: "tool_use", name: "read_file", input: { path: `f${i}.ts` } })),
};
check("formatOverlay caps inventories", formatOverlay({ messages: [manyReads] }).includes("<!-- 1 paths omitted -->"));
const stampedThenOverlay = [
  ...stampHistoryCache(overlayMsgs),
  { role: "user", content: overlay },
];
check(
  "overlay sits after stamped tool_result",
  stampedThenOverlay.at(-1)?.content === overlay &&
    stampedThenOverlay.at(-2)?.content?.[0]?.cache_control?.type === "ephemeral",
);
const hdr = (v) => ({ get: (name) => (name.toLowerCase() === "retry-after" ? v : null) });
check("retryAfter 400 is null", retryAfter(400, hdr(null), 0) === null);
check("retryAfter 429 first wait 1s", retryAfter(429, hdr(null), 0) === 1_000);
check("retryAfter 429 second wait 2s", retryAfter(429, hdr(null), 1) === 2_000);
check("retryAfter 429 third is null", retryAfter(429, hdr(null), 2) === null);
check("retryAfter honors small Retry-After", retryAfter(503, hdr("3"), 0) === 3_000);
check("retryAfter ignores large Retry-After", retryAfter(429, hdr("120"), 0) === 1_000);
check("retryAfter ignores http-date", retryAfter(429, hdr("Wed, 21 Oct 2015 07:28:00 GMT"), 0) === 1_000);
check("retryAfter 529 retries", retryAfter(529, hdr(null), 0) === 1_000);
check("parsePrintPrompt missing is null", parsePrintPrompt(["node", "agent-core.mjs"]) === null);
check("parsePrintPrompt -p joins the rest", parsePrintPrompt(["node", "x", "-p", "fix", "the", "bug"]) === "fix the bug");
check("parsePrintPrompt --print empty is empty", parsePrintPrompt(["node", "--print"]) === "");
check(
  "slash / lists every command",
  matchingSlashCommands("/").map((c) => c.name).join(" ") === SLASH_COMMANDS.map((c) => c.name).join(" "),
);
check(
  "slash /m is model and models",
  matchingSlashCommands("/m").map((c) => c.name).join(" ") === "/model /models",
);
check("slash /models is exact", matchingSlashCommands("/models").map((c) => c.name).join(" ") === "/models");
check("slash hides after a space", matchingSlashCommands("/help ").length === 0);
check(
  "slash /login lists OpenAI and OpenAI (key)",
  matchingSlashCommands("/login").some((c) => c.name === "OpenAI" && c.submit === "/login openai oauth") &&
    matchingSlashCommands("/login").some((c) => c.name === "OpenAI (key)" && c.submit === "/login openai key") &&
    matchingSlashCommands("/login").some((c) => c.name === "Anthropic" && c.submit === "/login anthropic oauth") &&
    matchingSlashCommands("/login").some((c) => c.name === "Anthropic (key)" && c.submit === "/login anthropic key") &&
    matchingSlashCommands("/login").some((c) => c.name === "GitHub Copilot" && c.submit === "/login github-copilot oauth") &&
    matchingSlashCommands("/login").some((c) => c.name === "xAI" && c.submit === "/login xai oauth") &&
    matchingSlashCommands("/login").some((c) => c.name === "xAI (key)" && c.submit === "/login xai key") &&
    matchingSlashCommands("/login").some((c) => c.name === "Google Gemini (key)" && c.submit === "/login google key") &&
    !matchingSlashCommands("/login").some((c) => c.name.startsWith("/login ")),
);
check(
  "slash /login openai lists both modes",
  matchingSlashCommands("/login openai").map((c) => c.name).join(" ") === "OpenAI OpenAI (key)",
);
check(
  "slash /login key lists API key rows",
  matchingSlashCommands("/login key").length > 0 &&
    matchingSlashCommands("/login key").every((c) => c.name.endsWith(" (key)")) &&
    matchingSlashCommands("/login key").some((c) => c.name === "OpenAI (key)"),
);
check(
  "slash /login oauth lists OAuth rows",
  matchingSlashCommands("/login oauth").every((c) => !c.name.endsWith(" (key)")) &&
    matchingSlashCommands("/login oauth").some((c) => c.name === "OpenAI") &&
    !matchingSlashCommands("/login oauth").some((c) => c.name === "Google Gemini (key)"),
);
check(
  "slash /login a is Anthropic only",
  matchingSlashCommands("/login a").map((c) => c.name).join(" ") === "Anthropic Anthropic (key)",
);
check(
  "slash /login gemini is Google Gemini (key)",
  matchingSlashCommands("/login gemini").map((c) => c.name).join(" ") === "Google Gemini (key)",
);
check("slash Tab /login completes to /login ", completeSlashLine("/login") === "/login ");
check(
  "slash /models lists provider-prefixed ids",
  matchingSlashCommands("/models", SLASH_COMMANDS, [
    { name: "openai-codex/gpt-5.4", hint: "openai-codex", submit: "/model openai-codex/gpt-5.4" },
    { name: "anthropic/claude-sonnet-4-5", hint: "anthropic", submit: "/model anthropic/claude-sonnet-4-5" },
  ]).map((c) => c.name).join(" ") === "openai-codex/gpt-5.4 anthropic/claude-sonnet-4-5",
);
check(
  "slash /models a is Anthropic only",
  matchingSlashCommands("/models a", SLASH_COMMANDS, [
    { name: "openai-codex/gpt-5.4", hint: "openai-codex", submit: "/model openai-codex/gpt-5.4" },
    { name: "anthropic/claude-sonnet-4-5", hint: "anthropic", submit: "/model anthropic/claude-sonnet-4-5" },
  ]).map((c) => c.name).join(" ") === "anthropic/claude-sonnet-4-5",
);
check(
  "slash /models refresh is not a model row",
  matchingSlashCommands("/models refresh", SLASH_COMMANDS, [
    { name: "openai-codex/gpt-5.4", hint: "openai-codex", submit: "/model openai-codex/gpt-5.4" },
  ]).length === 0,
);
check("slash Tab unique picker does not expand", completeSlashLine("/login google") === "/login google");
check("slash ignores prompts", matchingSlashCommands("hello").length === 0);
check("slash Tab /m completes to /model", completeSlashLine("/m") === "/model");
check("slash Tab /ex completes to /exit", completeSlashLine("/ex") === "/exit");
check("slash Tab /foo is unchanged", completeSlashLine("/foo") === "/foo");

const tuiMod = await import("../agent-core/tui.ts");
check("wrapText splits on width", tuiMod.wrapText("abcdef", 3).join("|") === "abc|def");
check("wrapText keeps newlines", tuiMod.wrapText("ab\ncd", 10).join("|") === "ab|cd");
check("wrapText counts a code point as one cell", tuiMod.wrapText("👍👍", 1).join("|") === "👍|👍");
check(
  "layoutHeights keeps a transcript",
  tuiMod.layoutHeights(24, 1, 7).transcript >= 2 && tuiMod.layoutHeights(24, 1, 7).header === 1,
);
check("layoutHeights fits a tiny screen", tuiMod.layoutHeights(5, 1, 7).transcript >= 1 && tuiMod.layoutHeights(5, 1, 7).slash < 7);
const visSrc = Array.from({ length: 80 }, (_, i) => `L${String(i).padStart(2, "0")}`).join("\n") + "\n";
const vis = tuiMod.visibleLines(visSrc, 10, 3, 0);
check("visibleLines is the tail", vis.join("|").includes("L79") && !vis.join("|").includes("L00"));
const submitted = [];
const exits = [];
const tui = new tuiMod.AgentTui({
  stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
  stdin: { isTTY: false },
  onSubmit: (line) => submitted.push(line),
  onInterrupt: () => {},
  onExit: () => exits.push(true),
});
tui.setStatus({ model: "anthropic/claude", auth: "oauth" });
tui.append("hello from transcript\n");
const frame = tui.frame();
check("tui header names the kernel", frame.includes("termina agent-core v1"));
check("tui header shows the model", frame.includes("anthropic/claude"));
const imgTui = new tuiMod.AgentTui({
  stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
  stdin: { isTTY: false },
  pendingImages: () => 2,
  onSubmit: () => {},
  onInterrupt: () => {},
  onExit: () => {},
});
imgTui.append("x");
check("tui header shows pending images", imgTui.frame().includes("2 images"));
check("tui transcript is visible", frame.includes("hello from transcript"));
tui.feed("/");
check("tui slash menu lists help and exit", tui.frame().includes("/help") && tui.frame().includes("/exit"));
tui.feed("\r");
check("tui enter on / submits help", submitted[0] === "/help");
const loginPicks = [];
const loginTui = new tuiMod.AgentTui({
  stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
  stdin: { isTTY: false },
  onSubmit: (line) => loginPicks.push(line),
  onInterrupt: () => {},
  onExit: () => {},
});
loginTui.feed("/login");
check(
  "tui /login shows OpenAI and OpenAI (key)",
  loginTui.frame().includes("OpenAI (key)") && loginTui.frame().includes("Anthropic") && !loginTui.frame().includes("/login openai oauth"),
);
loginTui.feed("\x1b[B\x1b[B\r");
check("tui enter on highlighted OpenAI", loginPicks[0] === "/login openai oauth");
check(
  "tui login echo uses the picker label",
  loginTui.frame().includes("> OpenAI") && !loginTui.frame().includes("> /login openai oauth"),
);
loginTui.feed("/login openai key\r");
check("tui enter on /login openai key", loginPicks[1] === "/login openai key");
loginTui.feed("/login openai oauth\r");
check("tui enter on /login openai oauth", loginPicks[2] === "/login openai oauth");
const loginFromSlash = [];
const slashLoginTui = new tuiMod.AgentTui({
  stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
  stdin: { isTTY: false },
  onSubmit: (line) => loginFromSlash.push(line),
  onInterrupt: () => {},
  onExit: () => {},
});
slashLoginTui.feed("/");
slashLoginTui.feed("\x1b[B\r");
check(
  "tui enter on /login command opens picker",
  loginFromSlash.length === 0 && slashLoginTui.frame().includes("OpenAI (key)"),
);
tui.feed("/exit\r");
check("tui /exit hits onExit", exits[0] === true);
tui.setRawInput(true);
tui.feed("/\r");
check("raw input does not expand slash", submitted.at(-1) === "/");
tui.feed("/login\r");
check("raw input submits /login as a line", submitted.at(-1) === "/login");
tui.setRawInput(false);
const histLines = [];
const histTui = new tuiMod.AgentTui({
  stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
  stdin: { isTTY: false },
  onSubmit: (line) => histLines.push(line),
  onInterrupt: () => {},
  onExit: () => {},
});
histTui.feed("hello\r");
histTui.feed("/login openai oauth\r");
histTui.feed("\x1b[A\x1b[A\r");
check("tui history up past a login command", histLines.at(-1) === "hello");
tui.append("\x1b[31mred-text\x1b[0m");
check("tui strips ansi from transcript", tui.frame().includes("red-text") && !tui.frame().includes("\x1b[31m"));
const pasteLines = [];
const pasteTui = new tuiMod.AgentTui({
  stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
  stdin: { isTTY: false },
  onSubmit: (line) => pasteLines.push(line),
  onInterrupt: () => {},
  onExit: () => {},
});
pasteTui.feed("\x1b[200~hello\nworld\x1b[201~\r");
check("paste keeps newlines", pasteLines[0] === "hello\nworld");
const nlLines = [];
const nlTui = new tuiMod.AgentTui({
  stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
  stdin: { isTTY: false },
  onSubmit: (line) => nlLines.push(line),
  onInterrupt: () => {},
  onExit: () => {},
});
nlTui.feed("ab\ncd\r");
check("ctrl-j inserts a newline", nlLines[0] === "ab\ncd");
const killLines = [];
const killTui = new tuiMod.AgentTui({
  stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
  stdin: { isTTY: false },
  onSubmit: (line) => killLines.push(line),
  onInterrupt: () => {},
  onExit: () => {},
});
killTui.feed("one two\x17\r");
check("ctrl-w kills the last word", killLines[0] === "one");
const draftLines = [];
const draftTui = new tuiMod.AgentTui({
  stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
  stdin: { isTTY: false },
  onSubmit: (line) => draftLines.push(line),
  onInterrupt: () => {},
  onExit: () => {},
});
draftTui.setDraft("prefill text");
check("setDraft shows in the frame", draftTui.frame().includes("prefill text"));
draftTui.feed("\r");
check("setDraft submits", draftLines[0] === "prefill text");
const tuiFail = new tuiMod.AgentTui({
  stdout: { write: () => true, columns: 80, rows: 24 },
  stdin: { isTTY: true, setRawMode: () => { throw new Error("no raw"); } },
  onSubmit: () => {},
  onInterrupt: () => {},
  onExit: () => {},
});
check("tui start fails closed", tuiFail.start() === false && tuiFail.active() === false);

const failed = results.filter((r) => !r).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
